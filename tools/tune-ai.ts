/**
 * Weight tuning for the heuristic agent.
 *
 * Strength is measured by playing a candidate against the current defaults from
 * both seats over a set of maps and seeds — beating the random agent saturated
 * long ago, so the incumbent is the yardstick. Every match is seeded, so a
 * score can be reproduced exactly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import { GameEnvironment, HeuristicAgent, playMatch } from '../src/ai/index.ts';
import { DEFAULT_WEIGHTS, type HeuristicWeights } from '../src/ai/heuristic.ts';

const { registry, animations, rng } = bootstrap();

/**
 * The benchmark suite, chosen by tools/survey-maps.ts from 144 two-player maps.
 *
 * A map earns a place only if it resolves inside the day cap AND both sides own
 * production, because a suite without factories measures tactics with a fixed
 * army and nothing else. The first version of this list was drawn entirely from
 * maps/pre_deployed — where, as the category name says, armies are pre-deployed
 * — so twelve of its sixteen maps offered no build action at all and both
 * agents banked six figures of unspendable funds.
 *
 * Naval and land maps are listed separately and mixed into both splits, so a
 * change that only helps on dry land cannot quietly pass.
 */
export const NAVAL_MAPS = [
  'maps/2_player/Burger Isle.map',
  'maps/pre_deployed/8-Bridge Isles.map',
  'maps/2_player/NORTH STAR.map',
  'maps/2_player/Snowflake.map',
  'maps/2_player/Frigid Finale.map',
  'maps/2_player/Mouse Island.map',
  'maps/2_player/Fist Peninsula.map',
  'maps/2_player/MELON LAND.map',
];

export const LAND_MAPS = [
  'maps/2_player/Feline Basin.map',
  'maps/2_player/Plug Mountain.map',
  'maps/2_player/Basin Forest.map',
  'maps/2_player/Dual River.map',
  'maps/2_player/Precipitation.map',
  'maps/2_player/Metro Map.map',
  'maps/2_player/SABRE RANGE.map',
  'maps/2_player/Center River.map',
  'maps/2_player/Spectacle Map.map',
  'maps/2_player/Marengo.map',
];

export const TRAIN_MAPS = [...NAVAL_MAPS.slice(0, 5), ...LAND_MAPS.slice(0, 7)];
export const VALIDATION_MAPS = [...NAVAL_MAPS.slice(5), ...LAND_MAPS.slice(7)];

export const MAPS = TRAIN_MAPS;

function load(file: string, seed: number) {
  const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), file))), registry);
  const game = new Game(map, registry, animations);
  const env = new GameEnvironment(map, registry, { maxDays: 30, maxFieldChoices: 6, rng, seed }, game);
  // The script RNG is shared across the process, so combat luck leaks from one
  // match into the next unless every match reseeds it.
  env.reset(seed);
  return env;
}

export interface Score { wins: number; losses: number; draws: number; played: number; days: number }

/** Plays `candidate` against `baseline` on every map and seed, from both seats. */
export async function duel(
  candidate: Partial<HeuristicWeights>, baseline: HeuristicWeights, seeds: number[], maps = MAPS,
): Promise<Score> {
  const score: Score = { wins: 0, losses: 0, draws: 0, played: 0, days: 0 };
  for (const file of maps) {
    for (const seed of seeds) {
      for (const seat of [0, 1]) {
        const env = load(file, seed);
        const challenger = new HeuristicAgent(candidate, 'candidate');
        const incumbent = new HeuristicAgent(baseline, 'baseline');
        const agents = seat === 0 ? [challenger, incumbent] : [incumbent, challenger];
        const result = await playMatch(env, agents, { maxSteps: 6000 });
        score.played += 1;
        score.days += result.days;
        if (result.winner === null) score.draws += 1;
        else if (result.winner === seat) score.wins += 1;
        else score.losses += 1;
      }
    }
  }
  return score;
}

/** Wins plus half the draws, as a fraction — the usual head-to-head score. */
export const rate = (s: Score) => (s.wins + s.draws / 2) / Math.max(1, s.played);

// Importing this module must not play anything; tune-search.ts drives it.
