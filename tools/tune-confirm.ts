/**
 * Confirmatory test of a handful of pre-specified weight changes.
 *
 * The coordinate-descent search fitted 0.650 on its training maps and 0.514 on
 * held-out ones, which is the signature of a search that found noise. Rather
 * than search harder, this re-tests only the few changes that looked real, over
 * the whole suite and with more matches each, and reports the held-out subset
 * separately — a change worth having should win on both.
 */
import { duel, rate, TRAIN_MAPS, VALIDATION_MAPS, type Score } from './tune-ai.ts';
import { DEFAULT_WEIGHTS, type HeuristicWeights } from '../src/ai/heuristic.ts';

const CANDIDATES: Array<[string, Partial<HeuristicWeights>]> = [
  ['baseline (must be 0.500)', {}],
  ['threatWeight 0.25', { threatWeight: 0.25 }],
  ['coverWeight 60', { coverWeight: 60 }],
  ['captureWeight 0.7', { captureWeight: 0.7 }],
  ['search winner (all three)', { threatWeight: 0.25, coverWeight: 60, captureWeight: 0.7 }],
];

const SEEDS = [1, 2, 3];
const ALL = [...TRAIN_MAPS, ...VALIDATION_MAPS];
const show = (s: Score) => `${String(s.wins).padStart(3)}W ${String(s.losses).padStart(3)}L ` +
  `${String(s.draws).padStart(3)}D  rate ${rate(s).toFixed(3)}`;

for (const [label, weights] of CANDIDATES) {
  const all = await duel(weights, DEFAULT_WEIGHTS, SEEDS, ALL);
  const held = await duel(weights, DEFAULT_WEIGHTS, SEEDS, VALIDATION_MAPS);
  // Rough 1 s.e. on a win rate, to keep small differences in perspective.
  const se = (0.5 / Math.sqrt(all.played)).toFixed(3);
  console.log(`${label.padEnd(26)} all16 ${show(all)} (±${se})   held-out ${show(held)}`);
}
