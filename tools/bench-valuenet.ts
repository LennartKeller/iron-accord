/**
 * The value net actually playing, which is the only test that counts.
 *
 * Rank correlation on stored positions says the net orders positions better
 * than the hand-priced evaluation. It does not say the planner wins more games
 * with it, so this plays the matches.
 *
 *   npx vite-node tools/bench-valuenet.ts
 *   MAPS=all BUDGET_MS=800 npx vite-node tools/bench-valuenet.ts
 *
 * Two models can be compared directly, which is the only way to settle a
 * question like wdl-versus-scalar: held-out rank correlation says which orders
 * stored positions better, and that is not the same claim as winning games.
 *
 *   MODEL_A=a/value.onnx MODEL_B=b/value.onnx npx vite-node tools/bench-valuenet.ts
 *
 * The mirror check runs first: identical agents from both seats must come out at
 * exactly 0.500, or the harness is biased and every number below it is noise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import { GameEnvironment, HeuristicAgent, PlannerAgent, HeuristicEvaluator, playMatch } from '../src/ai/index.ts';
import { DEFAULT_PLANNER_OPTIONS } from '../src/ai/planner.ts';
import { BudgetedValueNet, ValueNetPolicy } from '../src/ai/onnx-evaluator.ts';
import fsSync from 'node:fs';
import { loadValueNet } from '../src/ai/valuenet.node.ts';
import { GameEnums } from '../src/host/index.ts';
import { TRAIN_MAPS, VALIDATION_MAPS } from './tune-ai.ts';
import type { Evaluator } from '../src/ai/evaluator.ts';

const { registry, animations, rng } = bootstrap();
const budget = Number(process.env.BUDGET_MS ?? 250);
/**
 * NODES makes a comparison reproducible; BUDGET_MS makes it depend on the load.
 * Prefer NODES whenever two models are being ranked against each other.
 */
const nodeBudget = Number(process.env.NODES ?? 0);
/** Winner's-curse guard; see PlannerOptions.selectionSigmas. 0 is the old argmax. */
const selectionSigmas = Number(process.env.SIGMAS ?? 0);
/**
 * REPLY=N re-scores an adopted plan after N greedy opponent actions.
 *
 * The search expands only the acting player's moves, so a deep plan is scored
 * against a frozen enemy and overpromises by ~13k funds once the opponent
 * actually replies — measured, and the single depth-dependent pathology
 * instrumentation found. See PlannerOptions.opponentReplyActions.
 */
const replyActions = Number(process.env.REPLY ?? DEFAULT_PLANNER_OPTIONS.opponentReplyActions);
/**
 * The policy-ordering repair options, for A/B-ing the 1600-node collapse
 * (policy+net v net alone fell to 0.188 at 1600 nodes while neutral at 200).
 * POLICY_ENDTURN=1 lets the policy's END_TURN ranking truncate a frame's
 * expansion; POLICY_FLOOR=p falls back to greedy ordering when the best
 * candidate's probability is below p; POLICY_MAXDEPTH=n limits the policy to
 * the first n beam layers, greedy beyond. See the PlannerOptions doc comments
 * for what tools/diag-policy-endturn.ts measured about each.
 */
const policyEndTurn = Number(process.env.POLICY_ENDTURN ?? 0) > 0;
const policyGreedyFloor = Number(process.env.POLICY_FLOOR ?? 0);
const policyMaxDepth = Number(process.env.POLICY_MAXDEPTH ?? 0);
const modelPath = process.env.MODEL_A ?? process.env.MODEL ?? 'models/value.onnx';
const evaluator = await loadValueNet(modelPath);
/** Optional second model, for a head-to-head between two trained nets. */
const modelPathB = process.env.MODEL_B ?? '';
const evaluatorB = modelPathB ? await loadValueNet(modelPathB) : null;

type Side = 'net' | 'budgeted' | 'netB' | 'budgetedB' | 'plain' | 'greedy' | 'policy';

/**
 * The policy-guided planner: the net picks which moves to search, not just how
 * to score them.
 *
 * Without it `topActions` ranks candidates with `HeuristicAgent.scoreFor`, so
 * the beam only ever expands moves the hand-priced evaluation liked and a move
 * it misprices is never searched at all — the value net could only re-rank
 * someone else's shortlist. Available when MODEL_A was trained with --policy 1.
 */
function policyFor(path: string, evaluator: Awaited<ReturnType<typeof loadValueNet>>) {
  const metaPath = path.replace(/\.onnx$/, '') + '.json';
  const meta = JSON.parse(fsSync.readFileSync(metaPath, 'utf8'));
  if (!meta.actions || !meta.actionNames?.length) return null;
  return new ValueNetPolicy(evaluator, meta.actionNames);
}
/**
 * Big enough to cover a whole beam layer natively, which 8 was not.
 *
 * A layer is at most beamWidth x branching = 36 candidates (planner.ts:25-26),
 * and those 36 were already narrowed from the legal moves by the greedy scorer
 * in `topActions`. Capping the net at 8 on top of that left it reordering an
 * eight-item shortlist the hand-priced evaluation had chosen — so any move that
 * evaluation misprices, which is the entire diagnosed failure, never reached
 * the net at all, and a Phase 4 scaling test would not have been testing it.
 * 36 x ~1.25 ms is about 45 ms per layer, affordable at a 250-800 ms budget.
 * The tight cut is a wasm concession (valuenet.web.ts) and belongs only there.
 */
const maxPerLayer = Number(process.env.MAX_PER_LAYER ?? 36);
const budgeted = new BudgetedValueNet(evaluator, new HeuristicEvaluator(), maxPerLayer);
const policy = policyFor(modelPath, evaluator);
const budgetedB = evaluatorB
  ? new BudgetedValueNet(evaluatorB, new HeuristicEvaluator(), maxPerLayer) : null;

function evaluatorFor(side: Side): Evaluator<unknown> | undefined {
  if (side === 'net') return evaluator as Evaluator<unknown>;
  if (side === 'budgeted') return budgeted as Evaluator<unknown>;
  if (side === 'netB') return evaluatorB as Evaluator<unknown>;
  if (side === 'budgetedB') return budgetedB as Evaluator<unknown>;
  return undefined;  // 'plain' searches on the hand-priced score.
}

function agentFor(side: Side) {
  if (side === 'greedy') return new HeuristicAgent();
  return new PlannerAgent({
    timeBudgetMs: budget, nodeBudget, selectionSigmas, opponentReplyActions: replyActions,
    policyEndTurn, policyGreedyFloor, policyMaxDepth,
    evaluator: evaluatorFor(side === 'policy' ? 'budgeted' : side),
    policy: side === 'policy' ? policy ?? undefined : undefined,
  });
}

async function duel(file: string, seed: number, fog: number, left: Side, right: Side, leftSeat: number) {
  const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), file))), registry);
  map.getGameRules().setFogMode(fog);
  const game = new Game(map, registry, animations);
  map.vision.update();
  // 60 to match the day cap the training labels were generated at; at 30 a win
  // the net was taught to expect on day 45 scores here as a draw.
  const env = new GameEnvironment(map, registry, { maxDays: 60, maxFieldChoices: 6, rng, seed }, game);
  // The script RNG is process-wide; without a reset per match the previous
  // match's combat luck carries into this one.
  env.reset(seed);
  const agents = leftSeat === 0
    ? [agentFor(left), agentFor(right)]
    : [agentFor(right), agentFor(left)];
  const started = Date.now();
  const result = await playMatch(env, agents, { maxSteps: 6000 });
  return { winner: result.winner, leftSeat, ms: Date.now() - started };
}

/**
 * Fog modes are reported separately as well as pooled.
 *
 * The encoder is current-vision-only and the net never sees `Belief`, so under
 * fog the value of an observation is not the value of the position, and a
 * maximiser is rewarded for moving enemies out of sight — it raises the encoded
 * score without improving anything. That failure would be invisible in a pooled
 * number: a strong fog-off result can carry a broken fog-on one. If a model
 * gains with search in fog off but not in fog of war, the missing piece is
 * belief channels, not more training.
 */
async function series(label: string, left: Side, right: Side, maps: string[], fogs: number[]) {
  const tally = new Map<number, { wins: number; losses: number; draws: number; ms: number }>();
  for (const fog of fogs) tally.set(fog, { wins: 0, losses: 0, draws: 0, ms: 0 });

  for (const file of maps) {
    for (const fog of fogs) {
      for (const seat of [0, 1]) {
        const r = await duel(file, 1, fog, left, right, seat);
        const t = tally.get(fog)!;
        t.ms += r.ms;
        if (r.winner === null) t.draws++;
        else if (r.winner === seat) t.wins++;
        else t.losses++;
      }
    }
  }

  let wins = 0, losses = 0, draws = 0, ms = 0;
  for (const t of tally.values()) {
    wins += t.wins; losses += t.losses; draws += t.draws; ms += t.ms;
  }
  const played = wins + losses + draws;
  const rate = (wins + draws / 2) / played;
  const split = fogs.map(fog => {
    const t = tally.get(fog)!;
    const n = t.wins + t.losses + t.draws;
    const name = fog === GameEnums.Fog_Off ? 'off' : 'war';
    return `${name} ${((t.wins + t.draws / 2) / n).toFixed(3)}`;
  }).join('  ');
  console.log(`${label.padEnd(26)} ${wins}W ${losses}L ${draws}D  rate ${rate.toFixed(3)}  ` +
    `[fog ${split}]  n=${played}  ${(ms / played / 1000).toFixed(1)}s/match`);
  return rate;
}

/**
 * MAPS_FILE points at a JSON map list, which is how a comparison gets enough
 * held-out boards to mean anything.
 *
 * Seeds barely vary a match, so significance comes from maps and nothing else:
 * six maps is 24 matches per series and a standard error near 0.1, which cannot
 * separate two nets that differ by less than that. A net trained on the
 * benchmark suite has never seen the wide training pool, so that list doubles
 * as a large held-out set. MAP_LIMIT takes an evenly spaced subset, because
 * every extra map costs four matches in every series.
 */
const mapsFile = process.env.MAPS_FILE ?? '';
let maps: string[];
if (mapsFile) {
  const all: string[] = JSON.parse(fs.readFileSync(mapsFile, 'utf8'));
  const limit = Number(process.env.MAP_LIMIT ?? 0) || all.length;
  const stride = Math.max(1, Math.floor(all.length / limit));
  maps = all.filter((_, i) => i % stride === 0).slice(0, limit);
} else {
  maps = process.env.MAPS === 'all' ? [...TRAIN_MAPS, ...VALIDATION_MAPS] : VALIDATION_MAPS;
}
const fogs = [GameEnums.Fog_Off, GameEnums.Fog_OfWar];

console.log(`model A ${modelPath}${modelPathB ? `\nmodel B ${modelPathB}` : ''}`);
console.log(`${nodeBudget > 0 ? `${nodeBudget} nodes/turn (reproducible)` : `${budget}ms/turn (load-dependent)`}` +
  `, maxPerLayer ${maxPerLayer}, sigmas ${selectionSigmas}, reply ${replyActions}, ` +
  `${maps.length} maps, both fog modes\n`);

// Trap 3 from the handoff: if a mirror duel is not exactly 0.500 the harness is
// biased and nothing below it means anything.
const mirror = await series('mirror (greedy v greedy)', 'greedy', 'greedy', maps, fogs);
if (Math.abs(mirror - 0.5) > 1e-9) {
  console.log(`\nHARNESS BIASED: mirror duel returned ${mirror.toFixed(3)}, expected 0.500. Stop.`);
  process.exit(1);
}

/**
 * ONLY=policy runs just the mirror check and the two policy series; ONLY=h2h
 * narrows further to the mirror and the head-to-head. An A/B of a
 * move-ordering option leaves the net-alone and plain-planner baselines
 * untouched — nothing in those agents reads the ordering options — and at
 * 1600 nodes each skipped series costs hours of machine time. The mirror
 * always runs: it is the harness bias check everything else rests on.
 */
const onlyPolicy = process.env.ONLY === 'policy' || process.env.ONLY === 'h2h';
const onlyH2h = process.env.ONLY === 'h2h';
/**
 * ONLY=value skips the policy series entirely.
 *
 * For measuring the value head's depth curve, where the policy comparisons are
 * pure cost: `policy+net v net alone` runs two searching agents against each
 * other, so at 3200 nodes it is several hours on its own.
 */
const onlyValue = process.env.ONLY === 'value';

console.log('');
if (!onlyPolicy) await series('A: net v greedy', 'budgeted', 'greedy', maps, fogs);
if (evaluatorB && !onlyPolicy) {
  await series('B: net v greedy', 'budgetedB', 'greedy', maps, fogs);
  // The head-to-head. Rate is from A's point of view: above 0.500 means A wins.
  await series('A v B (head to head)', 'budgeted', 'budgetedB', maps, fogs);
}
if (policy && !onlyValue) {
  if (!onlyH2h) await series('policy+net v greedy', 'policy', 'greedy', maps, fogs);
  // The one comparison that isolates move ordering: same evaluator, same
  // budget, the only difference being who chooses what to search.
  await series('policy+net v net alone', 'policy', 'budgeted', maps, fogs);
}
if (!onlyPolicy) await series('plain planner v greedy', 'plain', 'greedy', maps, fogs);
