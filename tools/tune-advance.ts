/**
 * Re-calibrating advanceWeight after the switch to movement-cost distances.
 *
 * advanceWeight was fitted when progress was measured in Manhattan *tiles*.
 * The navigator reports movement *cost*, where a mountain is dearer than a
 * plain and costs differ per movement type, so the same weight now buys a
 * different amount of aggression. This tests the weight against the agent as
 * it stood before the change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import { GameEnvironment, HeuristicAgent, playMatch } from '../src/ai/index.ts';
import { LegacyHeuristicAgent } from './legacy-heuristic.ts';
import { NAVAL_MAPS, LAND_MAPS } from './tune-ai.ts';

const { registry, animations, rng } = bootstrap();
const MAPS = [...NAVAL_MAPS, ...LAND_MAPS];

/** Which half of the change is responsible: the navigator, or transport scoring? */
const CONFIGS: Array<[string, { transportWeight?: number }]> = [
  ['navigator only (transport 0)', { transportWeight: 0 }],
  ['navigator + transport', { transportWeight: 1 }],
  ['navigator + transport x2', { transportWeight: 2 }],
];

for (const [label, override] of CONFIGS) {
  let wins = 0, losses = 0, draws = 0, captures = 0;
  for (const file of MAPS) {
    for (const seat of [0, 1]) {
      const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), file))), registry);
      const game = new Game(map, registry, animations);
      const env = new GameEnvironment(map, registry, { maxDays: 30, maxFieldChoices: 6, rng, seed: 1 }, game);
      env.reset(1);
      const fresh = new HeuristicAgent(override);
      const agents = seat === 0 ? [fresh, new LegacyHeuristicAgent()] : [new LegacyHeuristicAgent(), fresh];
      const result = await playMatch(env, agents, {
        maxSteps: 6000,
        onStep: (_s, a, p) => {
          if (a.kind === 'unit' && a.actionId === 'ACTION_CAPTURE' && p === seat) captures++;
        },
      });
      if (result.winner === null) draws++;
      else if (result.winner === seat) wins++;
      else losses++;
    }
  }
  const played = wins + losses + draws;
  console.log(`${label.padEnd(30)} ${wins}W ${losses}L ${draws}D  ` +
    `rate ${((wins + draws / 2) / played).toFixed(3)}  captures ${captures}`);
}
