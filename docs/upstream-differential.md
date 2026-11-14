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

Three things are checked per turn:

- **The board**: units, buildings, terrain, funds, day and player.
- **Vision**, when fog is on: every tile of every player's fog grid.
- **That each action would have been offered** — reachable, same movement cost,
  on the action menu, a legal target, the same price. Performing a recorded
  action as given only shows that its effects agree; this shows an agent could
  have chosen it.

Commander Wars shuffles the order in which start-of-turn hooks visit the board,
and the order shows: with funds for one repair, whichever damaged unit comes
first gets it. When a turn differs, the replay retries it under other orders
(`Game.startOfTurnOrder`) and reports it as matching "under another
start-of-turn order" if one reproduces upstream's board exactly.

```bash
npm test                                             # includes test/upstream-differential.test.ts
node tools/upstream-diff.ts test/fixtures/upstream/Agitated-fog0-ai2.rec.gz --turns 10
```

`test/upstream-differential.test.ts` fails on any difference that is not listed
in its `KNOWN` table, and also on a listed one that has stopped occurring. The
table is currently empty.

To look for new differences without growing the fixtures, sweep:

```bash
tools/upstream/sweep.sh games.txt out-dir 10    # games.txt: map|fog|days|ai per line
```

It records every listed game in parallel and prints one line per game. Keep a
trace only if it shows something the fixtures do not.

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
ranks, random weather, COs and powers. Three more rules are settings on both
sides (`MOVEVISION`, `TRANSPORTERREFRESH`, `SPECIALDESTRUCTION` in the
environment); the values used are stamped into the fixture and the replay runs
under them:

| Rule | Commander Wars default | iron-accord default | Recorded as |
|---|---|---|---|
| Move vision: a moving unit reveals what it passes | on | off (not implemented) | off |
| Transporter refresh: cargo is readied at its transport's turn start | on | off | off |
| Special destruction: missiles, bombs and lasers can kill outright | on | off | on |

## What it cannot see

- **State the map reader drops.** Unit script variables, timed bonuses and cloak
  timers are not read from a snapshot, so each turn starts with them at their
  defaults. A turn whose outcome depends on them can differ for that reason
  alone; the report flags a turn that already differed on load.
- **Anything drawn from the dice during an action**, other than attack damage
  and the start-of-turn order. Without COs and weather there is little of it.
- **Whatever the AI never does.** The traces are AI-vs-AI games, so an action
  only a person would try is not covered. Across 45 games nothing fired a
  cannon or laser building, for example.
- **What Commander Wars refuses.** A record holds only actions the real game
  allowed, so the offer check is one-sided: it cannot show this engine
  offering too much.
- **Move vision**, which this engine does not implement.

Two quirks of the record itself are accounted for rather than hidden: the game
opens with a hand-over action into the first turn (constructing a `Game` does
the same), and a turn's opening snapshot is written after the first action's
ambush check has already revealed the ambusher's tile.

## After moving the submodule

Download the matching release, re-record the fixtures, then run `npm test`. The
golden replays will report whether the new scripts changed any rule.

## Found so far

2026-11-14, 45 recorded games: 14,090 actions over 1,144 player-turns. Every
action was accepted. Each row below was a difference from the real game, found
by this replay and since fixed; all 1,144 turns now match.

| Difference | Cause |
|---|---|
| Has-moved flag set on the player who is not to move | Commander Wars readies a player's units when their turn ends (`GameMap::endOfTurn` → `enableUnits`), not when the next begins |
| An ambushed unit stopped one tile short, and the next unit sent there stacked on it | The walk animation's end places the unit (`GameAnimationWalk::onFinished`); `Unit::moveUnit` ignores the one-point route an ambush after a single step produces |
| A unit survived with 1e-16 HP and kept its tile | HP lives on a 0.01 grid (`PrecisionGrid::floor`) |
| A newly built submarine was visible | `Player::buildedUnit` runs the unit's own hook, which dives it |
| Water mines had fuel 0 instead of -1 | Fuel and ammo start at -1 and `Unit::setFuel` only assigns when the unit has a tank |
| A half-destroyed weld or meteor was whole again after loading | `Terrain::deserializer` runs `init()` first and applies the stored hit points after |
| Aircraft in a carrier or cruiser burned daily fuel right after being refuelled | A unit that is not on the board has no terrain (`Unit::getTerrain` is null), which is what the upkeep scripts test |
| Under shroud, explored tiles went black again once out of sight | `Player::updatePlayerVision` keeps a seen tile Fogged; only never-seen tiles are Shrouded |
| A radar revealed units in forests and ruins | Building and terrain vision do not see into cover; only a unit standing next to it does |
| A flare or an ambush reveal lasted through the opponent's turn | `GameMap::nextPlayer` counts temporary reveals down as their owner's turn ends |
| Terrain and neutral buildings ran interleaved with the player's own hooks | On a new day the neutral pass runs first and alone, then income, then the player's units and buildings |

Not a rule difference but found the same way: upstream's start-of-turn order is
random, which decided seven of the 1,144 turns (see above).
