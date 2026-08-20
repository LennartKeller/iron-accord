# Handoff: the value net

You are picking up AI work on iron-accord. This is the canonical brief — it
travels with the repo, so treat it as the source of truth over any chat summary.

Everything below was measured on a 10-core laptop. You are presumably on the
64-core / 2×4090 / 96 GB workstation, which changes the arithmetic but none of
the conclusions.

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

At laptop speed that is ~7 h; expect well under an hour on 64 cores. Check
`--workers` scaling first — laptop scaling was sublinear (4→8 workers gained
only 35%) but that is almost certainly Apple's performance/efficiency core split,
not a real ceiling.

**Acceptance:** `replay-check` reports 200/200 reproduced, and the outcome split
is near-even (the laptop run gave 197/202/201). A seat skew means jobs stopped
alternating seats and the net would learn "P1 is good".

Generate with `--agents heuristic,heuristic`. Consider a slice of
`--agents planner,heuristic` and some `--agents random,heuristic` for position
diversity: a net trained only on one agent's positions learns that agent's
blind spots.

### Phase 2 — position extraction

New tool, `tools/extract-positions.ts`. Replay each game, and at every Nth
action emit `(encoded position, label)` where the label is the final result
from the acting player's view: `+1 / 0 / -1`.

- Encode with `ObservationEncoder.fromGame(game)` — already fixed-vocabulary.
- Only sample positions at turn boundaries or every K actions; consecutive
  positions are near-identical and inflate the dataset without adding signal.
- Write NPZ or raw f32 shards for the trainer.
- **Consider discounting toward the end** (`label * γ^(turns_remaining)`) so an
  early position in a won game is not labelled as confidently as the winning move.

**Acceptance:** re-encoding the same replay twice is bit-identical, and label
balance roughly matches the outcome split.

### Phase 3 — train

Small and fully convolutional, because boards vary from 5×5 to 31×16:

- 3×3 conv → 64 channels, then ~6 residual blocks (conv-BN-ReLU ×2 + skip).
- Head: global average pool **and** global max pool, concatenated with the 5
  scalars (`funds, day, unitCount, enemyUnitCount, incomeShare`), small MLP, `tanh`.
- ~450k parameters. MSE against the outcome label.
- **D4 augmentation** (8-fold flips/rotations) is valid — Advance Wars rules are
  isotropic — and is free data.
- No seat flipping needed: observations are already written "mine"/"theirs".

One 4090 is more than enough; the second will idle. PyTorch → **ONNX**, run in
JS via `onnxruntime-node` / `onnxruntime-web` so the same file serves Node and
the browser.

**Acceptance:** held-out MSE beats a constant predictor by a wide margin, *and*
the net ranks positions better than `evaluatePosition` — score both on the same
held-out positions before wiring anything up.

### Phase 4 — wire it into the planner

Implement `Evaluator<Float32Array>`: `capture` encodes the position, `score`
runs one batched forward pass per beam layer.

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
- **~19% of games are genuine stalemates.** Positions in them are honestly
  worth 0, but a fifth of the dataset carrying the least informative label is
  worth a second look.
