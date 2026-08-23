/**
 * Does the policy head spend its probability mass on END_TURN as plans deepen?
 *
 * The hypothesis behind the 0.188 head-to-head collapse at 1600 nodes: the
 * policy's output vocabulary includes an END_TURN slot (the final scalar in
 * every row — see tools/extract-positions.ts and train_value.py:304-307), and
 * it was trained on real play where stopping is frequently the taken action.
 * But `topActions` in src/ai/planner.ts filters endTurn out of the candidate
 * list before ranking, so whatever mass the net puts on stopping is discarded.
 * Deep in a turn — exactly where 1600 nodes goes and 200 does not — the good
 * moves are used up, the data-generating heuristic would have ended the turn,
 * and the surviving candidates are ranked by the near-zero tail of the
 * distribution, which is noise.
 *
 * This measures it directly, on real planner layers. A wrapper around the
 * planner's own PolicyOrdering records, per beam depth:
 *
 *   - p(END_TURN): the mass on the final slot;
 *   - p(best): the mass on the best-scoring candidate that survives the filter;
 *   - spread: max minus median log-probability among the surviving candidates,
 *     i.e. how much signal the ordering actually has to work with.
 *
 * If p(END_TURN) rises with depth while the spread collapses, the hypothesis
 * holds; if the spread is flat, the ordering is losing games for another reason.
 *
 *   MODEL_A=path/value.onnx NODES=1600 MAP_LIMIT=3 npx vite-node tools/diag-policy-endturn.ts
 *
 * Fog off only, and win rates are not reported: a handful of matches decides
 * nothing (SE ~0.2), while the per-layer statistics come in thousands.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import { GameEnvironment, HeuristicAgent, PlannerAgent, HeuristicEvaluator, playMatch } from '../src/ai/index.ts';
import { BudgetedValueNet, ValueNetEvaluator, type PackedPosition } from '../src/ai/onnx-evaluator.ts';
import { loadValueNet } from '../src/ai/valuenet.node.ts';
import type { PolicyOrdering } from '../src/ai/planner.ts';
import type { ActionDescriptor } from '../src/ai/actions.ts';
import type { Game as GameType } from '../src/game/game.ts';
import type { Player } from '../src/host/index.ts';
import { GameEnums } from '../src/host/index.ts';

const { registry, animations, rng } = bootstrap();

const nodeBudget = Number(process.env.NODES ?? 1600);
const mapLimit = Number(process.env.MAP_LIMIT ?? 3);
const modelPath = process.env.MODEL_A ?? process.env.MODEL ?? 'models/value.onnx';
const evaluator = await loadValueNet(modelPath);
const meta = JSON.parse(fs.readFileSync(modelPath.replace(/\.onnx$/, '') + '.json', 'utf8'));
if (!meta.actions || !meta.actionNames?.length) {
  throw new Error('model has no policy head; this diagnostic needs one');
}

interface Sample { depth: number; endMass: number; bestMass: number; spread: number; n: number }

/**
 * The planner's real policy ordering, with a tap. Same slot mapping as
 * ValueNetPolicy (kind * cells + tile, ACTION_BUILD_UNITS for builds), same
 * return value, so the search it steers is the search being diagnosed. The
 * planner calls rank exactly once per beam depth, so a per-plan call counter is
 * the depth; PlannerDiagnostics.onPlan resets it between plans.
 */
class TappedPolicy implements PolicyOrdering<PackedPosition> {
  depth = 0;
  readonly samples: Sample[] = [];
  private readonly actionIndex: Map<string, number>;
  private readonly buildIndex: number;

  constructor(private readonly net: ValueNetEvaluator, actionNames: string[]) {
    this.actionIndex = new Map(actionNames.map((name, i) => [name, i]));
    this.buildIndex = this.actionIndex.get('ACTION_BUILD_UNITS') ?? -1;
  }

  capture(game: GameType, self: Player): PackedPosition {
    return this.net.capture(game, self, null as never);
  }

  private slot(action: ActionDescriptor, width: number, cells: number): number {
    if (action.kind === 'build') {
      return this.buildIndex < 0 ? -1 : this.buildIndex * cells + action.at.y * width + action.at.x;
    }
    if (action.kind === 'unit') {
      const kind = this.actionIndex.get(action.actionId);
      return kind === undefined ? -1 : kind * cells + action.to.y * width + action.to.x;
    }
    return -1;
  }

  async rank(batch: Array<{ capture: PackedPosition; actions: ActionDescriptor[] }>): Promise<number[][]> {
    const rows = await this.net.policyRows(batch.map(entry => entry.capture));
    const out: number[][] = [];
    for (let i = 0; i < batch.length; i++) {
      const { width, height } = batch[i].capture;
      const cells = width * height;
      const row = rows[i];
      const scores = batch[i].actions.map(action => {
        const slot = this.slot(action, width, cells);
        return slot >= 0 && slot < row.length ? Number(row[slot]) : -Infinity;
      });
      const finite = scores.filter(Number.isFinite).sort((a, b) => a - b);
      if (finite.length > 0) {
        const best = finite[finite.length - 1];
        const median = finite[Math.floor(finite.length / 2)];
        this.samples.push({
          depth: this.depth,
          endMass: Math.exp(Number(row[row.length - 1])),
          bestMass: Math.exp(best),
          spread: best - median,
          n: finite.length,
        });
      }
      out.push(scores);
    }
    this.depth++;
    return out;
  }
}

const tap = new TappedPolicy(evaluator, meta.actionNames);

async function play(file: string, seat: number) {
  const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), file))), registry);
  map.getGameRules().setFogMode(GameEnums.Fog_Off);
  const game = new Game(map, registry, animations);
  map.vision.update();
  const env = new GameEnvironment(map, registry, { maxDays: 60, maxFieldChoices: 6, rng, seed: 1 }, game);
  env.reset(1);
  const planner = new PlannerAgent({
    nodeBudget, timeBudgetMs: 60_000,
    evaluator: new BudgetedValueNet(evaluator, new HeuristicEvaluator(), 36),
    policy: tap,
    diagnostics: { onPlan: () => { tap.depth = 0; } },
  });
  const agents = seat === 0
    ? [planner, new HeuristicAgent()] : [new HeuristicAgent(), planner];
  await playMatch(env, agents, { maxSteps: 6000 });
}

const allMaps: string[] = JSON.parse(fs.readFileSync(process.env.MAPS_FILE ?? 'data/heldout-maps.json', 'utf8'));
const maps = allMaps.filter((_, i) => i % Math.max(1, Math.floor(allMaps.length / mapLimit)) === 0).slice(0, mapLimit);
console.log(`model ${modelPath}, ${nodeBudget} nodes, maps: ${maps.join(', ')}`);

for (let i = 0; i < maps.length; i++) {
  tap.depth = 0;
  await play(maps[i], i % 2);
  console.log(`  ${maps[i]}: ${tap.samples.length} layer-frames so far`);
}

// Aggregate by depth; the deep tail is thin, so bucket 10+ together.
const buckets = new Map<number, { end: number; best: number; spread: number; cand: number; k: number }>();
for (const s of tap.samples) {
  const d = Math.min(s.depth, 10);
  const b = buckets.get(d) ?? { end: 0, best: 0, spread: 0, cand: 0, k: 0 };
  b.end += s.endMass; b.best += s.bestMass; b.spread += s.spread; b.cand += s.n; b.k++;
  buckets.set(d, b);
}
console.log('\ndepth   n       p(END_TURN)  p(best cand)  spread(max-med logp)  candidates');
for (const d of [...buckets.keys()].sort((a, b) => a - b)) {
  const b = buckets.get(d)!;
  console.log(`${String(d).padStart(3)}${d === 10 ? '+' : ' '}  ${String(b.k).padStart(6)}  ` +
    `${(b.end / b.k).toFixed(4).padStart(11)}  ${(b.best / b.k).toFixed(4).padStart(12)}  ` +
    `${(b.spread / b.k).toFixed(3).padStart(20)}  ${(b.cand / b.k).toFixed(1).padStart(10)}`);
}
