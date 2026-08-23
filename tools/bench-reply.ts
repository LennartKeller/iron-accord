/**
 * Does opponent-reply verification (PlannerOptions.opponentReplyActions) win
 * more games at a deep node budget? A/B against the greedy agent.
 *
 * DIRECTIONAL ONLY at the default size: 6 validation maps x 2 seats x 2 fog
 * modes is 24 matches per arm, a standard error near 0.10 — differences below
 * ~0.2 are noise here. The per-turn gap statistics in tools/diag-depth.ts are
 * the sensitive instrument; this exists to check the sign at match level
 * before anyone pays for a 64-match cell.
 *
 *   NODES=1600 REPLY=8 npx vite-node tools/bench-reply.ts
 *
 * NODES because a reproducible comparison needs a node budget, not a clock;
 * see PlannerOptions.nodeBudget. Both arms run on identical maps, seeds and
 * seats, so the arms differ only in the reply flag.
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
import { VALIDATION_MAPS } from './tune-ai.ts';

const { registry, animations, rng } = bootstrap();
const nodeBudget = Number(process.env.NODES ?? 1600);
const reply = Number(process.env.REPLY ?? 8);
const maps = VALIDATION_MAPS.slice(0, Number(process.env.MAP_LIMIT ?? VALIDATION_MAPS.length));
const fogs = [GameEnums.Fog_Off, GameEnums.Fog_OfWar];

async function duel(file: string, seed: number, seat: number, fog: number, replyActions: number) {
  const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), file))), registry);
  map.getGameRules().setFogMode(fog);
  const game = new Game(map, registry, animations);
  map.vision.update();
  const env = new GameEnvironment(map, registry, { maxDays: 60, maxFieldChoices: 6, rng, seed }, game);
  env.reset(seed);
  const planner = new PlannerAgent({
    timeBudgetMs: 3_600_000, nodeBudget, opponentReplyActions: replyActions,
  });
  const greedy = new HeuristicAgent();
  const agents = seat === 0 ? [planner, greedy] : [greedy, planner];
  const result = await playMatch(env, agents, { maxSteps: 6000 });
  return result.winner === null ? 0.5 : (result.winner === seat ? 1 : 0);
}

console.log(`${nodeBudget} nodes/turn, reply ${reply}, ${maps.length} maps, both seats, both fog modes`);
for (const [label, replyActions] of [['reply off', 0], [`reply ${reply}`, reply]] as const) {
  let points = 0, played = 0;
  for (const file of maps) {
    for (const fog of fogs) {
      for (const seat of [0, 1]) {
        points += await duel(file, 1, seat, fog, replyActions);
        played++;
      }
    }
  }
  const rate = points / played;
  const se = Math.sqrt(rate * (1 - rate) / played);
  console.log(`${label.padEnd(10)} rate ${rate.toFixed(3)} +- ${se.toFixed(3)}  n=${played}`);
}
