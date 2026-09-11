# Coordinated AI (experimental)

Select **New → AI → Coordinated (experimental)** for a seat. Its key is
`coordinated`; **Commander Wars** keeps the existing `commanderwars` key and
policy. The experimental agent wraps NormalAi without adding coordination hooks
to the port. NormalAi supplies ordinary movement, captures, support and production.

## First version: attacks within one turn

The planner considers visible enemies that multiple friendly shooters can reach.
It searches ordered sequences of two to four attacks against one target, using
the game's damage predictor with the target's projected remaining HP. Each unit
acts once and has a distinct firing position. Positions must satisfy movement,
ammunition and move-and-fire rules. It preserves immediate captures and gives a
visible enemy capturing an owned HQ precedence over unrelated objectives.

A plan must predict a complete kill with positive material return after immediate
counterfire and estimated retaliation from other visible enemies and known
buildings. It must beat an equally safe single-unit kill rather than spending
another unit unnecessarily. Every predicted suffix must also pass the continuation
check, so exact forecast damage does not immediately invalidate the promised
follow-up. Other-enemy reach conservatively allows potentially
vacated origins and the destroyed target's tile, instead of relying on blockers
that the plan itself removes. This is an approximate risk estimate, not an enemy
turn search or a guarantee of survival.

The wrapper issues one shot, then replans against actual remaining HP and
occupancy. The remaining group acts before ordinary orders can consume its turns.
An interruption, an ambush or an objective that is no longer visible invalidates
the continuation. Failed objectives are excluded from new coordinated plans for
the rest of that turn; ordinary AI decisions remain available. A continuation may
use just one finisher. Objective IDs, the issued actor/destination, search budget
and fallback state survive save/resume; predicted action lists are rebuilt.

Planning does not mutate the live board, consume combat luck or allocate units.
Hidden units and shrouded structures are excluded from scoring. Planning uses
apparent occupancy; the game engine still resolves actual collisions and ambushes.

## Search limits and scope

Each search considers at most six objectives, eight participants per objective,
three final positions per participant and a beam of twelve sequences to depth
four. It evaluates at most 2,000 sequence extensions and 12,000 damage forecasts.
The wrapper allows twelve searches per turn, reserving continuation capacity
before starting another group. These fixed limits preserve seeded reproducibility;
they do not promise a hardware-independent frame time.

This version implements focus fire. It does not yet move blockers aside, reuse
newly vacated friendly firing positions, exploit a breach with capture orders,
assemble armies across turns, or request production for a shared objective.
Those are separate extensions. The experimental label is intentional: no improved
win rate or cure for Squash Island stalemates has been established.

## Validation

The full suite passes 458 tests, TypeScript and the production build. All ten
desktop/mobile browser checks pass under the GitHub Pages base path.

`test/coordinated-ai.test.ts` checks actual joint kills and continuations, read-only
planning, ammunition/spent-unit restrictions, competing firing tiles, retaliation,
capture priority, hidden information, actual ambush interruption, bounded searches
and mid-offensive save/resume. Browser regressions check the separate option,
completed AI turns and restored state in a fresh autosave on desktop and mobile.

Two 25-day Squash Island smoke runs with fog off completed without rejected
actions: coordinated versus Commander Wars with seed 1, and reversed seats with
seed 2. The second run executed two planner-issued shots; the first used ordinary
fallback actions. Both reached the diagnostic day limit. These runs check
integration, not playing strength or long-term match resolution.

```sh
node tools/probe-cw-stalemate.ts --map 'Squash Island' --agents coordinated,commanderwars --days 25 --steps 12000 --seed 1 --output /tmp/coordinated.json
```

Use `--agents coordinated` to try experimental self-play. Reports separate
accepted planner-issued shots (`coordinatedFire`) from total attacks.
