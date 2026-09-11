# Commander Wars NormalAi fidelity audit — 2026-09-10

**Conclusion: the audited gaps have received three repair passes, but native
end-to-end parity remains unverified.** The baseline review found reproducible
integration bugs and substantial policy omissions beyond the absence of COs.
The repair summaries below describe the current implementation; the detailed
findings preserve the baseline evidence. This should still not be presented as a
behaviorally equivalent external Commander Wars benchmark.

## First repair pass

The findings below describe the reviewed baseline, not every defect still present.
The following are now repaired and covered by regression tests:

- Enemy caches are built after friendly caches, restoring nearby enemy movement
  threats and unit influence. Distant-range pruning is retained.
- Loading and ferrying precede late support; the transport completion pass resets
  unspent units for another attempt, and resets normally on the next turn.
- `TargetDistance` has the upstream numeric ordering.
- Retaliation and safety candidate tiles respect the actual movement budget.
- Newly reachable unload planning uses the transport's destination and the hosted
  script, preserves original cargo menu indexes, reserves separate drop tiles, and
  completes multi-passenger actions with Wait. Actual unloading rejects occupied tiles.

Validation after this pass: **348 unit tests, 8 desktop/mobile browser tests,
typecheck and the production build pass**. Tests include a full load–ferry–unload
turn, capture after landing on the next turn, a multi-passenger unload, and
weighted-terrain threat limits. The second pass below addresses production and
attack/support/virtual-damage scoring. The third pass below addresses island
labeling and cannon penalties. Mutation remains a separate limitation; full upstream
parity is not claimed.

## Second repair pass

The attack helpers now rank post-movement shots by funds traded, apply the HP-trade
floor and terrain-attack gate, and compare against a funds-based suicide floor.
The movement follow-up also restores the low-HP gate and the stationary locked-unit
exception to that funds floor. Support uses upstream's fast occupied-tile enumeration and net HP, including its
repeated-attacker counter approximation. The infantry support fixture now returns
**0G / 0HP**, rather than the baseline **232.8G / 4.32HP**. NormalAi computes projected
enemy damage once per turn from deduplicated attacks within two turns' reach and
preserves it by enemy UID across cache refreshes. Integer attack-score operations
and normalized retaliation-cache values now truncate at their C++ assignment points.

Production now executes generated, syntax-repaired upstream `__coreai.js` callbacks
from `src/ai/cw/production-policy.ts` through `production-context.ts`. The generator
is `tools/gen_cw_production_policy.py`. This replaces the prior simplified
funds/composition policy with upstream funds/day modes, factory reserves, reactive
counter/scout/supply/transport queues and topology-driven composition refresh.
Factory selection now applies relative island-size and danger checks before an
always-build fallback. Policy variables, preparation turn and produced-unit count
join the existing queues/distributions in saved production state.

Focused regressions are in `test/cw-scoring-fidelity.test.ts`,
`test/cw-normalai-scoring.test.ts`, `test/cw-normalai-shot-gates.test.ts`,
`test/production-context.test.ts`, `test/production-policy.test.ts`,
`test/production-reactive.test.ts` and the persistence tests. They check intermediate scores and selected trades, not only
that returned actions are legal. Validation after this pass: **377 unit tests, 8 desktop/mobile browser tests,
typecheck and the production build pass**. The first-pass counts above are historical.

## Third repair pass

- Island sweeps now revisit and relabel earlier reachable regions, as upstream's
  fresh unbounded searches do. The shipped asymmetric HOVERCRAFT fixture now matches
  exact native-algorithm labels; symmetric components remain separated.
- `CoreAI.createMovementMap` populates cannon penalties using ownership, fire count,
  damage, offsets and target fields. Construction initializes the map and refill
  processing refreshes it before routing. Building geometry adapters now accept
  scripted point vectors, and `getShotFields` uses the upstream widening cone.
  Tests cover cardinal directions, offsets, stacked hazards and route avoidance.
- Flare, Oozium and black-bomb actions run before the ordinary unit stages. Oozium
  can consume a visible enemy at its movement endpoint; hidden enemies still cause
  collision handling. Bombs evaluate net blast value with the upstream 1.2 friendly
  loss multiplier and otherwise approach a target. Their visibility differences are
  deliberate and listed below.
- Movement follow-ups preserve unit action-list order for final support/build
  actions, then try stealth, safe surfacing and placement. Probes do not execute
  actions. The first shot retains its HP/locked-unit conditions; the second shot
  after these follow-ups has no HP gate but keeps the funds-trade floor. Capture
  and wait remain after those attempts.
- Building field/menu actions can be probed and committed before the unit ladder,
  with production-menu integration handled through the pinned policy adapter.
  The pinned factory-menu negative-price-ceiling defect is preserved: when policy
  selection returns -1, the driver chooses a random enabled entry as upstream does.
  The Black Hole factory's separate construction-list script calls a nullable
  `getCOSpecificUnit` callback. A failed result becomes an empty construction list,
  matching the native script-result conversion; its independent door menus still
  produce units. The vendored script is not rewritten to hide this defect.
  Silo attractiveness is recalculated during each decision after a committed action,
  rather than remaining fixed at turn start.

Focused tests include `test/islandmap-directional.test.ts`,
`test/cannon-routing.test.ts`, `test/cw-special-actions.test.ts`,
`test/movement-actions.test.ts`, `test/cw-building-actions.test.ts`,
`test/factory-production-menu.test.ts` and the normal-AI
integration tests. They assert actual action results, directional labels, hazard
geometry and the safety of read-only probes. Validation after this pass: **406 unit
tests, 8 desktop/mobile browser tests, typecheck and the production build pass**.
The first/second-pass counts above are historical.

## Safeguard hardening

The follow-up review found that the special-action visibility filters did not cover
all ordinary AI decisions. Relocating an unseen tank on an otherwise identical
visible board changed NormalAi's move. Relocating a shrouded factory also changed
its destination. These are now covered by paired-board decision regressions.

- Enemy caches, influence and move ordering use visible units. Revealed units are
  reacquired on the next decision. Enemy reach forecasts use the observing player's
  visibility rather than the enemy player's knowledge of hidden allies.
- Movement, transport and firing/support candidate generation use apparent occupancy.
  The engine still checks real occupants when executing a move, so unexpected enemies
  trigger ambush handling rather than being overwritten or passed through illegally.
- Shrouded buildings do not supply capture goals, cannon danger, production topology
  or factory influence. Buildings under ordinary fog remain public, matching the
  game's existing visibility rules. Enemy cargo does not supply private production
  counts or transport influence.
- Production planning uses apparent occupancy. Its mobility probe stays off the
  board, restores the UID counter, and checks current terrain without a stale cache.
  Actual production still rejects occupied tiles without spending money or replacing
  their occupants. Temporary blocking units do not make a factory permanently unable
  to produce a mobile unit.

Regression coverage includes `test/cw-information-boundary.test.ts`,
`test/cw-navigation-visibility.test.ts`, `test/production-visibility.test.ts` and
`test/cw-production-safeguards.test.ts`. These test identical decisions for the
covered visible-board pairs, read-only planning, reveal handling, budget limits,
correct affordable-unit selection and real collision/production validation.
Validation: **425 unit tests, 8 desktop/mobile browser tests, typecheck and the
production build pass**.

This strengthens the intentional safeguards; it does not turn them into native
Commander Wars behavior or prove that every hosted script respects an information
boundary for every possible map/mod.

## Practical gameplay adaptations — 2026-09-11

The reported army buildup and unused captured bases prompted a gameplay review,
separate from native fidelity. The following changes intentionally go beyond the
pinned policy rather than claiming to reproduce it:

- **Release an unusable production reserve.** The pinned calculation can reserve
  2000G for a lone empty airport itself: at day 10 with 10000G, its 8000G ceiling
  excludes a 9000G K_HELI and the reproduced decision was null. If a phase selects
  no purchase under its budget, the adapter retries with current funds
  and a funds/day-appropriate mode ceiling. Actual affordability, static mobility,
  relative-island checks and that pass's danger constraint still apply. Opening
  purchases and persisted queues are not reinitialized when a base is captured.
- **Use known structures to locate the front.** If production's pruned visible
  enemy-unit list is empty, known hostile buildings replace an otherwise empty
  distance target set. This removes the accidental map-scan preference for a rear
  factory. Neutral and shrouded buildings are not enemy-front evidence.
- **Clear healthy idle production bases before Wait.** A fully healthy idle unit
  can take a safe exit from its owned factory or airport before spending its turn
  in place. This makes the base available to the later production stage. Capture
  and repair priorities remain, and forecast-damage destinations are rejected.
- **Keep influence finite.** Zero friendly influence no longer produces an
  infinite premium. Retaliation remains an aggregate risk heuristic, rather than
  a literal casualty prediction; no unit-value cap or supported-attack tolerance
  is applied.

Regression fixtures are in `test/production-captured-bases.test.ts`,
`test/cw-production-clearance.test.ts` and `test/cw-scoring-fidelity.test.ts`.
They cover the reproduced airport failure, front-base ordering and shroud exclusion,
clearance followed by actual production, and finite influence scoring. These fixtures
are not evidence that SquashIsland self-play always finishes, that the overall
stall is eliminated, or that win rates improve. Measured results are in the
[Squash Island review](ai-stalemate-review-2026-09-11.md); the earlier suite counts
remain historical checkpoints.

## Remaining compatibility limits

These repairs do not establish native parity. Remaining differences include:

- The training mutation policy below is unchanged. `randomizeConfig` still differs
  in arithmetic, clamping and inverted-bound handling from native `randomizeIni`.
- Movement candidate discovery order, stable ties, native random streams and
  single-precision arithmetic. Projected damage keeps the first attack for each
  target, so traversal differences can affect its numerical result.
- No CO support, absent raw map flags and omitted map-authored predefined AI modes.
  The generated production script uses
  hosted topology and visibility adapters; executing the same script is not proof
  that every native host input is identical.
- Native flare scoring inspects hidden enemy locations. This port instead rewards
  revealing fogged area, so identical visible boards give identical flare scores.
  Bomb valuation excludes stealthed enemies, Oozium pursuit uses visible targets,
  and building target selection excludes hidden occupants. These are intentional
  information-safety exceptions, not claims of identical native choices.
- The practical gameplay adaptations above deliberately alter production budgets,
  base ordering and clearance. They are not native
  parity repairs.
- Deliberate safety exceptions: valid price-to-unit associations instead of the
  upstream parallel-array deletion bug, visibility filtering, refusing immobile
  purchases, reachable leaf goals, cumulative movement budgets, and the documented
  weighted terrain comparator exception.

The detailed findings that follow retain their **baseline** descriptions and line
references for provenance. Findings repaired by these passes are not claims about the
current working tree. No native Qt/C++ application or full native decision trace was
executed; remaining issues require separate compatibility decisions and fixtures.

## Scope and evidence

- iron-accord reviewed revision: `d9970e412e2eaf65121db9f350b6585f110a1ea0`.
- Commander Wars reference: clean vendored commit `d04be7dc785331140ca872c5e96401fc79f489a6`.
- Compared the NormalAi decision sequence, capture/movement/transport helpers,
  combat/support/influence scoring, production system, generated groups/profile and
  configuration randomization against that pinned source. This is not an assessment
  of a newer upstream revision or of every host-engine feature.
- Existing suite: **329 tests pass**. These mainly establish legality, reproducibility,
  helper behavior and match outcomes. They do not establish native decision parity.
- Probes use actual hosted game scripts and small controlled boards. Production
  configuration probes also execute the actual upstream JS with its existing
  one-character syntax repair in memory. Specific C++ expectations are derived from
  source, sometimes through a small explicit reference translation. **The native Qt/C++
  application was not built or run**, so this is not a full native differential test.
- The original audit added documentation and diagnostics only. Subsequent gameplay
  changes are listed separately in the repair status above.

Reproduce from the repository root, using the same Node runtime as the project:

```sh
node tools/audit-cw-ai.ts
node tools/audit-cw-navigation.mjs
node tools/audit-cw-production.mjs
npm test
npm run typecheck
```

The diagnostic scripts print observations and source-derived expectations, including
known differences. A zero process exit code means the probe ran, **not** that fidelity
passed. They intentionally inspect private AI state in memory rather than exposing
instrumentation in the gameplay API.

## Highest-priority baseline findings

| Priority | Finding | Evidence / effect |
|---|---|---|
| High | Enemy movement ranges are never built | Nearby tank contributes 0G movement threat and zero unit influence; supplying the missing friendly context yields 234G and 7000 influence in the probe. |
| High | Explicit loading and ferry stages are unreachable | Support sets stage 5 before checks for stages 3/4. A loaded APC reaches a null decision without either stage running. |
| High | Transport distance enum is reversed | A capturer with no targets reports it has targets; an adjacent neutral town produces the opposite answer. |
| High | Post-movement attacks rank raw damage, not funds trade | A tank selects infantry worth about 617G of net damage instead of a tank worth about 2041G. |
| High | Production policy is incomplete | Funds/day phases, reserved money, reactive counter/scout/transport/supply queues and topology-dependent composition are missing or different. |
| High | Safety movement admits one extra movement point | A 3-MP infantry safety helper picks a tile costing 4; the engine later rejects it. |

There are further scoring, island-connectivity, cannon-routing, numeric and training
mutation differences below. Several are masked by the missing enemy ranges or transport
stages, so fixing only the most visible issue will not restore parity.

## Decision-sequence findings

### Loading and ferrying are skipped, and the transport restart pass is absent

At [normalai.ts:320](../src/ai/cw/normalai.ts#L320), the late support call precedes
loading and ferrying. [moveSupport:499](../src/ai/cw/normalai.ts#L499) unconditionally
sets `aiStep=moveSupportUnits` (5). Loading requires `aiStep<=3` and ferrying requires
`aiStep<=4`, so both are skipped, whether support returns an action or null.

Upstream does loading/ferrying **before** the late support stage and then restarts
ordinary unit work after transport, using `m_usedTransportSystem` and resetting
unspent units' stage counters
([normalai.cpp:379](../ext/Commander_Wars/ai/normalai.cpp#L379)). The port has no
corresponding restart state and also lacks the final general movement pass with
transport use enabled.

The live-script probe gives an APC one infantry passenger. Its trace ends:

```text
moveUnits(1) → moveUnits(0) → moveSupport(2)
→ moveAwayFromProduction(5) → buildUnits(6) → null
```

Neither `loadUnits` nor `moveTransporters` is entered. This does not imply that no
passenger can ever load through another helper; it demonstrates that the dedicated
stages and their intended sequence are absent in real `selectAction` execution.
The island-match tests check termination/build counts, not that ferry stages execute.

### Post-movement target scoring drops unit values and counterattack cost

[bestShotFrom:1207](../src/ai/cw/normalai.ts#L1207) ranks unit targets by `damage.x`.
Upstream [getBestAttacksFromField:619](../ext/Commander_Wars/ai/coreai.cpp#L619)
converts the battle to `calcFundsDamage`, checks the HP-trade floor and ranks by net
funds damage. The port also compares its raw percentage score to a funds-based
suicide floor. This is a separate path from the primary `fireWithUnits` scoring.

Real-script plains fixture: own LIGHT_TANK at (2,2), enemy INFANTRY at (3,2), enemy
LIGHT_TANK at (2,3). Both attacks satisfy the default HP threshold:

| Target | Raw damage (%) | Net funds damage |
|---|---:|---:|
| Infantry | 76.5 | 616.95G |
| Light tank | 54 | 2041.2G |

The port's post-movement helper selects the infantry; upstream's comparator selects
the light tank. This probe isolates that helper, rather than claiming the full native
turn necessarily reaches it in this particular board state.

### Special actions and process-level work are also omitted

Upstream [moveUnit:1190](../ext/Commander_Wars/ai/normalai.cpp#L1190) tries support/build,
stealth/unstealth and placement actions in its movement follow-up. The port's
[walkToward:1188](../src/ai/cw/normalai.ts#L1188) narrows that to shooting, capture and wait.
The upstream [process:199](../ext/Commander_Wars/ai/normalai.cpp#L199) also performs
building actions/production preparation and recomputes silo targeting each decision;
our `selectAction` lacks those calls and computes the silo flag in `beginTurn`.
These are source-established omissions, not all individually reproduced here.

CO stages are a known platform limitation. Flares and black-bomb special stages are
also intentionally absent, but the old claim that bundled maps do not contain them
was wrong: scanning the current 570 generated scenes finds FLARE in **9** maps and
BLACK_BOMB in **3**. Examples include `pre-deployed-high-plains` and
`pre-deployed-crater-reef`. Submarines occur in 45 maps and stealth bombers in 6,
so missing stealth follow-up behavior also concerns shipped content.

## What is faithful, and what “faithful” should mean

The 12 generated production groups and 126 INI entries / 125 fields reproduce their
sources byte-for-byte when regenerated. The `%General` section and aliased tuning
field are handled correctly. Many damage, influence, target and transport equations
are recognizable direct ports, including documented upstream quirks. That is useful
coverage, but it does not establish an equivalent opponent when their wiring differs.

Some differences are sensible safety fixes: preserving valid affordable unit IDs,
accepting a reachable leaf goal and checking cumulative route cost. Others are declared
scope choices such as no COs or omitted debug front lines. They should be documented
as exceptions, not mixed together with accidental errors or blindly reverted.

The pinned upstream `__coreai.js` itself does not parse. Our generator repairs it in
memory. Literal parity with that broken runtime is a different target from parity with
the intended repaired NormalAi. A useful acceptance target is **the pinned NormalAi
with that explicit syntax repair, no COs, and a short documented list of safety
exceptions**. The current implementation has not demonstrated that narrower target.
Random-generator choice, randomization order, stable-sort ties and float/integer
conversions also preclude assuming that matching seeds alone will match native turns.

## Original repair and verification order

1. Establish deterministic, source-backed fixtures for enemy ranges/influence,
   the complete stage trace, transport classification and movement budgets. Fix
   these integration failures before retuning any strengths or running training.
2. Bring attack/support/retaliation scoring into the chosen compatibility policy,
   including virtual damage and integer boundaries. Check both selected actions
   and the intermediate scores, so a plausible move cannot hide the wrong reasoning.
3. Restore upstream production phases, reactive queues and topology/refresh policy;
   validate against the repaired JS callbacks under controlled host inputs.
4. Cover special actions and directional movement, and explicitly document any
   safety departures retained from the upstream implementation.
5. Add full-turn fixtures spanning capture, combat, refill, loading, ferrying,
   unloading and production. Where feasible, export native decision traces from
   the pinned C++ build for a true differential harness. Continue using legality
   and win-rate tests as separate measures; neither proves fidelity.

The following component notes retain the detailed source comparisons, repro scopes
and distinctions between unintended errors and intentional upstream quirks.

## Commander Wars scoring fidelity audit

Baseline read-only audit of `src/ai/cw/{scoring,damage,targets,influencefrontmap,unitdata}.ts` and their NormalAi integration. No production files changed. Reproduction: `node tools/audit-cw-ai.ts` from the repository root. The script uses the real bootstrapped CW scripts and an in-memory plains map; its one isolated integer-score example uses a deliberately small mock. C++ results below are derived from the cited vendored code, not a running native Commander Wars executable.

### 1. P1: Every enemy movement range is absent, removing mobile threats and enemy unit influence

**Port:** `src/ai/cw/normalai.ts:221-225` creates enemies first with `otherUnitData=[]` and `always=false`. `unitdata.ts:55-64` therefore always returns before creating a range. `scoring.ts:191-193` sees no candidate firing positions for enemies that must move, and `normalai.ts:237-238` skips every enemy when adding unit influence.

**Upstream:** `ext/Commander_Wars/ai/normalai.cpp:1840-1841` populates own data first, then supplies it to enemy data; `:1958-2005` explores ranges when a nearby opponent is present. `:1868-1871` adds enemy unit influence.

**Reproduced:** 9x7 plains; P0 infantry at (2,3), P1 light tank at (5,3), no buildings, distinct teams. After real `NormalAi.refresh`, enemy ranges are `[null]`, risk at (2,3) is **0G**, enemy influence even at the tank's own tile is **0**. Rebuilding only the enemy datum with populated own data produces **62 reachable tiles**, **234G** risk and **7000** enemy influence at the tank tile. Risk reproduction sets influenceMultiplier=0 to isolate mobile damage. This is an unexpected wiring error, not the documented cache-rebuild simplification.

### 2. P2: Support damage uses a different algorithm, despite preserving an unused upstream fast predictor

**Port:** `src/ai/cw/scoring.ts:269-270` calls full `getAttackTargets`, whose `targets.ts:74-89` uses virtual battle predictions and records raw defender HP lost. `damage.ts:80-83` preserves upstream `calcUnitDamageFast`, but there are no callers anywhere in the AI.

**Upstream:** `ext/Commander_Wars/ai/normalai.cpp:1523-1525` calls `getAttackTargetsFast`. `coreai.cpp:3075-3096` examines every occupied tile within the provided fire offsets, with no enemy or visibility filter, and records **net HP difference** as `hpDamage`. `coreai.cpp:3100-3110` uses the attacker's base weapon damage for both attack and counter. The resulting numbers intentionally differ greatly from a real battle prediction.

**Reproduced:** full-health infantry main actor (2,3), friendly supporting infantry (2,2), enemy infantry (3,3), plains/default config. Port support is **232.8G / 4.32HP**. The upstream fast battle is `{attack:55, counter:55}`, yielding **0G / 0 net HP** and therefore **zero support** under the default strict positive-funds threshold. This changes both attack ranking and the damage credited against the victim before evaluating retaliation (`scoring.ts:329-349`). The port's support alternative count also excludes allied/hidden targets that upstream includes. This may be a desirable AI redesign, but it is an undocumented semantic substitution and cannot be called a faithful transcription.

### 3. P2: Planned enemy damage is never calculated

**Port:** `src/ai/cw/unitdata.ts:45` initializes virtualDamageData to zero on every refresh, and no assignment adds projected own attacks anywhere in the port. `scoring.ts:164-167` nevertheless reads the field to discount enemy danger.

**Upstream:** `ext/Commander_Wars/ai/normalai.cpp:1844-1846` calls calcVirtualDamage on the initial unit-data build. `:2008-2067` enumerates own attacks, deduplicates target positions, discounts distant attacks and accumulates `m_enemyUnitCountDamageReductionMultiplier * damage / attacksSize` into enemy virtualDamageData. Thus rebuilding data is not equivalent to refreshing an upstream cache: it omits a scoring input entirely. There is an additional upstream script quirk: ACTION_FIRE.js:376 discards its taken-damage parameters when forwarding calcBattleDamage3 to calcBattleDamage4, so one should not claim all projected damage necessarily reaches battle math. The explicit alive/threat cutoff at scoring.ts:168 still reads virtualDamageData. Native parity should verify the current repaired script layer separately.

### 4. P2, latent behind finding 1: Retaliation reach includes an extra movement point

**Port:** `src/ai/cw/scoring.ts:192-193` includes `tile.cost <= movementPoints + 1`.

**Upstream:** `ext/Commander_Wars/ai/normalai.cpp:1717` requests `getAllNodePointsFast(movementPoints + 1)`, whose implementation in `coreengine/pathfindingsystem.cpp:208-223` uses **cost < maxRange**. The corresponding port must include costs through movementPoints, not through movementPoints+1. Once enemy ranges are repaired, terrain detours can make the port charge damage for an unreachable firing tile. The initial Manhattan-distance gate does not prevent this on weighted terrain.

The attack-target helper has an inclusive maxDistance API too, but current NormalAi callers compensate correctly by passing `data.movementPoints` (`normalai.ts:991-996`, `:1235-1237`), unlike the retaliation loop. Do not flag those callers as currently allowing illegal movement.

### 5. P2/P3 fidelity details: Integer scores and traversal order change ties

* `scoring.ts:321-353` truncates only the initial unit attack score, then retains fractional support, multipliers and counter subtraction. Upstream `normalai.cpp:1431,1442` holds score/currentDamage in qint32, causing truncation after each compound operation (`:1454-1484`); the terrain branch explicitly casts too. The reproduction supplies two terrain scores 100.1 and 100.9, with defense 3 and 0: TS chooses index **1**, while upstream truncates both to 100 and chooses index **0** by defense. This isolated mock demonstrates the comparator difference, not an asserted frequency in ordinary maps.
* `scoring.ts:180,207` caches fractional normalized enemy damage in a JS number. Upstream `normalai.cpp:1629` declares `std::map<QString,qint32>`, so inserting that normalized value truncates it. Multiple same-type attackers can therefore have a different cumulative retaliation score. Lower priority than missing ranges/support.
* `targets.ts:121,177` and `scoring.ts:192` iterate the movement Map in pathfinding discovery order. `src/game/pathfinding.ts:99-102` explicitly preserves first-discovery ordering; upstream `coreengine/pathfindingsystem.cpp:211-213` emits x-major, then y-major. Strict-best and first-valid loops make this a behavior difference, even where numerical scores agree. Preserving repository replay order may be intentional, but it is not upstream tie parity.

### Differences that are already deliberate, or should not be presented as new bugs

* Influence front-line/debug geometry omitted in `influencefrontmap.ts:98-103`; upstream gameplay only consumes the influence values. Own/enemy/team influence calculation and factory/unit decay otherwise match the inspected C++ equations structurally.
* Duplicate enemy-building damage pass (`scoring.ts:77-82`, upstream normalai.cpp:1803-1810), building HP overkill cap (`damage.ts:133-135`, upstream coreai.cpp:508-510), same-attacker fast counter (`damage.ts:80-83`, upstream coreai.cpp:3103-3104), and zero-own-influence division (`scoring.ts:110-114`, upstream normalai.cpp:2081-2085) really are inherited upstream behaviors. Fixing them is a separate policy choice.
* `targets.ts:164-170` compares weighted terrain score consistently whereas upstream `coreai.cpp:663` compares raw damage to the stored weighted score. This deviation is acknowledged in the source and dormant for shipped BuildingValue=1. `targets.ts:98` sets terrain hpDamageDifference to damage, where upstream leaves default zero (`coreai.h:94`, coreai.cpp:744-748); shipped minHpDamage is nonpositive, so this generally does not alter filtering.
* getBestAttackTarget's defense tie-break reads the **defender tile** in both versions (`scoring.ts:355`, upstream normalai.cpp:1485-1486), despite the port doc comment claiming the actor's safer firing tile. That comment is inaccurate, but the code itself is faithful here.
* JS stable sort vs C++ std::sort for fully equal unit comparator keys has no defined matching order guarantee. Comparator criteria themselves match `coreai.cpp:2100-2127`; no stronger unit-order bug established here.

No conclusion of behavioral parity follows from existing tests passing. Findings 1 and 2 have concrete live-script numerical reproductions; the remaining findings are source comparisons with confidence/scope explicitly separated.

## Commander Wars navigation / transport fidelity audit

Audit scope: `src/ai/cw/{coreai,movement,transport,islandmap,targetedpfs}.ts`, compared directly with vendored C++ CoreAI, NormalAi, IslandMap, TargetedUnitPathFindingSystem and PathFindingSystem. No gameplay edits made. Reproductions live in `tools/audit-cw-navigation.mjs`; run `node tools/audit-cw-navigation.mjs`. This runs the TypeScript with the vendored scripts. Upstream expectations were derived from inspected C++ control flow; the desktop C++ binary was not compiled/executed. The island reproduction implements its unbounded reachability/relabeling algorithm against the same movement scripts.

### Confirmed unintended drift

#### 1. High: reversed TargetDistance enum inverts transport eligibility

- TS `src/ai/cw/transport.ts:15-16` claims the C++ enum order but declares `CloseTarget=0, FarTarget=1, NoTarget=2`.
- Upstream `ext/Commander_Wars/ai/coreai.h:50-54` declares `NoTarget=0, FarTarget=1, CloseTarget=2`.
- TS `movement.ts:209-210` and C++ `coreai.cpp:1275-1277` both test `hasCaptureTarget(...) >= FarTarget`; with reversed values, the same comparison has opposite meaning for close/no targets.
- Reproduced on a 6×1 plain map: infantry with no enemies or buildings returns `hasTargets=true` (upstream false). Add a neutral TOWN one tile away and it returns false (upstream true). Enemy production shortcut disabled naturally because TOWN is not production.
- This can keep idle passengers from being collected and seek transport for passengers that already have nearby capture work. The `appendCaptureTransporterTargets` comparison (`transport.ts:392`; C++ `coreai.cpp:1533`) is inverted too. Equality-based switch logic is unaffected.
- This is not a copied upstream quirk: the enum transcription itself is wrong.

#### 2. High: safety movement includes one extra movement point

- TS `movement.ts:144-145` accepts `tile.cost <= movePoints + 1` from a multi-turn `unitData.range`.
- C++ `normalai.cpp:1344` calls `getAllNodePointsFast(movePoints + 1)`, whose definition at `coreengine/pathfindingsystem.cpp:208-220` uses **strict** `cost < maxRange`. Actual accepted costs are therefore `<= movePoints`.
- Reproduced with infantry at x=0 on 6×1 plains, 3 MP, expanded 2-turn range, zero threats and safety target x=5. TS chooses x=4 (cost 4), while the C++ candidate set chooses x=3. The new Game execution boundary correctly rejects x=4, but the AI helper still proposes it.
- This is the same exclusive-bound convention behind the separately identified normal-AI fire-range bug; it remains present in this helper. Also inspect the analogous `.filter(tile => tile.cost <= enemyData.movementPoints + 1)` in `scoring.ts:188-190` (outside this audit's primary ownership).

#### 3. Medium: island flood fill is not equivalent for shipped asymmetric movement

- TS `islandmap.ts:71` never traverses or relabels a tile assigned to a previous island.
- C++ `ai/islandmap.cpp:59-67` performs a fresh unbounded sweep from each unlabelled passable seed and writes the current island ID to **all** reached tiles, including tiles assigned by earlier sweeps.
- For symmetric movement this is equivalent. For directional edges it is not, contrary to the claim at TS `islandmap.ts:21-24`.
- Reproduced using the real HOVERCRAFT movement table on the following 5×5 board (rows shown; P=PLAINS, S=SEA, B=BEACH):

```
P S S S B
S S S S S
S S B P S
P P S S S
B B S B S
```

- TS assigns isolated P(0,0) island 0, B(4,0) island 2, and all other tiles island 1. The C++ sweep algorithm assigns isolated P(0,0) island 0 and all other tiles island 2. Thus TS says B(4,0) and S(3,0) differ in island, whereas the upstream algorithm says they match. This changes ferry feasibility and island-value decisions, not merely component numbering.
- `movementtables/move_hovercraft.js` is explicitly directional and returns `getSupportsFastPfs=false`; this is not dependent on missing CO behavior or a synthetic movement table.

#### 4. Medium: cannon routing penalty exists as a parameter but is never populated

- TS `coreai.ts:50` initializes `moveCostMap` to zeros; repository search finds no writer. `normalai.ts:639,1123` passes those zeros into targeted routing, which applies them at `targetedpfs.ts:152`.
- Upstream `normalai.cpp:583-589` calls `createMovementMap` when entering refill/move-to-targets work. `coreai.cpp:520-585` resets and fills tile penalties using eligible building damage/target fields.
- Therefore even where the host supplies a building's damage/target geometry, actual AI navigation cannot bend around cannon coverage as upstream does. The isolated targeted-PFS tests can pass with manually supplied penalties while integration remains absent.
- A hosted ZMINICANNON_W reports damage 3 while CoreAI's map stays entirely zero. Its target-field adapter returned null in the temporary scenario, so that particular hosted-building case also has an independent adapter limitation; the absent map-population call is established by source inspection regardless.

### Confirmed differences that improve or alter upstream behavior, requiring an explicit fidelity decision

#### 5. Targeted search accepts a reached goal when its queue drains

- TS `targetedpfs.ts:263` calls `setFinishNode()` after exhausting the open queue.
- C++ `coreengine/pathfindingsystem.cpp:81-85` only calls the virtual setter when `finished(...)` returns true; the queue-drain path ending at line 189 has no setter call. `m_FinishNode` defaults to -1 (`pathfindingsystem.h:251`). Targeted `finished` requires a later cost strictly above the incumbent threshold (`ai/targetedunitpathfindingsystem.cpp:157-158`).
- Reproduced with 2×1 plains, infantry x=0, single weight-1 target x=1: TS returns x=1, while the C++ control flow drains after recording the goal and leaves finish=-1. TS behavior is sensible but is not a literal port. Do not label it a gameplay regression merely because it differs.

#### 6. Move-target selection checks route cost instead of tile-entry cost

- TS `movement.ts:108-109` compares the cumulative shortest-route cost against movement points.
- C++ `normalai.cpp:1401` calls `turnPfs.getCosts(index,x,y,x,y,0)`, which returns the single tile-entry movement cost (`game/unitpathfindingsystem.cpp:55-61`), then compares that to movement points.
- Reproduced directly with 3-MP infantry and a path x=4→3→2→1→0: TS picks index 1 (x=3); upstream's local-cost predicate admits index 0 (x=4). TS is safer. Normal callers often trim paths before reaching this function, so the direct helper difference need not manifest in ordinary turns. This deserves documentation as a safety divergence rather than blindly restoring the weaker upstream check.

### Copied quirks / faithful portions checked

- `CoreAI.getIsland` fallback returns the newly added **map index**, rather than the island at the unit's position: TS `coreai.ts:82-90`, C++ `coreai.cpp:2234-2245`. This oddity really is upstream.
- Transport bookkeeping pushes the cargo island-map index into a list compared against island IDs: TS `transport.ts:95-98`, C++ `coreai.cpp:1764-1769`. This is copied upstream behavior, not a new port defect.
- `appendNearestUnloadTargets` shares the transport movement-type key across attack passengers and uses a capture-only index against an all-passenger island array: TS `transport.ts:203-234`, C++ `coreai.cpp:1585-1630`. Both quirks are indeed present upstream.
- The fixed finish-coordinate test while trimming a target path is copied: TS `targetedpfs.ts:294-315`, C++ `targetedunitpathfindingsystem.cpp:111-125`.
- Targeted A* weighted-distance formula, >one-turn occupancy penalty of 3, cannon penalty addition, goal bookkeeping, east/west/south/north expansion and upper-bound queue ordering match the inspected upstream arithmetic/control flow (apart from queue-drain finalization above).
- Stable target sorting is an explicitly documented TS alternative (`targetedpfs.ts:82-89`) to upstream `std::sort`; it can choose differently among tied targets. General Dijkstra range order is also intentionally a different implementation: it is not proof of desktop action-for-action equality.
- Core supply/repair/capture target predicates, stealth target maluses (2/4 and 3/6), and production-tile avoidance match their C++ counterparts in this bounded review.

The enum inversion, exclusive budget bound and asymmetric island mismatch are concrete failures of faithfulness. Existing passing scenario tests alone do not establish parity; their assertions often use the same exported enum constants or check broad plausibility rather than upstream results.

## Production/configuration fidelity audit

Compared the working TypeScript tree against vendored Commander Wars commit `d04be7dc7`. This is a source and focused differential audit, not a claim that the full C++ game was executed. No gameplay files were edited for this audit.

Reproduction: `node --experimental-strip-types tools/audit-cw-production.mjs` (uses actual repaired upstream JS in a Node VM and actual TypeScript functions). The repair changes only `highPrioBuildings = [` to `highPrioBuildings : [` in memory, matching the existing generator. C++ mutation evidence uses a small line-for-line arithmetic translation, so does not claim Qt RNG bitstream parity.

### 1. High: the production decision policy is substantially omitted

- TS `src/ai/cw/normalai.ts:777-794` calls `ProductionSystem.buildNextUnit` directly, with no callback-equivalent funds/day policy. Its defaults at `production.ts:251-257` allow modes 0–100 and spend up to all player funds.
- Upstream `resources/aidata/normal/__coreai.js:574-652` computes a budget reserving funds for other factories, tracks units produced this turn, picks phases using `fundsModes` (561-572), and retries lower minimum modes. It first avoids dangerous build sites, then repeats with `alwaysBuild=true` as fallback.
- Executing actual upstream JS with day 1, 10,000 funds, one factory, zero purchases yields `buildNextUnit(..., minMode=1,maxMode=1,islandFraction=0.025,minCost=0,maxCost=8000)`. TS instead uses `0,100,0,10000` for corresponding mode/cost arguments. This changes which units are considered after the opening queue; it is not a CO-dependent distinction.
- Upstream `__coreai.js:251-275` creates forced anti-air, anti-tank, anti-sea, anti-recon, scout, transporter and supply purchases on each new queue. TS has `addForcedProduction` (`production.ts:152-155`) but no callers anywhere under `src/ai/cw`; `NormalAi.buildUnits` explicitly ignores `_enemyUnits` (`normalai.ts:778`). Thus its production cannot reproduce those reactive decisions. Most urgently, several counter units such as FLAK/FIGHTER occur in upstream forced lists (52-71), not in the 12 distribution groups that the port generates.
- Classification: knowingly simplified architecture (README says configuration JS is not run), but the extent is understated by saying its configuration “reduces cleanly without COs” and its algorithm is ported (`README.md:172-178`). These branches remain relevant without COs.

### 2. High: naval/air composition is not equivalent, and infantry/amphibious weights are incorrectly ground-scaled

- TS `production.ts:69-93` infers naval/air from currently owned build menus and halves ground weight per available theatre. All groups whose names omit NAVAL/AIR—including infantry and amphibious groups—receive that multiplier.
- Upstream `__coreai.js:104-120` uses `1/NAVALBATTLE * 1/AIRBATTLE` where positive. These integers arise from enemy/shared-island topology, owned AND enemy airports/harbours, idle units, day gating, and map flags (`334-405`); values can be 1, 2, 4 or higher. Absence of map flags does not reduce this to a build-menu boolean.
- Upstream infantry is inserted separately and never receives the ground multiplier (`133-139`). Only light/medium/heavy tank groups do (`140-143`). Amphibious groups use `addModifiedDistribution` (`171-194`), not the ground multiplier.
- Actual upstream JS versus actual TS, no COs, all normal profile group modifiers=1, a same-island air battle (`AIRBATTLE=1`, `NAVALBATTLE=0`): infantry target 40 upstream vs 20 TS; light tank 50 vs 25; light amphibious 40 vs 20. The attached evidence script prints these comparisons.
- Upstream inserts air groups regardless of current ownership (`144`), with active buildability filtering later. TS omits air groups forever if no air factory is available when initialized (`78-90`). Capturing an airport subsequently cannot activate omitted groups. Upstream also periodically resets/reinitializes distributions without resetting opening infantry (`404-405`); the TS normal execution path only initializes once (`normalai.ts:786`). Preserving distributions in new autosaves is faithful to uninterrupted TS behavior, but does not fix this earlier gameplay divergence.
- Classification: documented deliberate replacement of flags with buildability (`README.md:204-206`), plus unacknowledged scaling/application and refresh differences. README's “what the modifier is really asking” explanation is inaccurate.

### 3. High for training/tuning: `randomizeConfig` is not a port of `randomizeIni`

- TS `ini.ts:39-40`: `current *= 1 + roll/100`.
- C++ `ai/coreai.cpp:286-289`: `current += (max-min) * roll` (no percentage division).
- C++ clamps each field after every entry, whether or not that knob was selected (`292-299`); TS's early `continue` at 26 skips unselected entries and TS never clamps after mutation.
- TS sorts inverted bounds (`27-30`); C++ `GlobalUtils::randFloat` returns `low` when `high<=low` (`coreengine/globalutils.cpp:115-120`), then executes the original ordered clamp. The bound normalization is explicitly commented as a choice, but changes parity substantially.
- Deterministic evidence using a constant random value 0.75:
  - chance=1, rate=10: `ownUnitValue` TS 1.05, C++ arithmetic 10; `cheapUnitValue` TS 1260, C++ 5000.
  - chance=0: `cheapUnitValue` TS 1200, C++ 1500; `spamInfantryChance` TS 30, C++ 100. Upstream clamps even with no mutations.
  - chance=1, rate=-1: inverted `SpamInfantryChance` TS 87.5, C++ 50.
- Classification: percent-nudge and missing clamps appear unintended translation errors; inverted-range normalization is intentional but not faithful. These results affect tuned/training opponent populations, not default unmutated browser NormalAi configuration.

### 4. Medium: factory suitability and danger checks differ

- TS `normalai.ts:799-818` checks affordability and whether a freshly created unit can reach more than its own tile, caching that mobility decision. `production.ts:310-315` takes the first acceptable factory.
- C++ `simpleproductionsystem.cpp:940-984` checks the unit's traversable island size against average buildable-unit island size (`minAverageIslandSize`), and can sort factories by target proximity for forced purchases. `executeBuildAction` calls `reasonableBuildField` unless `alwaysBuild` (`1049-1053`); `reasonableBuildField` (`1128-1172`) rejects dangerous builds using actual enemy movement/ranges/base damage. The upstream JS sets range 10 and damage 70 (`__coreai.js:253-256`), then permits danger only on a later fallback pass (`647-657`).
- The one-step mobility test is an explicit TS policy (README calls out refusal to buy immobile units). It is useful, but not the same as upstream's relative island-size or two-pass threat checks. Forced target coordinates/proximity are absent from TS `ForcedProduction` (`production.ts:25`).

### 5. Medium: a C++ price-filter bug is not reproduced

- C++ `simpleproductionsystem.cpp:912-928` checks `item.distribution.units[i]->getUnitCosts()` while deleting only `unitIds[i]` and `chance[i]`, not `units[i]`, after a failed price check. `updateActiveProductionSystem` likewise removes only IDs/chances (`178-207`). The parallel dummy-unit array therefore becomes misaligned.
- TS `production.ts:222-241` checks the actual ID's price and rebuilds IDs/chances correctly.
- Concrete source-derived example: active light group `[LIGHT_TANK, ARTILLERY]`, prices `[7000,6000]`, max cost 6000. C++ removes LIGHT_TANK at index 0, then checks the still-index-0 LIGHT_TANK dummy against the remaining ARTILLERY and removes it too. TS keeps ARTILLERY. This is a positive correctness difference, but excludes strict algorithm equivalence. Do not introduce the upstream bug merely to satisfy an unqualified fidelity claim.

### Confirmed faithful parts and limits

- Actual raw `__coreai.js` still fails parsing at line 3 with “Invalid shorthand property initializer”. The one-character generator repair remains necessary and intentional. This means literal broken-upstream runtime behavior and intended repaired-upstream behavior must be distinguished in any fidelity claim.
- Re-ran both generators with output redirected to `/tmp`, without modifying the repository: 12 generated groups and 126 INI entries / 125 unique fields are byte-identical to checked-in `groups.ts` and `config.ts`.
- Qt `%General` handling and the `LowDirectUnitBonus -> highIndirectMalus` alias are handled correctly for the checked-in normal.ini: `tools/gen_cw_ai_config.py:74-82` applies overrides in declaration order, matching `coreai.cpp:206-238`. The two entries without overrides have matching header defaults (`AttackCountBonus=25`, `OwnBuildingPruneRange=10`). No concrete default-profile numeric mismatch found. This does not mean every generated tuning field is used by the simplified production implementation.
- README's narrowly stated no-CO direct/indirect modifier=1 is correct for `COREAI.initializeSimpleProductionSystem`: it calls `getAiCoBuildRatioModifier` (`__coreai.js:125`); C++ returns an initial 1 multiplied only by CO values (`coreai.cpp:2764-2776`). `NormalAiConfig.directIndirectRatio=3.5` is a separate fallback C++ build-score parameter (`normalai.cpp:2158,3096-3131`), so its existence does not refute that specific claim. The broader assertion that all surrounding configuration vanishes without COs is incorrect for reasons above.
- Opening six infantry and keeping the queue across turns match intended upstream initialization (`__coreai.js:129-132`). Core ranking arithmetic and inclusive weighted draw bounds are broadly transcribed, but that is only a subset of production behavior. C++ map ordering and sort tie behavior also differ from JS Map/stable sorting; no exact outcome counterexample was established here, so this is a lower-priority unverified parity risk.

Suggested audit conclusion: a practical adaptation of Commander Wars with authentic generated constants and substantial algorithm fragments, not a faithful end-to-end NormalAi production port. Decide whether the target is the deliberately repaired intended upstream behavior or exact broken pinned behavior before changing anything.
