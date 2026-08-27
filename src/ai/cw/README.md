# Commander Wars' NormalAi, ported

A TypeScript transcription of the C++ opponent that ships with Commander Wars
(`ext/Commander_Wars/ai/`), running against iron-accord's host objects.

## Why port rather than run it

Everywhere else in this project we run Commander Wars' own code unmodified, and
that is the whole point of the host. The AI is the exception: it is C++, not
JavaScript, and it holds raw pointers into `GameMap` / `Unit` / `Building`. There
is no script boundary to intercept. Compiling it to WASM would mean compiling the
Qt engine behind those pointers, at which point iron-accord's engine is no longer
the thing being played. So this is a port, and a port can drift from its source.
Every file here names the C++ function it came from so drift stays checkable.

`ai/proxyai.cpp` is not an escape hatch -- it is the network-play relay that
replays a remote human's actions, not a JavaScript AI.

## Why bother at all

Two payoffs, and the second is the one the evidence actually supports.

1. **A benchmark opponent.** Our agents have only ever been measured against
   each other and against a greedy baseline, so "0.867 vs greedy" has no outside
   referent. NormalAi is a fixed, externally-authored standard.

2. **A different data distribution.** Expert iteration failed here (see
   `docs/handoff-value-net.md`): strength fell monotonically with the share of
   planner-generated data, because planner self-play converges and narrows the
   position distribution. Three separate experiments have now said the same
   thing -- breadth beats volume, counterfactuals beat determinism, diversity
   beats play quality. NormalAi plays a genuinely different style from our
   heuristic, and `randomizeConfig` turns it into a whole family of styles. That
   is a breadth lever, which is the kind that has worked.

## What is deliberately left out

- **COs.** They are absent from iron-accord by design, so `useCOPower` and
  `buildCOUnit` are inert and `Player.getMaxCoCount()` returns 0. The branches
  are kept rather than deleted so the ported control flow still reads 1:1
  against the C++.
- **Oozium, flares, black bombs.** Black Hole / CO-campaign units our maps do
  not carry. Stubbed to no-ops; if a map ever fields one, the AI ignores it
  rather than misplaying it.
- **`UnitPathFindingSystem`.** We already have a faster bucket-queue Dijkstra in
  `src/game/pathfinding.ts`. Ported call sites go through that instead.

## Layout

| file | source |
|---|---|
| `config.ts` | generated from `ai/normalai.cpp`'s `m_iniData` + `resources/aidata/normal/normal.ini` |
| `ini.ts` | `CoreAI::randomizeIni` |
| `islandmap.ts` | `ai/islandmap.cpp` |
| `influencefrontmap.ts` | `ai/influencefrontmap.cpp`, minus the front lines |

Regenerate the config after updating `ext/` with:

    python3 tools/gen_cw_ai_config.py

## Two upstream quirks the generator preserves

`readIni` walks the tunable table in declaration order and writes through each
entry's pointer, so when two keys name the same field the later wins. Upstream
declares `LowDirectUnitBonus` against `&m_highIndirectMalus`, so the .ini's
`LowDirectUnitBonus=37.67` silently overwrites `HighIndirectMalus=38`. That is a
pointer mix-up rather than a design, but the shipping game plays on the result,
so the port keeps it and the generator reports it.

Qt writes a user settings group named `General` as `[%General]` on disk, because
QSettings reserves the plain `General` section for ungrouped keys. Reading the
literal name finds nothing, which would have silently dropped 15 of the 126
knobs -- `DirectIndirectRatio` and `MinMovementDamage` among them.

## Landmines carried over deliberately

`NormalAi::getMapInfluenceModifier` divides by `ownInfluence` on a branch that
only guards `enemyInfluence > 0`, so a tile where the AI has no influence at all
yields infinity, and that infinity is added straight to a counter-damage score.
This is reachable: `increaseInfluence` takes a `qint32`, so a fractional
contribution truncates to zero on tiles far from anything the AI owns.

JavaScript numbers are IEEE doubles like the C++ floats, so a literal
transcription reproduces upstream exactly, infinity included -- no deviation is
needed to stay faithful, and none is made. If the ported AI turns out to refuse
to leave its own territory, this is the first place to look.

## Front lines are not ported

`InfluenceFrontMap` upstream also derives *front lines*: contiguous runs of
contested tiles grouped by which movement types can cross them, via
`findFrontLineTiles`, `createFrontLine` and a recursive `searchFrontLine`, into
the `frontMovetype` / `frontOwners` fields. Nothing reads any of it back --
`NormalAi` touches only `getOwnInfluence()` and `getEnemyInfluence()`, and the
rest exists to colour a debug overlay. Around 250 lines of recursive grouping,
skipped as pure risk with no gameplay effect.
