/**
 * Planner vs heuristic, on the benchmark suite, in both fog modes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import { GameEnvironment, HeuristicAgent, PlannerAgent, playMatch } from '../src/ai/index.ts';
import { GameEnums } from '../src/host/index.ts';
import { TRAIN_MAPS, VALIDATION_MAPS } from './tune-ai.ts';

const { registry, animations, rng } = bootstrap();
const budget = Number(process.env.BUDGET_MS ?? 400);

async function duel(file: string, seed: number, plannerSeat: number, fog: number) {
  const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), file))), registry);
  map.getGameRules().setFogMode(fog);
  const game = new Game(map, registry, animations);
  map.vision.update();
  const env = new GameEnvironment(map, registry, { maxDays: 30, maxFieldChoices: 6, rng, seed }, game);
  env.reset(seed);
  const planner = new PlannerAgent({ timeBudgetMs: budget });
  const greedy = new HeuristicAgent();
  const agents = plannerSeat === 0 ? [planner, greedy] : [greedy, planner];
  const started = Date.now();
  const result = await playMatch(env, agents, { maxSteps: 6000 });
  return { result, ms: Date.now() - started };
}

const MAPS = (process.env.MAPS === 'all' ? [...TRAIN_MAPS, ...VALIDATION_MAPS] : TRAIN_MAPS.slice(0, 6));
for (const [label, fog] of [['fog off', GameEnums.Fog_Off], ['fog of war', GameEnums.Fog_OfWar]] as const) {
  let wins = 0, losses = 0, draws = 0, ms = 0;
  for (const file of MAPS) {
    for (const seat of [0, 1]) {
      const { result, ms: took } = await duel(file, 1, seat, fog);
      ms += took;
      if (result.winner === null) draws++;
      else if (result.winner === seat) wins++;
      else losses++;
    }
  }
  const played = wins + losses + draws;
  console.log(`${label.padEnd(11)} planner ${wins}W ${losses}L ${draws}D  ` +
    `rate ${((wins + draws / 2) / played).toFixed(3)}  ${(ms / 1000).toFixed(0)}s total, ` +
    `${(ms / played / 1000).toFixed(1)}s/match`);
}
