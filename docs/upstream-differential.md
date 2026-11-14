# Differential testing against Commander Wars

iron-accord runs Commander Wars' rule scripts, but the engine around them — turn
order, movement, ambushes, unit bookkeeping — is this project's own code. The
golden replays (`npm run golden:check`) pin what that engine does. This checks
that what it does is what the real game does.

## How it works

The real Commander Wars can record a game: the starting map, every action, and
the full board at the start of every player-turn. `src/maps/recreader.ts` reads
that file, and `src/game/upstream.node.ts` treats each player-turn as one test:

1. load upstream's board for the start of the turn,
2. perform upstream's recorded actions with this engine,
3. compare the result with upstream's board for the start of the next turn.

Starting every turn from upstream's own board keeps one disagreement from
cascading through the rest of the game. An attack carries its rolled damage
inside the recorded action, so the two engines never need matching dice.

```bash
npm test                                             # includes test/upstream-differential.test.ts
node tools/upstream-diff.ts test/fixtures/upstream/Agitated-fog0-ai2.rec.gz --turns 10
```

`test/upstream-differential.test.ts` fails on any difference that is not listed
in its `KNOWN` table, and also on a listed one that has stopped occurring.

## Recording a new game

You need the Commander Wars release **the submodule is pinned to** — the binary
carries its own copy of the rule scripts, and a diff between two different rule
sets means nothing. The pin is currently `Beta_39_0_Build10`.

```bash
# once: the game
curl -LO https://github.com/Robosturm/Commander_Wars/releases/download/Beta_39_0_Build10/Commander_Wars-Linux_no_userpath_x64-Beta_39_0_Build10.AppImage
chmod +x Commander_Wars-*.AppImage && ./Commander_Wars-*.AppImage --appimage-extract
export CW_APPRUN="$PWD/squashfs-root/AppRun"

# once: a display. The AppImage only has Qt's xcb plugin, so even --noUi needs an X server.
export XVFB="$(nix --extra-experimental-features 'nix-command flakes' build --no-link --print-out-paths nixpkgs#xorg.xvfb)/bin/Xvfb"

#                       map (below the Commander Wars root)   fog days ai
tools/upstream/record.sh "maps/2_player/Agitated.map"          0   15   2
```

The script starts the game headless with `tools/upstream/init.template.js`,
which plays one AI-vs-AI match with recording on, waits for the turn limit to end
it, and writes a trimmed fixture to `test/fixtures/upstream/`. A 12-day game
takes under a minute; several can run at once. Fog is `0` off, `1` fog of war,
`2` shroud, `3` mist; AI is `1` very easy, `2` normal, `5` heavy.

The recording switches off every rule this project does not implement — unit
ranks, random weather, COs and powers — and sets move-vision and transporter
refresh to off, which is what `src/host/gamerules.ts` hardcodes (Commander Wars
defaults both to on). The settings are stamped into the fixture.

## What it cannot see

- **State the map reader drops.** Unit script variables, timed bonuses, cloak
  timers and fog vision fields are not read from a snapshot, so each turn starts
  with them at their defaults. A turn whose outcome depends on them can differ
  for that reason alone; the report flags a turn that already differed on load.
- **Vision itself.** Boards are compared, not what each player can see.
- **Start-of-turn order.** Commander Wars walks the tiles in a random order when
  a turn begins. Where two hooks touch the same unit — an APC resupplying a ship
  that also burns daily fuel — the result depends on that order. The one entry
  in `KNOWN` is this.
- **Anything else drawn from the dice during an action**, other than attack
  damage. Without COs and weather there is little of it.
- **Whatever the AI never does.** The traces are AI-vs-AI games, so an action
  only a person would try is not covered.
- **The legality side.** Recorded actions are performed as given
  (`Game.performRecorded`); this does not show that the engine would have
  *offered* them, nor that it refuses what Commander Wars refuses.

## After moving the submodule

Download the matching release, re-record the fixtures, then run `npm test`. The
golden replays will report whether the new scripts changed any rule.

## Found so far (2026-11-14)

Five recorded games, 2,027 actions, 134 player-turns. Every action was accepted; the boards differed
for five reasons, all now fixed:

| Difference | Cause |
|---|---|
| Has-moved flag set on the player who is not to move | Commander Wars readies a player's units when their turn ends (`GameMap::endOfTurn` → `enableUnits`), not when the next begins |
| An ambushed unit stopped one tile short, and the next unit sent there stacked on it | The walk animation's end places the unit (`GameAnimationWalk::onFinished`); `Unit::moveUnit` ignores the one-point route an ambush after a single step produces |
| A unit survived with 1e-16 HP and kept its tile | HP lives on a 0.01 grid (`PrecisionGrid::floor`) |
| A newly built submarine was visible | `Player::buildedUnit` runs the unit's own hook, which dives it |
| Water mines had fuel 0 instead of -1 | Fuel and ammo start at -1 and `Unit::setFuel` only assigns when the unit has a tank |
