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
| `targetedpfs.ts` | `ai/targetedunitpathfindingsystem.cpp` + the A* in `coreengine/pathfindingsystem.cpp` |
| `damage.ts` | `CoreAI::getBaseDamage` / `calcVirtuelUnitDamage` / `calcBuildingDamage` / `calcFundsDamage` |
| `targets.ts` | `CoreAI::getAttackTargets` / `getBestTarget` / `isAttackOnTerrainAllowed` |
| `actions.ts` | the `ACTION_*` ids `CoreAI` names |
| `coreai.ts` | `ai/coreai.cpp` -- island maps, predicates, the `append*Targets` family |
| `transport.ts` | `CoreAI::doExtendedCircleAction` and the loading/unloading targets |
| `unitdata.ts` | `MoveUnitData`, `createUnitData`, `sortUnitsFarFromEnemyFirst` |
| `scoring.ts` | `calculateCounterDamage` / `getOwnSupportDamage` / `getBestAttackTarget` |
| `movement.ts` | `getClosestReachableMovePath` / `getMoveTargetField` / `moveToSafety` |
| `normalai.ts` | `NormalAi`'s step ladder, as an `Agent` |

Every rung of `performActionSteps` is ported except the CO and Black Hole
branches that do not apply here: `buildCOUnit`, `moveFlares`, `moveOoziums` and
`moveBlackBombs`. What runs is capture, join-capture, support, fire (indirect
then direct), repair, refill, move, move-indirects, support again, load, ferry,
clear-production and build.

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

## The battle formula is not ported

`CoreAI::calcVirtuelUnitDamage` forwards to the `ACTION_FIRE` script's
`calcBattleDamage3`, and that script is one we already run unmodified. So
`damage.ts` calls it directly: the number the AI scores a move on is produced by
the same function that will resolve the attack, and the two cannot drift apart.
Only the caching and the funds scoring around it are ported.

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

`CoreAI::calcUnitDamageFast` computes its counter-damage half by calling
`getBaseDamage(pAttacker, pDefender)` a second time instead of swapping the
arguments, so the "counter" it reports is really the attack repeated.
Transcribed rather than corrected: the AI's tunables were fitted against these
numbers, and quietly making them right would change every decision that reads
them. Worth revisiting only as a deliberate, measured experiment.

`CoreAI::appendSupplyTargets` gates its low-ammo test on `hasAmmo1()`, which is
false at exactly zero, so the unit that most needs resupply is the one it skips.
Transcribed rather than corrected. `needsRefuel` has no such gate, so a dry unit
still goes looking for a depot under its own steam -- only the supply truck's
side of the arrangement is blind.

`CoreAI::getIsland`'s fallback path, taken when no island map for the movement
type exists yet, returns the new map's *index* rather than the island at the
unit's position. Callers compare it against other `getIsland` results, so it is
not inert; reproduced anyway, since the tuning was fitted around it.

The transport code carries three more index/id confusions from upstream, all
transcribed because they change which islands get skipped rather than being
inert. `checkIslandForUnloading` records the island map's *index* in the
checked-islands list while its callers test that list against island *ids*.
`appendNearestUnloadTargets` keys its checked set on the transport's movement
type rather than the passenger's, so two different passengers share one list;
and in its capture loop it indexes the per-passenger island array by the
*capture* index, so a transport carrying a non-capturing unit first reads the
wrong island map. Only the last is guarded, and only against running off the end
of the array.

## Upstream's own AI script does not parse

`resources/aidata/normal/__coreai.js` line 3 reads

    highPrioBuildings = ["FACTORY"],

inside an object literal, which is a hard syntax error. At upstream HEAD
(d04be7dc7, 2026-08-20) the whole `COREAI` object therefore fails to load, and
it is the only file under `resources/aidata/` that does -- every other one
parses. `AI_BEHAVIOR_DISPATCH.getStrategy` returns `COREAI` for the default
behaviour mode, so in the shipping game every production callback
(`initializeSimpleProductionSystem`, `prepareProduction`,
`buildUnitSimpleProductionSystem`, `onNewBuildQueue`) throws a ReferenceError,
and so does `getHighPrioBuildings`.

One character fixes it (`=` to `:`). Two consequences for this port:

- `HIGH_PRIO_BUILDINGS` in `normalai.ts` is hard-coded to `["FACTORY"]`, which
  is what the script would have returned.
- Porting `SimpleProductionSystem` is worth much less than its 1,400 lines
  suggest, because the group definitions that configure it live in the file
  that does not load. The current production rung is a small, documented
  stand-in rather than a port of a system whose configuration is broken.

## Determinism

The port is reproducible, but only if the environment is driven correctly: pass
`bootstrap()`'s own `rng` as `EnvironmentOptions.rng` and call `env.reset(seed)`.
That rng instance is the one wired into the script globals, so a *different*
`Mulberry32` leaves the scripts on the shared stream and combat luck carries over
between episodes -- four runs of one seed then differ. Every tool under `tools/`
already does this correctly.
