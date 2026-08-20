# iron-accord

A touch-first, installable web reimplementation of [Commander Wars](https://github.com/Robosturm/Commander_Wars)
(an Advance Wars clone). Commander Wars is vendored as a submodule at
`ext/Commander_Wars` and used as the source of game logic, data and assets.

The initial target is playing against the AI on phones, tablets and desktop
browsers, with mouse support alongside touch.

## The core idea

Commander Wars keeps its game *content* — units, COs, weapons and damage
tables, terrain, actions, movement tables — in ~644 plain-JavaScript files under
`ext/Commander_Wars/resources/scripts/`, executed by Qt's QJSEngine against C++
host objects. **638 of those 644 parse in V8 unmodified.**

So this project does not re-implement the rules. It implements the *host object
surface* the scripts call into (`src/host/`) and then runs Commander Wars' own
scripts against it. Damage formulas, balance tables and CO logic come along for
free, and stay in sync with upstream.

This is not just cheaper, it is more correct. `WEAPON_TANKHUNTER_GUN` declares
its own `damageTable` but its `getBaseDamage` reads `WEAPON_HEAVY_TANK_GUN`'s
instead, leaving its own table as dead data. Extracting tables by hand would
ship silently wrong damage for that unit.

## Layout

| Path | Purpose |
|---|---|
| `src/scripts/` | Loading CW scripts: syntax repair, pluggable evaluator (Node `vm` / browser iframe) |
| `src/host/` | TypeScript shim of the C++ host objects (`Unit`, `Terrain`, `Player`, `GameMap`, `GameRules`) |
| `src/maps/` | QDataStream reader, `.map` deserializer, render-ready scene format |
| `src/game/` | Bootstrap (Node + browser), pathfinding, turn state, action driving, snapshot |
| `src/ai/` | Agent-agnostic layer: action space, observation tensors, step environment, and the heuristic agent |
| `src/render/` | Canvas2D renderer, camera, sprite store with colour-table recolouring |
| `src/input/` | Unified touch / mouse / pen pointer controls |
| `web/` | App shell (dev harness and the eventual PWA) |
| `tools/` | Offline build (`build-data.ts`) and diagnostics (`scan-maps.ts`) |
| `test/` | Vitest suites |

## Deploying

Pushing to `main` builds and publishes to GitHub Pages
(`.github/workflows/pages.yml`). The workflow checks out the Commander_Wars
submodule, regenerates `data/` from it, and builds the site for the
`/<repo>/` path a project site is served from — `data/` is generated rather
than committed, so the submodule is what the deploy actually depends on.

The workflow enables Pages itself via `actions/configure-pages`, so there is
nothing to switch on by hand. If your account or organisation blocks that, do it
once under Settings → Pages → Source → GitHub Actions instead — the symptom of
it being off is a successful build followed by the deploy failing with a 404.

The site is a PWA: a manifest, icons and a service worker that precaches the
shell, the script bundle and all 688 sprites (~1.5 MB), then caches map scenes
as they are played. On iPad, Share → Add to Home Screen installs it and it runs
offline after the first visit.

## Commands

```bash
npm run build:data    # 570 maps + 688 sprites -> 6.6 MB in data/
npm run dev           # dev server; open the printed URL
npm test              # 115 tests
npm run typecheck
```

`build:data` must run before `dev` — it produces `data/`, which is the dev
server's public directory, including `scripts.json` (the Commander Wars scripts,
pre-repaired and in load order, 1.1 MB raw / 0.11 MB gzipped).

Deep-links, all handy for reproducing a board state or screenshotting one
headlessly: `?map=<id>` picks a map, `?select=x,y` picks a unit up (or opens a
factory's build menu), `?to=x,y` walks it to a destination and opens the action
menu, `?build=UNIT_ID` produces a unit at a selected building, `?do=ACTION_ID`
performs an action instead of opening the menu, `?fog=1` starts with fog of war
on, and `?ui=maps|setup|settings` opens a dialog on load. Maps in the `pre-deployed`
category start with units on the field.

Everything runs under bare `node` (no build step) — the code avoids TypeScript
syntax that Node's type-stripping rejects, notably constructor parameter
properties.

## Current state

**Working**

- 361 CW scripts load with zero errors; all 63 units and 51 weapons register.
- `ACTION_FIRE.calcDamage` runs against the shim. 2,762 weapon/defender pairings
  reproduce the scripts' own `getBaseDamage` exactly.
- Terrain defense with the HP-reduction malus matches `game/unit.cpp`.
- All 570 bundled maps parse; every terrain, building and unit id across 261,539
  tiles resolves to a real script.
- Terrain autotiling comes from running the Commander Wars terrain scripts
  (`getSurroundings` is ported), so sprite ids match the desktop client without
  reimplementing the tiling rules. 99.94% of 375,983 sprite requests resolve,
  using just 688 distinct sprites (190 KB).
- Canvas2D renderer with player-colour recolouring, and pan / pinch-zoom /
  tap-select that works with touch, mouse and pen through one code path.
- The scripts boot **in the browser** (hidden-iframe sandbox), so the rules
  engine and the renderer now run in the same process.
- Movement: costs come from the movement-table scripts, range is capped by fuel,
  enemies block and allies may be passed through but not stopped on.
- Turns: per-player unit refresh, day counter, building income, spent units
  dimmed. Tap a unit to see its range, tap again to move it.
- **The action system runs on the Commander Wars action scripts.** The menu is
  built by asking each `ACTION_*.js` whether it `canBePerformed`, and choosing
  one calls its `perform`. Wait, Capture, Fire, Join and Load all come from
  upstream rather than being reimplemented.
- Combat: damage, counter-attacks, ammo, and destroyed units leaving the board.
- Capture: HP-proportional capture rate, ownership transfer at 20 points.
- Production: factory menu priced from the unit scripts, funds charged, built
  units spent for the turn.
- Fog of war: vision from units and owned buildings, shared between allies.
  Standard fog leaves the map layout and buildings visible and hides only enemy
  units; full shroud is a separate mode.
- Victory when a player loses their HQ or runs out of forces.
- Status badges: HP digit on damaged units, plus low-fuel, low-ammo, capture and
  cargo markers, drawn with Commander Wars' own icons.
- A map browser with search and player/size/category filters, and a game setup
  screen for fog mode, starting funds, unit limit, income rate, and each seat's
  army, team and controller.
- Transport: loading onto APCs, landers and the rest per each transport's own
  list and capacity, cargo leaving the board while carried, and unloading onto
  adjacent passable tiles (a boat must be beached or in harbour, not in open
  water).
- Multi-step actions driven generically, so ACTION_MISSILE, ACTION_FLARE and the
  support family work rather than being unreachable.
- Destructible structures: pipes, walls and damaged buildings can be attacked.
- Lifecycle hooks: `startOfTurn` and `endOfTurn` for units, buildings, terrain
  and players, plus death hooks; timed combat buffs apply and expire.
- Turn-start upkeep: aircraft and ships burn fuel, units on owned buildings
  repair and resupply, all driven by the scripts' own `startOfTurn` hooks.
- Snapshot and restore of full rules state (~0.003 ms per cycle), for search and
  for reinforcement-learning rollouts.
- A heuristic AI that plays a full game: it scores every legal action in funds
  and takes the best one. Beats a random opponent 100% from either seat, and
  decides in about 3 ms on a 19x12 board. Set a seat's controller to `ai` in the
  setup screen, or use `?ai=2` / `?ai=all`.
- An agent-agnostic layer in `src/ai/`: serialisable action descriptors, a
  channels-first observation encoder, and a `reset` / `legalActions` / `step`
  environment. A heuristic, a tree search and a learned policy all see the same
  interface. Random-vs-random runs at ~12,000 steps/sec and is reproducible from
  a seed.

**Not yet built**

- A stronger AI. The heuristic agent below is greedy and has no lookahead; the
  environment already supports search and learned policies.
- COs and CO powers, weather, and unit veterancy: unimplemented *features*
  rather than bugs. Victory is also hand-written rather than driven by
  `victoryrule.js`.
- COs. The 90 CO scripts load, but `getBonusOffensive` / `getBonusDefensive`
  omit their CO branches, and no CO powers or power meters are wired up.
- Weather, and the victory-rule scripts (only the two standard conditions are
  implemented, in TypeScript rather than from `victoryrule.js`).
- Multi-step actions beyond production. Anything whose `getStepInputType` is a
  marked-field selection other than Fire is unhandled.
- The AI. `ext/Commander_Wars/ai/` is ~16k LOC of C++ and is *not* scriptable —
  this is the one genuinely large rewrite, and the plan is to write a fresh AI
  against this codebase's model rather than port it.
- The PWA shell: manifest, service worker, offline precache.
- Sprite animation. Sheets are parsed (`cols`/`rows` from res.xml) but only
  frame 0 is drawn, so the sea and unit idle animations are static.
- A sprite atlas. 688 individual PNGs are fine for dev; production should pack
  them.

## Notes for future work

**Balance is not Advance Wars 2.** Commander Wars rebalanced: mech MG vs
infantry is 85 (AW2: 65), recon MG vs infantry 115 (AW2: 70), forest is 3
defense stars (AW2: 2). If authentic AW feel is wanted, swap the damage tables —
they are data.

**Scripts need sloppy mode.** There are duplicate parameter names
(`forest.js` has `function(terrain, map, map)`) and implicit globals. `Global` is
the sandbox global itself (`general/global.js` does `Global = this`), so a
script's top-level `var INFANTRY = ...` becomes `Global.INFANTRY`. In the browser
a hidden same-origin iframe provides the equivalent of Node's `vm` context.

**Animations can be no-ops.** Stubbing `GameAnimationFactory` lets every unit and
CO script run headless, so the rules engine does not depend on a renderer.

**QDataStream writes `float` as 8 bytes.** Qt defaults to
`QDataStream::DoublePrecision` and Commander Wars never overrides it, so every
C++ `float` occupies eight bytes on the wire. Reading them as float32 desyncs
the stream; this single issue caused three separate parse failures.

**Recolouring is a colour-table lookup, not a tint.** `system/frac_matrix_shader.glsl`
is the whole specification: `texture2D(colorTable, vec2(color.r, color.g))` with
alpha passed through. A sprite's red and green channels are *coordinates* into a
lookup image. Because the coordinates are normalised, the table's size sets the
resolution: player tables are 256x256 and index 1:1, while terrain biome
palettes are 64x64 so each axis divides by four. Terrain index colours are
authored as multiples of four with blue fixed at zero.

**The biome palette variant matters more than it looks.** `game/gamerules.h`
defaults `m_mapPalette` to 0 ("Default"), which falls back to each terrain's own
`getDefaultPalette()` — and that combination renders sea *purple*. Real maps set
a style in their GameRules block, which is in the part of the `.map` this reader
skips. `src/maps/loadmap.ts` assumes "Clear AW DS" until GameRules parsing lands;
that is the one place the renderer knowingly guesses.

**Fogged is not Shrouded.** `Player::getDefaultClearVisionType` gives standard
`Fog_OfWar` an unseen state of `VisionType_Fogged` — terrain and buildings stay
visible, only units are hidden. Only `Fog_OfShroud` starts the map
`VisionType_Shrouded`. Collapsing the two makes buildings appear to "de-fog"
when a unit walks past them, which is not how Advance Wars behaves.

**A building's `actionList` decides what it can produce, not its
`constructionList`.** `TOWN` and `HQ` both declare a full unit roster, but
neither lists `ACTION_BUILD_UNITS`, so neither can build — the roster is dead
data, exactly like `WEAPON_TANKHUNTER_GUN.damageTable`. Gate on
`BUILDING.getActions()`.

**A tile with a building answers as the building.** `Terrain::getID()` returns
the *building's* id when there is one, and both movement tables and terrain
defence key on it. Returning the raw terrain id made harbours impassable to
ships (so a fleet could never come home to repair) and gave cities and HQs the
defence of the plains beneath them — 1 instead of 3 and 4, which mis-priced
every city fight in the game.

**Capture progress is lost on any move.** `Unit::moveUnitToField` resets capture
points before relocating. Without it a unit banks 19/20 on a worthless town and
spends it on an HQ next turn, and driving a capturer off a property costs the
attacker nothing. The matching subtlety: `Unit::moveUnit` only relocates when the
path has more than one point, so a unit acting in place must not be run through
`moveUnitToField` at all.

**Fuel may go negative; that is how aircraft crash.** `setFuel` clamps against
`maxFuel` but never against zero, and `GameMap::checkFuel` destroys units whose
fuel went below zero at their owner's next turn. Flooring at zero made air and
naval units immortal and removed the airport-tether entirely.

**`canMoveAndFire` is a script decision, not a range test.** Battleships,
carriers, cruisers and gunboats all move and fire despite being indirect.

**Fog needs terrain concealment to mean anything.** A tile whose terrain
conceals (forest, reef, ruin, fog) is only revealed to a viewer standing
adjacent, unit vision includes terrain bonuses (infantry see 5 from a mountain,
not 2), and building vision defaults to 0 rather than lighting a 2-tile radius.
Separately, an enemy the mover cannot see must NOT block pathfinding — otherwise
the movement overlay silently reveals every hidden unit's position.

**`UnitType` is a bitmask.** Ground 1, Hovercraft 2, Infantry 4, Air 8, Naval 16
(`game/GameEnums.h:178`). Guessing an ordinal sequence makes every type
comparison fail silently — repair matching falls back to construction lists, so
common units heal by accident and everything else never does. Defining
`AiTypes_Human` correctly also flips the scripts' "is this a human player"
branches, which then reach the achievement scripts — so those have to be loaded.

**Zero means unlimited, and zero funds is correct.** `ACTION_BUILD_UNITS` tests
`unitLimit <= 0`, so a unit limit of zero is the engine's own "no cap" value
rather than an unset one. Starting funds are likewise 0 in 1,495 of the 1,496
player slots across the bundled maps, because Advance Wars pays the first turn's
income immediately. Both are faithful defaults; the setup screen now spells out
what they mean instead of showing a bare 0. Every configurable rule is clamped in
`sanitizeConfig`, not just in the form — the values flow into the Commander Wars
scripts, which never anticipated a negative.

**Loading onto a transport needs the tile to be selectable.** A tile held by an
allied unit is not somewhere a unit can *stop*, but it is a legal action target;
that distinction (`canStop` vs `canAct` in the pathfinder) is what makes Load and
Join reachable at all.

**`web/` was missing from the tsconfig `include`.** The app entry point was not
being typechecked at all, so a deleted function went unnoticed until it threw in
the browser. It is included now; `npm run typecheck` covers `src`, `test`,
`tools` and `web`.

**The script RNG is global and must be reseeded per episode.** Commander Wars'
scripts draw combat luck from a single `globals.randInt` stream. Building a
fresh game does not rewind it, so two episodes from the same agent seed diverge.
`GameEnvironment.reset()` reseeds it; without that, reinforcement-learning
rollouts are not reproducible.

**A missing host method fails silently, not loudly.** Script entry points are
wrapped in try/catch so one bad call cannot abandon a turn, which means a gap
shows up as a warning and a half-applied action rather than a crash. Playing
random games and counting the warnings is the fastest way to find them — it took
the count from 259 to 0. `ACTION_CANNON_FIRE` gating on `getFireCount` is the
canonical example: without it the damage lands and the cooldown never ticks.

**Fitting a big map makes tiles untappable.** A 70x40 board fits a tablet
viewport at roughly scale 1, which is 16 CSS pixels per tile — about 4mm, and
narrower than two drag thresholds, so a thumb tap registers as a pan and the
board appears to ignore input entirely. `Camera.fit` therefore has a floor
(`minFitScale`): large maps open zoomed in and pannable rather than fully
visible. `minScale` is lower, so pinching out to an overview still works.

**A late-arriving sprite must request a repaint.** `render()` is synchronous and
peeks a decoded-sprite cache, so a sprite requested for the first time is missing
from that frame. Without a callback when it finishes decoding, the artwork only
appears on whatever render happens next — a freshly built unit stayed invisible
until the following click. `SceneRenderer.onSpriteReady` closes that gap, and
in-flight requests are de-duplicated so a frequently-drawn frame does not pile up
handlers.

**`isFinalStep` and `getStepInputType` are side-effecting.** `ACTION_UNLOAD`
writes into the action buffer and advances the input step from inside *both* of
them, so a multi-step driver must call them fresh each iteration, in that order,
and never cache the result. `setAllFields(true)` with no points added means the
whole map is selectable, not nothing — that is how ACTION_MISSILE picks a target.

**Threat is what it costs *us*, not what the enemy is worth.** A threat map
denominated in the attacker's build cost made a heavy tank's mere presence
outweigh every attack on the board. It stores an expected fraction of health
lost; callers multiply by their own unit's value.

**An attack must not be charged for exposure twice.** `scoreAttack` prices the
counter-attack explicitly, so adding the threat map on top double-counts the
risk badly enough that the agent refuses every trade and ends its turn.

**A unit that cannot capture must never park on a capture target.** The first
version of the agent walked its artillery onto the enemy HQ, permanently
blocking its own infantry, and stalemated every game it should have won.

**Enumerating actions must not perform them.** `beginAction` completes a
single-step action on the spot, so the AI's move enumeration has to use the
non-performing `probeAction`; otherwise merely *considering* a move spends the
unit.

**Sprite ids must come from the scripts, never from the scene.** A scene carries
only its *starting* units and buildings, so deriving artwork from it leaves
anything created or captured during play with nothing to draw — a built RECON
was simply invisible. Units and buildings are both re-resolved through their
scripts each frame, and `resolveUnitSprites` / `resolveBuildingSprites` clear
before resolving so a repeat call replaces rather than appends.

The asset build has the matching half of this: it resolves the whole unit roster
against every army, and every building against every owner, so the artwork for
anything buildable or capturable ships even when no map starts with it. Of the
164 sprite ids a full roster needs, 42 were missing until that pass was added;
another 48 do not exist in Commander Wars at all and are skipped, as the desktop
client also does.

**Actions do their real work in animation callbacks.** `ACTION_CAPTURE.perform`
only *starts* a capture; the building changes hands inside
`performPostAnimation`, which the engine invokes when the animation ends. A stub
animation system that swallows `setEndOfAnimationCall` leaves capture and combat
silently doing nothing. `src/host/animation.ts` records those callbacks and
flushes them synchronously after `perform` returns.

**`map.spawnUnit` takes coordinates first.** The scripts call
`map.spawnUnit(x, y, unitID, owner)`. Our own helper is deliberately named
`addUnit(unitID, owner, x, y)` — two same-named methods whose first two
arguments differ in meaning is a mistake waiting to happen, and the type checker
caught every call site the moment they were separated.

**The game recorder is a permissive proxy.** Scripts call a wide scatter of
methods on it for replay bookkeeping. A missing name would throw mid-action and
abandon the action half-applied, so it answers to anything with a no-op.

**Teams default to the player index, not to what the file says.** `Player::m_team`
defaults to 0 and most maps never write it, so a naive read makes every player an
ally of every other — `Player::checkAlliance` compares teams only, so enemies
stop blocking movement and nothing can be attacked. Commander Wars fixes this at
game start (`gamemap.cpp:2996` does `getPlayer(i)->setTeam(i)`), and
`loadIntoGameMap` does the same.

**Sprites are scaled to tile width, not squashed to the tile.** `game/unit.cpp`
does `setScale(imageSize / anim->getWidth())` and anchors bottom-centre, which is
what lets mountains, forests and units stand above their own tile.
