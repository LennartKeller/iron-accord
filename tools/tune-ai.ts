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
 * Maps that actually produce a winner, found by tools/survey-maps.ts: of 34
 * two-player boards, 16 resolve inside the day cap and the rest stall out at
 * half a point each, which is wall clock spent on no information.
 *
 * Split so weights cannot simply be fitted to the boards they were chosen on.
 */
export const TRAIN_MAPS = [
  'maps/pre_deployed/8-Bridge Isles.map',
  'maps/pre_deployed/Crosspaths.map',
  'maps/pre_deployed/Desert Duel.map',
  'maps/pre_deployed/Hourglass.map',
  'maps/pre_deployed/Missile.map',
  'maps/pre_deployed/Pentagram.map',
  'maps/pre_deployed/Resistance.map',
  'maps/pre_deployed/Triangle Lake.map',
  'maps/pre_deployed/UFO.map',
  'maps/pre_deployed/Wrench Island.map',
];

export const VALIDATION_MAPS = [
  'maps/pre_deployed/Bundle City.map',
  'maps/pre_deployed/Chessboard.map',
  'maps/pre_deployed/Liaison Wood.map',
  'maps/pre_deployed/Mint Plateau.map',
  'maps/pre_deployed/Narrow Ridge.map',
  'maps/pre_deployed/Trifecta Isles.map',
];

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
