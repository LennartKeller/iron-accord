/**
 * Position-weight sweep for the planner.
 *
 * Searching harder made the planner weaker, which means the thing it optimises
 * does not correspond to winning. The prime suspect is the balance between
 * hiding and advancing: exposure charges 0.3 of a unit's cost for standing in
 * threat — 2100 funds for a heavy tank — while advancing a tile toward the
 * objective is worth 110. Deeper search then buys ever-safer, ever-more-useless
 * positions. These configurations test that directly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import { GameEnvironment, HeuristicAgent, PlannerAgent, playMatch } from '../src/ai/index.ts';
import { DEFAULT_POSITION_WEIGHTS, type PositionWeights } from '../src/ai/position.ts';
import { TRAIN_MAPS, VALIDATION_MAPS } from './tune-ai.ts';

const { registry, animations, rng } = bootstrap();
const MAPS = [...TRAIN_MAPS, ...VALIDATION_MAPS];

const CONFIGS: Array<[string, Partial<PositionWeights>]> = [
  ['as built', {}],
  ['exposure 0.10', { exposure: 0.10 }],
  ['exposure 0.03', { exposure: 0.03 }],
  ['exposure 0.10, objective 260', { exposure: 0.10, objective: 260 }],
  ['exposure 0.03, objective 260', { exposure: 0.03, objective: 260 }],
];

for (const [label, override] of CONFIGS) {
  const position: PositionWeights = { ...DEFAULT_POSITION_WEIGHTS, ...override };
  let wins = 0, losses = 0, draws = 0;
  for (const file of MAPS) {
    for (const seat of [0, 1]) {
      const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), file))), registry);
      const game = new Game(map, registry, animations);
      const env = new GameEnvironment(map, registry, { maxDays: 30, maxFieldChoices: 6, rng, seed: 1 }, game);
      env.reset(1);
      const planner = new PlannerAgent({ timeBudgetMs: 150, position });
      const agents = seat === 0 ? [planner, new HeuristicAgent()] : [new HeuristicAgent(), planner];
      const result = await playMatch(env, agents, { maxSteps: 6000 });
      if (result.winner === null) draws++;
      else if (result.winner === seat) wins++;
      else losses++;
    }
  }
  const played = wins + losses + draws;
  console.log(`${label.padEnd(30)} ${wins}W ${losses}L ${draws}D  rate ${((wins + draws / 2) / played).toFixed(3)}`);
}
