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
import { BudgetedValueNet } from '../src/ai/onnx-evaluator.ts';
import { loadValueNet } from '../src/ai/valuenet.node.ts';
import { GameEnums } from '../src/host/index.ts';
import { TRAIN_MAPS, VALIDATION_MAPS } from './tune-ai.ts';
import type { Evaluator } from '../src/ai/evaluator.ts';

const { registry, animations, rng } = bootstrap();
const budget = Number(process.env.BUDGET_MS ?? 250);
const modelPath = process.env.MODEL ?? 'models/value.onnx';
const evaluator = await loadValueNet(modelPath);

type Side = 'net' | 'budgeted' | 'plain' | 'greedy';
const maxPerLayer = Number(process.env.MAX_PER_LAYER ?? 8);
const budgeted = new BudgetedValueNet(evaluator, new HeuristicEvaluator(), maxPerLayer);

function agentFor(side: Side) {
  if (side === 'greedy') return new HeuristicAgent();
  return new PlannerAgent({
    timeBudgetMs: budget,
    evaluator: side === 'net' ? (evaluator as Evaluator<unknown>)
      : side === 'budgeted' ? (budgeted as Evaluator<unknown>) : undefined,
  });
}

async function duel(file: string, seed: number, fog: number, left: Side, right: Side, leftSeat: number) {
  const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), file))), registry);
  map.getGameRules().setFogMode(fog);
  const game = new Game(map, registry, animations);
  map.vision.update();
  const env = new GameEnvironment(map, registry, { maxDays: 30, maxFieldChoices: 6, rng, seed }, game);
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

async function series(label: string, left: Side, right: Side, maps: string[], fogs: number[]) {
  let wins = 0, losses = 0, draws = 0, ms = 0;
  for (const file of maps) {
    for (const fog of fogs) {
      for (const seat of [0, 1]) {
        const r = await duel(file, 1, fog, left, right, seat);
        ms += r.ms;
        if (r.winner === null) draws++;
        else if (r.winner === seat) wins++;
        else losses++;
      }
    }
  }
  const played = wins + losses + draws;
  const rate = (wins + draws / 2) / played;
  console.log(`${label.padEnd(26)} ${wins}W ${losses}L ${draws}D  rate ${rate.toFixed(3)}  ` +
    `n=${played}  ${(ms / played / 1000).toFixed(1)}s/match`);
  return rate;
}

const maps = process.env.MAPS === 'all'
  ? [...TRAIN_MAPS, ...VALIDATION_MAPS]
  : VALIDATION_MAPS;
const fogs = [GameEnums.Fog_Off, GameEnums.Fog_OfWar];

console.log(`model ${modelPath}, budget ${budget}ms, ${maps.length} maps, both fog modes\n`);

// Trap 3 from the handoff: if a mirror duel is not exactly 0.500 the harness is
// biased and nothing below it means anything.
const mirror = await series('mirror (greedy v greedy)', 'greedy', 'greedy', maps, fogs);
if (Math.abs(mirror - 0.5) > 1e-9) {
  console.log(`\nHARNESS BIASED: mirror duel returned ${mirror.toFixed(3)}, expected 0.500. Stop.`);
  process.exit(1);
}

console.log('');
await series('valuenet planner v greedy', 'net', 'greedy', maps, fogs);
await series('budgeted net v greedy', 'budgeted', 'greedy', maps, fogs);
await series('plain planner v greedy', 'plain', 'greedy', maps, fogs);
