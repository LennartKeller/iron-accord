/**
 * What does policy move-ordering change about the plans the search adopts?
 *
 * tools/diag-policy-endturn.ts refuted the discarded-stop-mass hypothesis:
 * p(END_TURN) falls with beam depth (0.027 at depth 0 to 0.0008 at 10+) and
 * the surviving candidates keep a healthy spread, so the 1600-node collapse of
 * the policy-guided planner (0.320 v greedy, 0.188 head-to-head against the
 * same net without the policy) is not explained by ranking noise deep in a
 * turn. The remaining suspects live at the plan level: the policy shares its
 * trunk with the value head, so the moves it proposes are correlated with the
 * value net's errors, and an argmax over correlated-error candidates adopts
 * exactly the plans the evaluator overprices — a winner's curse the greedy
 * ordering (independent errors) does not compound.
 *
 * So this compares, at the same node budget and evaluator, with and without
 * the policy ordering: adopted plan length, depth searched, broken-plan rate,
 * and the realized per-turn progress in hand-priced funds (reference score at
 * the next turn start minus at this one, the same fresh-Belief fog-off
 * measurement diag-depth.ts uses). If the policy runs adopt longer plans that
 * deliver less real progress, the correlated-selection story holds.
 *
 *   MODEL_A=path/value.onnx NODES=1600 MAP_LIMIT=3 npx vite-node tools/diag-policy-plans.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import {
  GameEnvironment, HeuristicAgent, PlannerAgent, HeuristicEvaluator, Belief, playMatch,
} from '../src/ai/index.ts';
import { BudgetedValueNet, ValueNetPolicy } from '../src/ai/onnx-evaluator.ts';
import { loadValueNet } from '../src/ai/valuenet.node.ts';
import { GameEnums } from '../src/host/index.ts';

const { registry, animations, rng } = bootstrap();

const nodeBudget = Number(process.env.NODES ?? 1600);
const mapLimit = Number(process.env.MAP_LIMIT ?? 3);
const modelPath = process.env.MODEL_A ?? process.env.MODEL ?? 'models/value.onnx';
const evaluator = await loadValueNet(modelPath);
const meta = JSON.parse(fs.readFileSync(modelPath.replace(/\.onnx$/, '') + '.json', 'utf8'));
const policy = new ValueNetPolicy(evaluator, meta.actionNames);

const reference = new HeuristicEvaluator();
function scoreNow(game: Game, seat: number): number | undefined {
  const player = game.map.getPlayer(seat);
  if (!player) return undefined;
  const belief = new Belief(player);
  belief.observe(game);
  return reference.score([reference.capture(game, player, belief)])[0];
}

interface TurnRecord {
  planLength: number;
  depthSearched: number;
  openingRef?: number;
  nextRef?: number;
  broken: boolean;
}

async function playOne(file: string, seat: number, usePolicy: boolean) {
  const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), file))), registry);
  map.getGameRules().setFogMode(GameEnums.Fog_Off);
  const game = new Game(map, registry, animations);
  map.vision.update();
  const env = new GameEnvironment(map, registry, { maxDays: 60, maxFieldChoices: 6, rng, seed: 1 }, game);
  env.reset(1);

  const records: TurnRecord[] = [];
  let current: TurnRecord | null = null;
  let previous: TurnRecord | null = null;
  const planner = new PlannerAgent({
    timeBudgetMs: 3_600_000, nodeBudget,
    evaluator: new BudgetedValueNet(evaluator, new HeuristicEvaluator(), 36),
    policy: usePolicy ? policy : undefined,
    diagnostics: {
      onPlan: info => {
        const record: TurnRecord = {
          planLength: info.planLength, depthSearched: info.depthSearched,
          openingRef: scoreNow(game, seat), broken: false,
        };
        records.push(record);
        previous = current;
        current = record;
      },
      onPlanBroken: () => { if (current) current.broken = true; },
    },
  });
  const agents = seat === 0
    ? [planner, new HeuristicAgent()] : [new HeuristicAgent(), planner];
  let prevPlayer = -1;
  const result = await playMatch(env, agents, {
    maxSteps: 6000,
    onStep: (_step, _action, player) => {
      // First planner action of a new turn: the opponent has replied, so this
      // is "reality" for the PREVIOUS record (onPlan already rotated it).
      if (player === seat && previous && previous.nextRef === undefined
          && prevPlayer !== -1 && prevPlayer !== seat) {
        previous.nextRef = scoreNow(game, seat);
      }
      prevPlayer = player;
    },
  });
  return { records, result };
}

function mean(xs: number[]) { return xs.reduce((a, b) => a + b, 0) / (xs.length || 1); }
function sem(xs: number[]) {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1) / xs.length);
}

const allMaps: string[] = JSON.parse(fs.readFileSync(process.env.MAPS_FILE ?? 'data/heldout-maps.json', 'utf8'));
const maps = allMaps.filter((_, i) => i % Math.max(1, Math.floor(allMaps.length / mapLimit)) === 0).slice(0, mapLimit);
console.log(`model ${modelPath}, ${nodeBudget} nodes, maps: ${maps.join(', ')}`);

for (const usePolicy of [false, true]) {
  const all: TurnRecord[] = [];
  let w = 0, l = 0, d = 0;
  for (let i = 0; i < maps.length; i++) {
    const { records, result } = await playOne(maps[i], i % 2, usePolicy);
    all.push(...records);
    if (result.winner === null) d++;
    else if (result.winner === i % 2) w++;
    else l++;
  }
  const complete = all.filter(r => r.openingRef !== undefined && r.nextRef !== undefined);
  const progress = complete.map(r => r.nextRef! - r.openingRef!);
  const lengths = all.map(r => r.planLength);
  const long = all.filter(r => r.planLength >= 7).length;
  console.log(`\n=== ${usePolicy ? 'policy' : 'greedy'} ordering, ${nodeBudget} nodes ===`);
  console.log(`context only (noise at this n): ${w}W ${l}L ${d}D over ${maps.length} matches`);
  console.log(`turns ${all.length}, plan length ${mean(lengths).toFixed(2)} +- ${sem(lengths).toFixed(2)}` +
    `, >=7 actions: ${(100 * long / all.length).toFixed(1)}%` +
    `, depth searched ${mean(all.map(r => r.depthSearched)).toFixed(1)}`);
  console.log(`broken plans ${all.filter(r => r.broken).length}/${all.length}`);
  console.log(`realized progress per turn (hand funds, n=${progress.length}): ` +
    `${mean(progress).toFixed(0)} +- ${sem(progress).toFixed(0)}`);
}
