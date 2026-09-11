# Squash Island AI stalemate review — 2026-09-11

Reported configuration: Commander Wars AI for both players, Squash Island, fog off.
The changes address reproduced decision failures; they do not guarantee that all
self-play games finish.

## Reproduced causes and changes

- Influence scoring now stays finite when friendly influence is zero. Native
  aggregate retaliation and attack-trade thresholds are retained.
- An idle unit could spend its turn waiting on a production building before the
  production-clearance stage. Healthy occupants now try an exit before that Wait,
  provided it has zero forecast retaliation/building risk and production is affordable. The
  forecast includes existing projected friendly damage; it is not a guarantee of
  safety against every enemy response.
- A lone available airport could reserve its own purchase funds: 10000G became
  an 8000G budget, excluding a 9000G helicopter. A phase selecting no purchase now
  retries with available funds and the appropriate mode ceiling, retaining its
  eligibility checks. Selection is randomized, so failure does not prove every
  cheaper legal option was exhaustively considered.
- When production has no visible enemy-unit proximity targets, known hostile
  buildings now locate the front instead of leaving factories in map-scan order.
  Hidden units and shrouded buildings remain excluded.

These are intentional gameplay adaptations beyond the pinned native policy. See
the [fidelity audit](cw-ai-fidelity-audit-2026-09-10.md) for compatibility limits.

## Controlled self-play

Baseline: `93e491371947f194aad301e7ab5c1f67a404d2de`. Comparisons use the same
diagnostic tool through `vite-node`, the vendored map, seed 1, fog off, two NormalAi
players and a 100-day limit with a 30000-action ceiling. No saved board or AI
state is used.

The original version wins on day 80 in this seed. Its long opening therefore does
not establish an indefinite deadlock. This does not rule out the reported problem
in other seeds or board states.

The baseline also already used its forward factory and all four airports during
the first 50 days. The reproduced production failures are conditional; this is
not a general inability to recognize captured bases or airports.

An experimental combination capped aggregate retaliation at the endangered unit's
value and allowed small losing trades with nearby support. Combined with forward
movement commitment, it increased attacks in the first 50 days (254 to 302), but
had no winner by day 100. On equal days 51–79, it made fewer attacks (237 versus
323), and its army continued growing while the baseline army shrank. Those combat
changes were removed: an early attack count was insufficient evidence of improved
match progression. Aggregate retaliation is a risk heuristic, not a literal
prediction of sequential casualties; capping it also discards threat-density
information. Nearby potential supporters do not guarantee coordinated attacks.

A separate forward-movement experiment kept the first acceptable tile instead of
continuing to minimize predicted loss. That is a change to the native movement
policy, not a porting error. It had no winner by day 100, with 295 units remaining,
and was removed. The final patch retains production fixes and finite
influence scoring, with the original movement and attack policies.

The final production-only run also had no winner through day 100 (19039 actions,
281 units remaining), versus the baseline victory on day 80. Neither reached its
action ceiling; neither had a rejected action.

| Equal-window metric | Baseline | Final production fixes |
|---|---:|---:|
| Attacks through day 50 | 254 | 178 |
| Attacks on days 51–79 | 323 | 250 |
| Combined units on day 50 | 216 | 270 |
| Combined units on day 79 | 151 | 298 |
| Forward factory `(5,5)` purchases through day 50 | 30 | 39 |
| Airport purchases through day 50 | 53 | 56 |

These fixes improve the covered base-use decisions, but the measured match is
longer and has fewer attacks over equal windows. They are not a fix for the
overall stalemate or evidence of improved playing strength. All four airports
were used in both versions; the final run purchased 104 aircraft through day 100.
Crowded approaches and per-unit attack choices suggest a remaining need for
coordinated offensives and congestion-aware production. That is an interpretation
of the recorded positions and scores, not a proven single cause of every stall.

Reproduce the changed version with:

```sh
node tools/probe-cw-stalemate.ts --map 'Squash Island' --days 100 --steps 30000 --seed 1 --output /tmp/squash.json --progress
```

The tool requires Node with TypeScript stripping, or can be run through the
installed `vite-node`. It reports per-day attacks, purchases, movement, army size,
funds and rejected actions, plus purchases by production site. The day limit is a
diagnostic bound; no forced match ending was added to the game.

## Validation

439 tests passed, including new production, clearance and finite-influence
regressions and the existing visibility safeguards. TypeScript and the production
build passed. All eight desktop/mobile browser tests passed against the build under
the GitHub Pages base path.
