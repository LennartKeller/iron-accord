/**
 * The current heuristic against the one from before the navigation and
 * transport work, over the new suite, split naval/land.
 *
 * Split because the change is aimed squarely at water: if it helps at sea and
 * hurts on land, one overall number would hide both facts.
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

async function suite(label: string, maps: string[]) {
  let wins = 0, losses = 0, draws = 0, captures = 0, legacyCaptures = 0, days = 0;
  for (const file of maps) {
    for (const seat of [0, 1]) {
      const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), file))), registry);
      const game = new Game(map, registry, animations);
      const env = new GameEnvironment(map, registry, { maxDays: 30, maxFieldChoices: 6, rng, seed: 1 }, game);
      env.reset(1);
      const agents = seat === 0
        ? [new HeuristicAgent(), new LegacyHeuristicAgent()]
        : [new LegacyHeuristicAgent(), new HeuristicAgent()];
      const result = await playMatch(env, agents, {
        maxSteps: 6000,
        onStep: (_s, action, player) => {
          if (action.kind === 'unit' && action.actionId === 'ACTION_CAPTURE') {
            if (player === seat) captures++; else legacyCaptures++;
          }
        },
      });
      days += result.days;
      if (result.winner === null) draws++;
      else if (result.winner === seat) wins++;
      else losses++;
    }
  }
  const played = wins + losses + draws;
  console.log(`${label.padEnd(6)} ${wins}W ${losses}L ${draws}D  rate ${((wins + draws / 2) / played).toFixed(3)}` +
    `  captures new ${captures} vs legacy ${legacyCaptures}  avg day ${(days / played).toFixed(1)}`);
}

await suite('naval', NAVAL_MAPS);
await suite('land', LAND_MAPS);
