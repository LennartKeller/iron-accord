# Handoff: the value net

You are picking up AI work on iron-accord. This is the canonical brief — it
travels with the repo, so treat it as the source of truth over any chat summary.

Everything below was measured on a 10-core laptop. The workstation it moved to
is a Ryzen 9 7950X — **16 cores / 32 threads**, not the 64 assumed here — with
2×4090 and 93 GB. That changes the arithmetic but none of the conclusions.

---

## 1. The one-paragraph version

The game engine runs Commander Wars' own JavaScript unmodified against a
TypeScript host shim, and it is now clean: a full-suite audit reports zero
swallowed script failures. There are two agents. `HeuristicAgent` is a greedy
scorer, shipped and the default. `PlannerAgent` is a beam search over whole
turns, opt-in, and **currently weaker than the greedy agent** — with a precisely
diagnosed fault: giving it more thinking time makes it *worse*. That is the
signature of a search optimising the wrong objective, and replacing its
hand-priced position evaluation with a learned value function is the job.

---

## 2. What is already true

| | |
|---|---|
| Tests | 155 across 17 files, `npm test` |
| Benchmark suite | 18 maps, `tools/tune-ai.ts` (`NAVAL_MAPS`, `LAND_MAPS`, split into train/validation) |
| Self-play throughput | 4.9 games/s on 8 workers at `--maxDays 30`; 2.0 at 60 |
| Replay size | 39 KB raw, **1.9 KB gzipped** |
| Observation | 226 channels, fixed across every map, fog-honest |
| Sim audit | 0 swallowed failures; self-test proves the audit works |

### Agent strength, honestly

**Settled: the value net works, and the head choice is most of it.** On 32 maps
from the wide pool that no net had trained on, 128 matches per series, both fog
modes, both seats, 250 ms, `maxPerLayer 36`:

| agent | vs `HeuristicAgent` |
|---|---|
| mirror (greedy v greedy) | 0.500 — harness unbiased |
| plain planner, hand-priced | **0.445** |
| planner + scalar-head net | **0.488** |
| planner + **WDL**-head net | **0.621** |

3.4σ over greedy (p ≈ 0.0007), and WDL beats scalar head-to-head 0.609 at 3.0σ.
The plain planner reproducing 0.445 against the 0.44 recorded below, on a map
pool it was never measured on, is the check that the rest is real.

**Expert iteration works, weakly, and only with a replay buffer.** Iteration 1:
7,000 net-guided planner games (both seats on the previous net, epsilon 0.15,
200 nodes), 8 hours. Trained two ways and played against the net that generated
the data, 16 held-out maps, 400 nodes:

| net | training data | vs greedy | vs teacher |
|---|---|---|---|
| pure | 1.07M, iteration-1 games only | 0.727 | **0.273** |
| **buffer** | 4.93M, iteration 1 + previous | **0.898** | **0.539** |
| teacher | 4.75M, epsilon-greedy heuristic | 0.859 | — |

Training on the new iteration ALONE is actively harmful -- 0.273 against the
teacher. Mixed with the previous generation it beats the teacher by +0.039, and
for the first time in this project the direct and indirect measures agree
exactly (0.898 - 0.859 = +0.039; 0.539 head-to-head is the same margin). Neither
clears significance alone at n=64.

Caveats worth respecting before spending more compute. The buffer carries ~23%
more training data than the teacher had, so some of the gain may be volume
rather than quality -- iteration 2 should hold total volume constant by dropping
the oldest games. And exploration is far more disruptive for a planner than for
the heuristic: epsilon perturbs one action for the heuristic and an entire turn
for the planner, so the same nominal 0.15 is a much larger perturbation and is a
prime suspect if a future iteration degrades.

The open question is whether it COMPOUNDS. +0.04 for 8 hours is worth automating
only if iteration 2 adds another; if it flattens, iteration 1 was a one-off gain
from mixing better games into the pool. Note also that planner self-play costs
~94 core-seconds a game against ~4 for heuristic play, almost all of it the
search's own simulate-and-rewind -- so throughput, not method, is the lever on
every further iteration.

**Training data: breadth beat volume, and the benchmark data bought nothing.**
16 maps held out from every net below, 64 matches per series, 250 ms:

| net | training data | rank/map | vs greedy |
|---|---|---|---|
| plain planner | — | — | 0.453 / 0.461 |
| `ab-wdl` | 3.12M positions, 12 benchmark maps | 0.393 | 0.523 |
| `merged` | 4.19M positions, 67 maps | **0.436** | 0.523 |
| `wide` | **1.07M positions, 55 maps** | 0.402 | **0.672 / 0.727** |

`wide` trains on a quarter of `merged`'s positions and is not worse anywhere;
the 3.12M benchmark positions added nothing. They come from 12 fast-resolving
maps whose games barely vary, so they carry little information while outvoting
the wide data 3:1 in the loss. Generate more wide-pool games rather than more
games; `wide` overfits by epoch 3 on 1.07M positions, so it is data-limited on
the axis that matters.

**Two measurement traps found the hard way.**

*Indirect comparison inflates differences.* Via greedy, `wide` looked +0.149
over `ab` and +0.149/+0.204 over `merged`. Played head-to-head those became
+0.055 and +0.023 — a tie. Two strong searching agents neutralise each other
and draw more, while greedy is weaker and more exploitable, so a common-opponent
gap is not a difference in strength. Report head-to-head before claiming one net
beats another.

*The benchmark is not deterministic.* `PlannerAgent` budgets by wall clock, so
search depth moves with machine load: `wide` scored 0.672 in a duel sharing the
box with a training run and 0.727 in one that did not — same model, maps, seeds
and seats. `env.reset(seed)` fixes combat luck, not how many nodes fit in 250 ms.
Run benchmarks unloaded, and prefer a node budget when comparing models.

**The stored-position metrics ranked these backwards.** Scalar won every offline
number — val mse 0.4367 vs 0.4640, per-map rank 0.424 vs 0.393 — and loses in
play by three sigma. Pooled rank correlation rewards separating clearly-won from
clearly-lost boards; a beam search separates near-equal siblings inside one
layer, which is exactly where the draw class carries the signal a scalar head
collapses to zero.

It has now mis-ordered three separate decisions: which head (scalar won on
paper, lost 3σ in play), which dataset (`merged` has the best rank of any net
trained and ties for worst in play), and which checkpoint (on `merged`,
cross-entropy bottomed at epoch 1 while rank climbed to epoch 6, so selecting on
CE saved the weaker player — `train_value.py` now writes `value.pt`,
`value-rank.pt` and `value-last.pt` and expects you to play them).
**Do not pick a head, a dataset, or a checkpoint on a validation metric. Play
the matches.**

**The validation metrics measure a class the search never compares — this is
why every offline number here has been misleading.** `outcomeFor` in
`extract-positions.ts` is a pure function of `(replay.winner, playerIndex)` and
never reads the board, so every position a seat faced in one game carries an
IDENTICAL label. Within-game, within-seat label variance is exactly zero. But a
beam layer only ever compares siblings — same game, same turn, same seat, one
action apart — which is precisely that class. So val MSE, val CE and both rank
metrics are computed entirely from two discriminations the search never makes:
which seat of a decisive game this is, and decisive-vs-drawn. A net can climb
every validation metric with zero improvement in sibling ordering.

That explains all four reversals below without any harness bug. It is amplified
by draws: 42-54% of labels are 0, and those are day-cap stalls of the HEURISTIC
that generated the data, so the label says "an advantage greedy could not
convert = dead even". More data means better calibration to greedy's stalls,
which is better metrics and worse play for a searcher that can convert.

**The mirror check proves determinism, not fairness.** `duel()` pins seed 1 and
play is deterministic, so the two seat-swapped mirror games are the SAME
trajectory, booked once as a win and once as a loss: 0.500 is guaranteed by
construction. A harness giving seat 0 double income would still pass it. Also,
with the seed fixed there is no combat-luck sampling anywhere in the benchmark,
so the sampling unit is the MAP, not the match — per-match sigmas are optimistic.

**RESOLVED — Phase 4 passes, and the fix was the training data.** A net trained
on epsilon-greedy self-play gains with depth where every previous configuration
lost. Same run, same maps, same seats, same fog, same reply setting; the
evaluator is the only variable:

Confirmed over a 16x budget range, four points each, same maps and harness:

| nodes | net on epsilon-greedy data | plain planner |
|---|---|---|
| 200 | 0.844 | 0.555 |
| 400 | 0.867 | 0.516 |
| 1600 | **0.883** | 0.477 |
| 3200 | **0.883** | 0.477 |

Both monotone, in opposite directions. Both plateau between 1600 and 3200
because the search saturates -- a turn runs out of legal moves before the budget
runs out, so the planner spends only ~317 nodes of a 1600 budget and the extra
buys literally nothing (identical match records at the two budgets). The shape
to expect is therefore **rising until saturation, then flat, never degrading**.

Why the data and not the search: deterministic self-play records exactly ONE
continuation per position, so the data never says what a different move would
have led to. Sampling among the agent's own top actions (`--epsilon`) supplies
the counterfactual while staying near real play. Measured: at epsilon 0, four of
twelve map/fog groups produce the same winner every time; at 0.15, none do. The
resulting net beats the previous best **0.750 head to head** (5.2 sigma) and
0.836 vs 0.734 against greedy.

This also explains why every attempt to fix the pathology IN THE SEARCH failed
(winner's curse margin, plan brittleness, frozen opponent, discarded stop-mass,
shared-vs-separate policy trunk -- six hypotheses, all dead). The search was
never the problem.

**Superseded — the reasoning that said the pathology was in the search.**
The wall-clock result below was measurement noise. Re-run with a deterministic
node budget and a matched control, over an 8x range on 16 held-out maps:

| 200 -> 1600 nodes | net | plain planner |
|---|---|---|
| overall | 0.727 -> 0.656 (**-0.071**) | 0.492 -> 0.414 (**-0.078**) |
| fog off | -0.047 | -0.047 |
| fog of war | -0.094 | -0.110 |

Both degrade, at the same rate: difference-in-differences +0.007, i.e. nothing.
The net lifts the whole curve about +0.24 and does not change its slope. So the
value net fixed the *evaluation*, and "more search makes it worse" is a property
of the **search**, which survives replacing the objective.

The mechanism that fits is the winner's curse: the beam takes `max` over scored
candidates, the argmax of a noisy estimator is biased upward, and the bias grows
with the number of candidates — for any evaluator, however good. Fog makes
evaluations noisier, which is why both agents fall faster there.

This also **rules out fog self-blinding** as the cause. The steeper fog decline
appears in the plain planner too, and `evaluatePosition` consumes `Belief` via
`buildBeliefThreatMap` — a belief-blind encoder cannot explain degradation in an
agent that is not belief-blind.

**Tried: an opponent-reply veto. A real +0.065, but NOT the depth fix.**
`opponentReplyActions` in `PlannerOptions` (default 0). The search expands only
the acting player's moves — `topActions` filters `endTurn` out, so the turn
never ends inside `plan()` and every leaf is a position where the enemy stood
frozen while up to 24 of our moves piled up. Instrumentation
(`tools/diag-depth.ts`) measured the consequence: promises are KEPT within the
turn (reality beats them by ~700 funds), and the whole error opens after the
opponent replies — +8092 funds at 200 nodes, +13156 at 1600, with clean
dose-response in plan length (~0 for empty plans, +18-20k from length 4 up).
Setting `opponentReplyActions: 8` removes 87% of that gap at 6.4 sigma.

And it does not touch the win-rate slope:

| evaluator | 200 -> 1600 | reply 0 | reply 8 |
|---|---|---|---|
| net | | 0.727 -> 0.656 | 0.797 -> 0.719 |
| plain planner | | 0.492 -> 0.414 | 0.555 -> 0.477 |

A pure level shift of +0.063 to +0.070, replicated in all four cells, with the
slope unchanged (-0.078 everywhere). **Worth turning on for the strength**; the
hand-priced planner beats greedy for the first time with it. But the frozen
opponent is NOT what makes deeper search worse, and the depth pathology remains
unexplained. Note the dissociation: a 6.4-sigma improvement in the funds
diagnostic produced no slope change at all. Four separate offline metrics have
now failed to predict match outcomes. Measure with matches.

Also measured and NOT working: learned move ordering. A policy head trained on
heuristic self-play is neutral at 200 nodes (0.609 vs 0.602) and COLLAPSES at
1600 (0.320 vs 0.563; head-to-head 0.188, ~5 sigma). Two reasons, and the
second is a wiring bug: a policy trained to imitate `HeuristicAgent` cannot beat
`HeuristicAgent.scoreFor` at ordering, since it is a lossy copy of it; and
`topActions` discards the policy's END_TURN mass, so deep in a turn — where
stopping is usually right — the survivors are ranked by near-zero
log-probabilities, i.e. noise.

**Tried and did not work: a noise-scaled acceptance margin.** `selectionSigmas`
in `PlannerOptions` makes a deeper plan beat the incumbent by k standard
deviations of its own layer's scores before it is accepted — the direct
correction for an argmax bias that grows with candidate count. It is implemented
and off by default. Swept over {0, 0.5, 1.0} x {200, 1600} nodes, both
evaluators, 64 matches a cell:

| n=1600, plain planner | rate |
|---|---|
| sigma 0 | 0.414 |
| sigma 0.5 | 0.555 |
| sigma 1.0 | 0.430 |

Non-monotonic, and the same for the net (slopes -0.071, -0.016, -0.086). A
stronger margin should help at least as much as a weaker one; it does not. The
single good cell was noise. **Do not re-run this sweep at n=64** — the effects
being chased are the size of the standard error. Either power it properly (a few
hundred matches per cell) or attack the mechanism differently: average sibling
scores rather than thresholding the max, or use a search that averages and
anchors to a prior by construction. MCTS with PUCT does both, which is the real
argument for it here — not that it searches better.

**Superseded: the wall-clock measurement that suggested otherwise.** 16 held-out maps, 64
matches per series, identical maps/seats/fog at both budgets, so the only
variable is the evaluator:

| budget | WDL net | plain planner |
|---|---|---|
| 150 ms | 0.648 | 0.516 |
| 800 ms | **0.680** | **0.406** |
| Δ | **+0.032** | **−0.110** |

The hand-priced planner still degrades with more thinking time. The net planner
does not. Note the plain planner's 0.406 at 800 ms against the 0.406 recorded
below, measured on a different map pool months earlier — the pathology
reproduces exactly, which is what makes the contrast trustworthy.

The honest reading: +0.032 alone is ~0.5σ, so the claim is **"more search no
longer hurts"**, not "more search helps a lot". That was the gate, and it is
also the precondition for expert iteration — a search that degrades with depth
cannot be used to improve a policy, because you would be distilling worse play.

- `PlannerAgent` vs `HeuristicAgent`, full suite: **~0.44**. It loses.
- More search makes it worse: **0.484 at 150 ms → 0.406 at 800 ms**.
- Weight tuning has failed **twice**, and the second attempt fixed every
  objection to the first: train 0.650 / held-out 0.514, then train 0.646 /
  held-out **0.431**. `DEFAULT_WEIGHTS` is unchanged and should stay that way.

Do not spend a third day on weight search. The ceiling is the hand-priced
evaluation those weights parameterise, which is the argument for the net.

---

## 3. Traps — read this section twice

These each cost real time to find.

1. **No TypeScript parameter properties anywhere reachable from `node`.**
   `node` runs `tools/*.ts` and the self-play workers through strip-only type
   erasure, which cannot generate the assignments a parameter property implies.
   This broke the Pages build once and would have broken the workers. Write
   fields out longhand in `src/host`, `src/game`, `src/ai`, `src/maps`,
   `src/scripts`.

2. **Never import `bootstrap.node.ts` from anything the browser reaches.**
   It pulls `node:vm` / `node:fs` / `node:path` into the bundle, where Vite
   externalises them to stubs and the build still "succeeds". Check with:
   `IRON_ACCORD_BASE=/x/ npm run build 2>&1 | grep -c externalized` → must be 0.

3. **A mirror duel must return exactly 0.500 before you believe any number.**
   `duel({}, DEFAULT_WEIGHTS, ...)` plays identical agents from both seats. If
   it is not 0.500 the harness is biased — that check caught the process-wide
   RNG leaking combat luck between matches.

4. **Report held-out numbers only.** Training-map rates have been wrong by
   0.14–0.22 in both tuning runs.

5. **Call `env.reset(seed)` for every match.** The script RNG is process-wide.

6. **`explore()` rewinds the board *and* the RNG.** Deliberate: without it,
   merely thinking about a line consumes the randomness the real game would
   have used, so the board changes depending on how hard the AI thought.

7. **Failures are swallowed by design.** A throwing action is logged and
   skipped; a throwing animation callback is logged and abandoned *part-way*,
   which is the dangerous one — actions do their real work in those callbacks.
   `ACTION_JOIN` transferred a unit's HP/ammo/fuel and then failed to remove the
   donor, handing out ~10 free units per match, in the UI as well as the AI.
   Run `node tools/audit-sim.ts` after touching the host layer.

8. **Enumeration bugs produce no log at all.** The AI used `stoppableTiles`, so
   `ACTION_LOAD` and `ACTION_JOIN` were never offered and nothing complained.
   If an action never appears, ask whether it is legal before assuming the
   scorer dislikes it.

9. **Seeds barely vary a match.** Luck is ±10% damage and rarely changes a
   rounded HP, so whole games replay identically. Variance comes from *maps*.

---

## 4. Prerequisites — all four are done

1. **Fixed channel layout.** `vocabulary()` in `src/scripts/vocabulary.ts`
   classifies ids by walking prototype chains (`Constructor.prototype = UNIT`),
   giving 63 units + 83 buildings + 64 terrain + 16 derived = **226 channels**,
   identical on a 5×5 and a 24×17 board.
2. **Fog honesty.** `encode` gates units on `VisionType_Clear`. Tested: an
   unseen tank contributes exactly zero unit activation.
3. **Draw handling.** Measured 34.7% / 20.8% / 19.4% draws at 30 / 60 / 120
   days. **Generate at 60.** ~19% are genuine stalemates; at 30 days a further
   ~14% are cut off mid-decision and mislabelled.
4. **Batched evaluation.** `Evaluator<Capture>` in `src/ai/evaluator.ts` splits
   scoring: `capture` runs inside the explore-and-rewind scope, `score` runs
   once per beam layer. The layer is the batch.

---

## 5. The plan

### Phase 1 — dataset

```bash
node tools/selfplay.ts --games 50000 --maxDays 60 --out data/selfplay.jsonl.gz
node tools/replay-check.ts data/selfplay.jsonl.gz 200
```

At laptop speed that is ~7 h. `selfplay.ts` defaults to
`availableParallelism() - 2` = **30 workers** here; at linear scaling off the
laptop's 8-worker 2.0 games/s that is ~2 h, so treat anything near that as
success and anything far above it as a scaling problem. Check `--workers`
scaling first — laptop scaling was sublinear (4→8 workers gained only 35%), but
that is almost certainly Apple's performance/efficiency core split, and this
machine's 32 threads are uniform (16 physical + SMT), so the probe answers a
different question: where SMT stops paying.

**Acceptance:** `replay-check` reports 200/200 reproduced, and the outcome split
is near-even (the laptop run gave 197/202/201). A seat skew means jobs stopped
alternating seats and the net would learn "P1 is good".

Generate with `--agents heuristic,heuristic`. Consider a slice of
`--agents planner,heuristic` and some `--agents random,heuristic` for position
diversity: a net trained only on one agent's positions learns that agent's
blind spots.

### Phase 2 — position extraction — **built**

`tools/extract-positions.ts`. Replays each game and emits `(encoded position,
label)` from the acting player's view, sharded by map into `train/` and
`validation/`.

```bash
node tools/extract-positions.ts --in data/selfplay.jsonl.gz --out data/positions
```

- Encode with `ObservationEncoder.fromGame(game)` — already fixed-vocabulary.
- Only sample positions at turn boundaries or every K actions; consecutive
  positions are near-identical and inflate the dataset without adding signal.
- Write NPZ or raw f32 shards for the trainer.

**Draws are kept, and labelled as draws.** Dropping them is tempting — a fifth
of the set carrying the least varied label — and it is a trap. Draws are not a
random 20%, they are the balanced, closed, no-breakthrough *region* of position
space. Train without them and every label is ±1, so the net learns positions are
won or lost and has no calibrated way to say "dead even" — which is exactly the
discrimination a beam search needs when ranking candidate lines that are all
roughly level. Label 0 is not an uninformative label; a *wrong* label is, and
that is a different and much smaller subset (see relabelling, below).

**Label the outcome as a class, not a scalar** — win / draw / loss. See Phase 3.

**Sampling is per player-turn (`--perTurn`), not per Nth action** — already
fixed, and worth knowing why. The winning side has more units, so it takes more
actions per turn, so a plain stride hands it more samples: a 64-game probe came
out 33% win / 21% loss purely from that. Turns alternate, so a per-turn budget
balances the seats by construction. Measured on a 144-game probe: **win 33.8% /
draw 35.8% / loss 30.4%** — seats balanced, as intended.

What per-turn budgeting does *not* fix is game length. Drawn games run to the
cap while decisive ones end early, so draws stay over-represented at position
level (35.8% here against ~21% of games; the trainer's own note says ~40% on a
larger set). That is a class-prior problem, not a labelling error, and it is
what `--draw-weight` and the WDL class weighting exist for. Do not "fix" it by
dropping positions.

**Relabel the cut-off games rather than guessing at them.** `reason` only
distinguishes `victory` / `step-limit` / `day-limit` (`src/ai/agent.ts:33`), so a
genuine stalemate and a slow decisive game that ran out of clock both surface as
`day-limit` — there is no per-game flag separating them, and the 19% / 1.4%
split in §4 is a population-level inference from the plateau across caps
(34.7 → 20.8 → 19.4), not a property of any single replay. But `maxDays` only
feeds the `done` check (`src/ai/environment.ts:111`) and never reaches an agent,
so re-running a drawn game's exact `(map, seed, fog, agents)` at `--maxDays 120`
replays the identical prefix and continues past the cap. Run that over the
`day-limit` games only — ~21% of the set — and the estimate becomes per-game
truth.

**No γ discount.** The earlier suggestion was `label * γ^(turns_remaining)`, so
an early position in a won game is not labelled as confidently as the winning
move. It interacts badly with draws: discounting pulls decisive-but-early labels
toward 0, which is precisely where the draws sit, blurring the two classes the
net most needs to separate. With a WDL head that uncertainty is expressed as the
entropy of the predicted distribution instead — learned from the data rather
than imposed by a hand-chosen γ.

**Acceptance:** re-encoding the same replay twice is bit-identical, and the class
balance roughly matches the outcome split.

### Phase 3 — train — **built**

`tools/train_value.py`, `tools/export_onnx.py`. Python env is `uv`-managed:

```bash
uv sync
.venv/bin/python tools/train_value.py --data data/positions --epochs 12
.venv/bin/python tools/export_onnx.py --checkpoint models/value.pt --out models/value.onnx
```

Small and fully convolutional, because boards vary from 5×5 to 31×16:

- 3×3 conv → 64 channels, then ~6 residual blocks (conv-BN-ReLU ×2 + skip).
- Head: global average pool **and** global max pool, concatenated with the 5
  scalars (`funds, day, unitCount, enemyUnitCount, incomeShare`), small MLP.
- ~450k parameters.
- **WDL output, not a scalar `tanh`** — `--head wdl`, the default. Three logits
  over {loss, draw, win} (that index order, 0/1/2), cross-entropy against the
  observed outcome, collapsed for search ordering to `P(win) − P(loss)`.
  `--head scalar` keeps the original tanh/MSE path so the two can be A/B'd on
  one dataset rather than argued about; both report `mse` and `rank` on the
  same axis for exactly that reason.
- `--draw-weight` is the draw class weight under `wdl`, a per-sample multiplier
  under `scalar`. Same knob, the shape each loss wants.
- **D4 augmentation** (8-fold flips/rotations) is valid — Advance Wars rules are
  isotropic — and is free data.
- No seat flipping needed: observations are already written "mine"/"theirs".

**Why WDL and not the scalar.** A scalar value head structurally cannot
distinguish a certain draw from a 50/50 win-or-loss — both sit at 0. At ~21%
draws that conflation is a fifth of the dataset rather than a corner case, and
the positions it smears together are exactly the balanced ones a beam search
spends its time ranking. The three-way head lets the net assert "this is
drawish" positively instead of by omission. It is why Leela grew one.

**The failure this guards against.** The planner is a maximiser, so any region
where the eval is systematically overconfident is a region the search will steer
into. Today's diagnosis — more search makes the planner *worse* — is that
failure with hand-priced weights. Dropping draws, or collapsing them into the
same output value as balanced-but-decisive positions, rebuilds the same failure
with a net, and hides it: held-out MSE would look fine while the search walked
into stalemates it scored as won.

One 4090 is more than enough; the second will idle. PyTorch → **ONNX**, run in
JS via `onnxruntime-node` / `onnxruntime-web` so the same file serves Node and
the browser.

**Acceptance:** held-out cross-entropy beats a constant class-prior predictor by
a wide margin, *and* `P(win) − P(loss)` ranks held-out positions better than
`evaluatePosition` — the run prints both as `rank net … vs heuristic …` and ends
on `HEURISTIC STILL WINS` until it does. Watch the `draw n%/m%` column,
predicted rate against true: a net stuck at 0% has learned the prior, not the
position, and one thrashing 0% → 45% → 1% across epochs has not converged.
Both are invisible to a scalar head, which is half the point of this one.

### Phase 4 — wire it into the planner — **built**

`src/ai/onnx-evaluator.ts`: `ValueNetEvaluator` implements the `Evaluator`
split, `capture` packing the same uint8 index planes the extractor writes.
`valuenet.node.ts` / `valuenet.web.ts` load the one `.onnx` per runtime.

It reads the graph's `value` output *by name*, so the WDL export keeps that name
and carries the distribution beside it under `wdl` — the TS side needed no
change, and the probabilities are there when a draw-aware search wants them.

**Inference cost is the binding constraint.** The net is ~1.25 ms per position
natively and ~10 ms under wasm, against microseconds for `evaluatePosition`, so
a 250 ms turn buys ~200 net evaluations in Node and ~24 in a browser — and a
beam given 24 evaluations plays worse than no search at all. `BudgetedValueNet`
therefore ranks each layer with the cheap score and sends only its best few to
the net, the rest keeping cheap ordering below them. Measured on Central Lake:
at 250 ms the net planner wins by day 24; at 60 ms it is still shuffling units
on day 201.

**Acceptance — this is the real test:** the time-scaling curve must *invert*.
Today 150 ms → 800 ms takes the planner from 0.484 to 0.406. With a value net
that correlates with winning, more search must help. Run:

```bash
MAPS=all BUDGET_MS=150 npx vite-node tools/bench-planner.ts
MAPS=all BUDGET_MS=800 npx vite-node tools/bench-planner.ts
```

If more time still hurts, the net is not the problem — stop and diagnose.

### Phase 5 — ship

The planner is already selectable per AI seat in the setup dialog
(`AGENTS` in `web/main.ts`). Budget is 250 ms there. An ONNX model must be
bundled and fetched like any other asset, and inference must stay inside the
turn budget on a phone — measure on the actual device, not the workstation.

Only make it the default once it beats `HeuristicAgent` on the **held-out**
maps, from both seats, in both fog modes.

---

## 6. Command reference

```bash
npm test                       # 155 tests
npm run typecheck
npm run build:data             # regenerate data/ from the submodule
IRON_ACCORD_BASE=/iron-accord/ npm run build

node tools/selfplay.ts --games N --maxDays 60 --out data/x.jsonl.gz
node tools/replay-check.ts data/x.jsonl.gz 200
node tools/audit-sim.ts        # swallowed failures; AUDIT_SELFTEST=1 to prove it works

npx vite-node tools/bench-planner.ts     # planner vs heuristic (MAPS=all, BUDGET_MS)
npx vite-node tools/bench-heuristic.ts   # current vs pre-navigation heuristic
npx vite-node tools/survey-maps.ts       # rebuild the benchmark suite
```

`tools/legacy-heuristic.ts` is a snapshot of the agent before the navigation and
transport work, kept only as an A/B baseline. Delete it once the heuristic settles.

---

## 7. Open questions

- **Is the navigator worth keeping?** Cost-based reachability plus transport
  scoring captures ~22% more property but scores 0.444 against the pre-change
  agent — not significant at n=36, but below 0.5 in both naval and land halves
  independently. Worth more matches on the bigger machine.
- **Should the value net see memory?** The encoding is current-vision only, so a
  remembered enemy does not appear. That keeps encoding a pure function of one
  position — any position from any replay encodes standalone. Adding belief
  channels means replaying from turn one to reconstruct memory.
- **226 one-hot channels or learned embeddings?** Most channels are all-zero on
  any given map. Index planes plus an embedding layer would be smaller and
  probably train better, but changes the `Observation` contract.
- ~~**~19% of games are genuine stalemates.**~~ Settled: keep them, label them
  as a third class, and fix the *position-level* over-representation by sampling
  a fixed budget per game. See Phase 2. Still open is the measurement — what
  fraction of sampled positions actually come from drawn games, and how many of
  the `day-limit` draws relabel as decisive at `--maxDays 120`.
