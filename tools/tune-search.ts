/**
 * Coordinate descent over the heuristic weights.
 *
 * Every candidate plays the same maps and the same seeds from both seats, so
 * comparisons are paired: the noise from combat luck and map choice largely
 * cancels between candidates, which matters because a single match is a very
 * loud coin flip. The yardstick stays the shipped defaults throughout rather
 * than the current best, so the score cannot drift.
 */
import { duel, rate, TRAIN_MAPS, VALIDATION_MAPS, type Score } from './tune-ai.ts';
import { DEFAULT_WEIGHTS, type HeuristicWeights } from '../src/ai/heuristic.ts';

const SEEDS = [1, 2];

const GRID: Record<keyof HeuristicWeights, number[]> = {
  counterWeight: [0.5, 0.7, 0.9, 1.1, 1.3],
  threatWeight: [0.15, 0.25, 0.35, 0.5, 0.7],
  advanceWeight: [70, 100, 140, 200, 280],
  captureWeight: [0.7, 1.0, 1.4, 2.0],
  coverWeight: [30, 60, 90, 140, 200],
  reserveFunds: [0, 1000, 3000],
};

const show = (s: Score) => `${s.wins}W ${s.losses}L ${s.draws}D  rate ${rate(s).toFixed(3)}`;

let best: HeuristicWeights = { ...DEFAULT_WEIGHTS };
let bestRate = 0.5;                       // by symmetry, the defaults tie themselves
console.log('baseline', JSON.stringify(best));

for (const pass of [1, 2]) {
  console.log(`\n=== pass ${pass} ===`);
  for (const key of Object.keys(GRID) as Array<keyof HeuristicWeights>) {
    for (const value of GRID[key]) {
      if (value === best[key]) continue;
      const candidate = { ...best, [key]: value };
      const started = Date.now();
      const score = await duel(candidate, DEFAULT_WEIGHTS, SEEDS, TRAIN_MAPS);
      const r = rate(score);
      const mark = r > bestRate ? ' <-- keep' : '';
      console.log(`${key}=${value}  ${show(score)}  (${((Date.now() - started) / 1000).toFixed(0)}s)${mark}`);
      if (r > bestRate) { bestRate = r; best = candidate; }
    }
  }
  console.log(`best after pass ${pass}: ${bestRate.toFixed(3)}`, JSON.stringify(best));
}

console.log('\nFINAL', JSON.stringify(best, null, 2), 'train rate', bestRate.toFixed(3));

// Held-out check. Weights that only win on the boards they were fitted to are
// worth nothing, so the number that counts is this one.
const holdout = await duel(best, DEFAULT_WEIGHTS, [1, 2, 3], VALIDATION_MAPS);
console.log('VALIDATION', show(holdout));
const holdoutBaseline = await duel({}, DEFAULT_WEIGHTS, [1, 2, 3], VALIDATION_MAPS);
console.log('VALIDATION mirror (must be 0.500):', show(holdoutBaseline));
