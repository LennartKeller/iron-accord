# Core debug audit — 2026-09-10

The initial baseline passed all 243 tests and TypeScript checking. This pass
reviewed action execution, turn handling, host objects, rollback, AI observations
and simulation, pointer input, rendering, scene loading, and production assets.
The changes are covered by focused regression tests as well as the existing
suites. This is a bounded audit, not a claim that every rule or browser has been
exhaustively verified.

## Fixes

### Engine and actions

- Execution now checks that a unit is alive, on the board, owned by the active
  player, unspent, and allowed to perform the requested action. Destinations
  must be reachable; movement costs are calculated even without UI selection.
- Attacks validate the chosen target, preventing an in-range enemy from making
  an unrelated out-of-range target legal.
- Multi-step actions reject the wrong input kind, unavailable menu choices,
  and fields outside the offered choices. Menu costs come from the script;
  callers cannot omit or replace them. Validation uses the already-produced
  step data, avoiding repeat calls to side-effecting unload script methods.
- Invalid production coordinates return failure instead of throwing.
- Provisional unloads cannot chain moves and are undone before the next turn.
  A successful drop spends the transport in the engine itself.
- Movement and waiting recheck control; initial vision refreshes after upkeep.
- Hidden enemies now appear absent to movement ranges and action menus.
  At execution, the first enemy collision replaces the planned action with
  `ACTION_TRAP`: stop on the last safe empty tile, pay only the travelled fuel,
  and spend the unit. Capture, combat, support, and unload effects are cancelled;
  interrupted combat consumes no ammunition or combat luck. Water mines use
  the original trap damage/removal callbacks.
- Encounters directly reveal the enemy tile to the mover and allies until the
  mover's next turn. Reveals are included in snapshot/restore. If an allied unit
  occupies the preceding tile, the mover backs up far enough to avoid stacking.
  An intercepted provisional unload is committed and cannot be cancelled into
  a free move.
- Forest concealment is disabled when fog is off; active unit stealth remains
  effective. This prevents false ambushes by ordinarily visible forest units.

### Host state and rollback

- Snapshot restoration includes all terrain, nested base terrain, script
  variables, building creation/removal, and unit/cargo bonuses and metadata.
  In particular, considering destruction of a meteor no longer permanently
  destroys adjoining plasma in the real position.
- Script variables are deeply isolated from snapshots in both directions.
- Restore clears pending actions and provisional unloads, and works in browsers
  where Node's `process` global does not exist.
- Neutral properties count as enemy capture targets, matching the vendored
  Commander Wars alliance logic.

### AI and simulation

- Belief and observation respect unit stealth. Observations no longer expose
  shrouded terrain or the total count of hidden enemy units.
- Allied casualties no longer earn positive enemy-damage rewards.
- Actions after a simulation day limit or game completion are rejected.
- Out-of-map path coordinates cannot alias valid array indices.
- NormalAI firing/suicide/refill planning no longer grants an extra movement point.
  Its full-match regression requires every submitted action to be accepted.
  The simulation audit now counts rejected actions as well as logged failures.

### Input, rendering, and app lifecycle

- Pointer cancellation, long presses, pinches, and secondary clicks no longer
  create unintended board taps. Pinch midpoint motion pans correctly.
- Renderer loads clear old live units/terrain and ignore superseded async work.
- Scene loads invalidate pending AI decisions immediately, and old decisions
  cannot apply to a replacement match. Overlapping map loads are ordered.
- Unit artwork, tile details, and threat inspection use the observer's vision
  and respect status stealth even with fog switched off. Omniscient observation
  remains available. Long presses cannot cancel an AI action during its turn.

### Production build

- The build previously copied and hashed everything in `data/`, including
  175 GB of local training data. It now emits only scripts, scenes, sprites,
  and colour tables, plus the separately configured model and app assets.
- Runtime and model assets enter the service-worker content hash, so changing
  those assets still invalidates offline caches.
- A production build completed in about three seconds and produced 29 MB.

## Visual pass

- Movement follows the resolved route, including truncated ambush paths. Damage,
  capture progress, ownership changes, and traps get brief visual feedback.
  Feedback uses visible pre-action snapshots; it cannot change rules or combat
  luck, and disappearing enemies do not expose hidden destinations.
- AI playback waits for the current visual transition. Scene changes clear
  animations; reduced-motion preferences suppress motion and flashes.
- Selecting a visible unit opens a responsive card with its sprite, health,
  fuel, ammunition, terrain defence, and cargo information.
- Choosing an attack target opens a combat forecast. Fire confirms the attack;
  Back returns to targeting without spending the unit. Average strike/counter
  damage and projected health are shown separately.
- Firefox browser checks exercised selection, targeting, Back, Fire, and damage
  feedback at 1200px and approximately 390px CSS viewport widths. The cards fit
  above the footer without horizontal overflow. Screenshots were inspected.

## Validation

- `npm test`: all 314 tests across 40 files pass (243 before the initial audit;
  284 before the ambush follow-up and 302 before the visual pass).
- `npm run typecheck`: passes.
- `npm run build`: passes; final warm build completed in under one second.
- `git diff --check`: passes.
- `node tools/audit-sim.ts`: 36 matches across the land/naval audit suite,
  with fog off and on; no swallowed failures or rejected actions.

## Remaining limitations

- Automated pointer/renderer regressions use event/canvas mocks. The visual pass
  also received Firefox desktop and narrow-viewport checks, but physical
  phone/tablet gestures and offline installation remain unverified.
- Snapshot capture now copies more state; this prioritizes rollback correctness.
  This pass does not establish search throughput on the largest maps.
