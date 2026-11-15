/**
 * Tunes the Commander Wars AI's parameters by playing it against itself.
 *
 *   node tools/evolve-normalai.ts evolve  --out runs/evolve --generations 40
 *   node tools/evolve-normalai.ts confirm --config runs/evolve/mean-040.json --seeds 4
 *
 * `evolve` is an evolution strategy. Each generation it draws mirrored
 * variations around the current parameters, plays every variation on the same
 * handful of maps and dice from both seats, and moves the parameters to the
 * weighted average of the best quarter. Half of a variation's games are against
 * the shipped profile and half against the current parameters, so progress
 * stays measurable after the shipped profile is left behind. A fixed validation
 * set against the shipped profile is replayed every generation as the progress
 * curve. It resumes from `<out>/state.json`.
 *
 * `confirm` plays one parameter file against the shipped profile (or against
 * `--against <file>`) on maps the tuning never saw: `data/heldout-maps.json`.
 * Tuning draws from `data/training-maps.json` minus those.
 *
 * Only the tunables the port reads take part. Upstream declares 126, but 20 of
 * those have a single allowed value and most of the rest belong to a production
 * system the real game no longer uses (its production runs from the script
 * tables in production-policy.ts), which leaves about thirty.
 *
 * A win counts 0.9 to 1, more the sooner it comes, and a loss 0 to 0.1, more
 * the later: a profile that wins by sitting still until day 60 is not what this
 * is for. A game that reaches the day limit counts between 0.25 and 0.75 by how
 * the two sides stand. The two seats' scores always sum to 1.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { NORMAL_AI_DEFAULTS, INI_RANGES, type NormalAiConfig } from '../src/ai/cw/config.ts';
import { GameEnums, Mulberry32 } from '../src/host/index.ts';
import type { MatchJob, MatchOutcome } from './evolve-worker.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

type Tunables = Partial<NormalAiConfig>;

// --- the search space --------------------------------------------------------

/** Source of the port, to tell which declared tunables it actually reads. */
const portSource = fs.readdirSync('src/ai/cw')
  .filter(file => file.endsWith('.ts') && file !== 'config.ts' && file !== 'ini.ts')
  .map(file => fs.readFileSync(path.join('src/ai/cw', file), 'utf8')).join('\n');

const KNOBS = INI_RANGES
  .filter(range => range.min !== range.max && new RegExp(`\\b${range.field}\\b`).test(portSource))
  .map(range => {
    // A few shipped defaults sit outside their declared range; keep them reachable.
    const shipped = NORMAL_AI_DEFAULTS[range.field];
    return {
      field: range.field,
      low: Math.min(range.min, range.max, shipped),
      high: Math.max(range.min, range.max, shipped),
    };
  });

const toUnit = (config: Tunables) => KNOBS.map(knob =>
  ((config[knob.field] ?? NORMAL_AI_DEFAULTS[knob.field]) - knob.low) / (knob.high - knob.low));
const toConfig = (point: number[]): Tunables => Object.fromEntries(KNOBS.map((knob, i) =>
  [knob.field, knob.low + Math.min(1, Math.max(0, point[i])) * (knob.high - knob.low)]));

// --- playing matches ---------------------------------------------------------

class Pool {
  private readonly idle: Worker[] = [];
  private readonly waiting: Array<(worker: Worker) => void> = [];
  private readonly pending = new Map<number, (outcome: MatchOutcome) => void>();
  private nextId = 0;
  errors = 0;

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('./evolve-worker.ts', import.meta.url));
      worker.on('message', (outcome: MatchOutcome) => {
        if (outcome.error && this.errors++ < 3) console.error(`match failed: ${outcome.error}`);
        this.pending.get(outcome.id)?.(outcome);
        this.pending.delete(outcome.id);
        const next = this.waiting.shift();
        if (next) next(worker); else this.idle.push(worker);
      });
      this.idle.push(worker);
    }
  }

  play(job: Omit<MatchJob, 'id'>): Promise<MatchOutcome> {
    const id = this.nextId++;
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      const start = (worker: Worker) => worker.postMessage({ ...job, id });
      const worker = this.idle.pop();
      if (worker) start(worker); else this.waiting.push(start);
    });
  }

  close(): void { for (const worker of this.idle) worker.postMessage('stop'); }
}

interface Setting { map: string; fog: number; seed: number }

/** What a finished match is worth to the given seat, between 0 and 1. */
function worth(outcome: MatchOutcome, seat: number, maxDays: number): number {
  if (outcome.winner === seat) return 0.9 + 0.1 * (1 - Math.min(1, outcome.days / maxDays));
  if (outcome.winner !== null) return 0.1 * Math.min(1, outcome.days / maxDays);
  const mine = outcome.standing[seat], theirs = outcome.standing[1 - seat];
  return mine + theirs > 0 ? 0.5 + 0.25 * (mine - theirs) / (mine + theirs) : 0.5;
}

interface Tally { score: number; wins: number; losses: number; draws: number; days: number; games: number }
const emptyTally = (): Tally => ({ score: 0, wins: 0, losses: 0, draws: 0, days: 0, games: 0 });

/** Plays `candidate` against `opponent` on each setting from both seats. */
async function compare(
  pool: Pool, candidate: Tunables | null, opponent: Tunables | null, settings: Setting[], maxDays: number,
  into: Tally = emptyTally(), each?: (setting: Setting, value: number) => void,
): Promise<Tally> {
  await Promise.all(settings.flatMap(setting => [0, 1].map(async seat => {
    const configs = seat === 0 ? [candidate, opponent] : [opponent, candidate];
    const outcome = await pool.play({ ...setting, maxDays, configs });
    const value = worth(outcome, seat, maxDays);
    into.score += value;
    into.games++;
    if (outcome.winner === seat) { into.wins++; into.days += outcome.days; }
    else if (outcome.winner !== null) { into.losses++; into.days += outcome.days; }
    else into.draws++;
    each?.(setting, value);
  })));
  return into;
}

const describe = (tally: Tally) => {
  const decided = tally.wins + tally.losses;
  return `${tally.wins}W ${tally.losses}L ${tally.draws}D  score ${(tally.score / tally.games).toFixed(3)}  ` +
    `decided ${(100 * decided / tally.games).toFixed(0)}% in ${decided ? (tally.days / decided).toFixed(1) : '-'} days`;
};

// --- commands ----------------------------------------------------------------

const command = process.argv[2];
const maxDays = Number(arg('maxDays', '60'));
const workers = Number(arg('workers', '0')) || Math.max(1, os.availableParallelism() - 4);
const heldOut: string[] = JSON.parse(fs.readFileSync('data/heldout-maps.json', 'utf8'));
const FOGS = [GameEnums.Fog_Off, GameEnums.Fog_OfWar];

if (command === 'evolve') {
  const out = arg('out', 'runs/evolve');
  const generations = Number(arg('generations', '40'));
  const children = Number(arg('children', '24'));
  const batch = Number(arg('batch', '16'));
  const validationSize = Number(arg('validation', '48'));
  const startSigma = Number(arg('sigma', '0.08'));
  const decay = Number(arg('decay', '0.98'));
  const trainMaps = (JSON.parse(fs.readFileSync(arg('maps', 'data/training-maps.json'), 'utf8')) as string[])
    .filter(map => !heldOut.includes(map));
  fs.mkdirSync(out, { recursive: true });

  const stateFile = path.join(out, 'state.json');
  const state: { generation: number; mean: number[]; sigma: number; knobs: string[] } = fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    : { generation: 0, mean: toUnit({}), sigma: startSigma, knobs: KNOBS.map(knob => knob.field) };
  if (state.knobs.join() !== KNOBS.map(knob => knob.field).join()) {
    throw new Error(`${stateFile} was written for a different set of tunables`);
  }

  const random = new Mulberry32(Number(arg('seed', '1')) + 7919 * state.generation);
  const gaussian = () => Math.sqrt(-2 * Math.log(1 - random.next())) * Math.cos(2 * Math.PI * random.next());
  const draw = (seedBase: number): Setting => ({
    map: trainMaps[Math.floor(random.next() * trainMaps.length)],
    fog: FOGS[Math.floor(random.next() * FOGS.length)],
    seed: seedBase + Math.floor(random.next() * 1e6),
  });
  // Fixed across generations and resumes, so the progress curve compares like with like.
  const fixed = new Mulberry32(424242);
  const validation: Setting[] = Array.from({ length: validationSize }, (_, i) => ({
    map: trainMaps[Math.floor(fixed.next() * trainMaps.length)], fog: FOGS[i % 2], seed: 9_000_001 + i,
  }));

  const pool = new Pool(workers);
  console.log(`${KNOBS.length} tunables, ${trainMaps.length} maps, ${children} variations x ${batch * 2} games, ` +
    `${workers} workers, resuming at generation ${state.generation}`);
  // Rank weights: the best of the kept quarter counts most.
  const kept = Math.max(2, Math.floor(children / 4));
  const raw = Array.from({ length: kept }, (_, i) => Math.log(kept + 0.5) - Math.log(i + 1));
  const weights = raw.map(weight => weight / raw.reduce((sum, w) => sum + w, 0));

  while (state.generation < generations) {
    const started = Date.now();
    const settings = Array.from({ length: batch }, () => draw(1));
    const points: number[][] = [];
    for (let pair = 0; pair < children / 2; pair++) {
      const step = KNOBS.map(() => state.sigma * gaussian());
      for (const sign of [1, -1]) {
        points.push(state.mean.map((value, i) => Math.min(1, Math.max(0, value + sign * step[i]))));
      }
    }
    const current = toConfig(state.mean);
    const tallies = await Promise.all(points.map(async point => {
      const tally = emptyTally();
      const candidate = toConfig(point);
      await compare(pool, candidate, null, settings.filter((_, i) => i % 2 === 0), maxDays, tally);
      await compare(pool, candidate, current, settings.filter((_, i) => i % 2 === 1), maxDays, tally);
      return tally;
    }));
    const checked = await compare(pool, current, null, validation, maxDays);

    const order = points.map((_, i) => i).sort((a, b) => tallies[b].score - tallies[a].score);
    state.mean = KNOBS.map((_, k) => order.slice(0, kept).reduce((sum, child, rank) => sum + weights[rank] * points[child][k], 0));
    state.generation++;
    state.sigma *= decay;
    fs.writeFileSync(stateFile, JSON.stringify(state));
    fs.writeFileSync(path.join(out, `mean-${String(state.generation).padStart(3, '0')}.json`),
      JSON.stringify(toConfig(state.mean), null, 1));
    const all = tallies.reduce((sum, tally) => sum + tally.score / tally.games, 0) / tallies.length;
    const line = `gen ${String(state.generation).padStart(3)}  before this step v shipped: ${describe(checked)}  |  ` +
      `variations best ${(tallies[order[0]].score / tallies[order[0]].games).toFixed(3)} mean ${all.toFixed(3)}  ` +
      `sigma ${state.sigma.toFixed(3)}  ${((Date.now() - started) / 1000).toFixed(0)}s`;
    console.log(line);
    fs.appendFileSync(path.join(out, 'log.txt'), line + '\n');
  }
  pool.close();
} else if (command === 'confirm') {
  const config: Tunables = JSON.parse(fs.readFileSync(arg('config', ''), 'utf8'));
  const againstFile = arg('against', '');
  const against: Tunables | null = againstFile ? JSON.parse(fs.readFileSync(againstFile, 'utf8')) : null;
  const maps: string[] = JSON.parse(fs.readFileSync(arg('maps', 'data/heldout-maps.json'), 'utf8'));
  const seeds = Number(arg('seeds', '4'));
  const pool = new Pool(workers);
  const byFog = new Map(FOGS.map(fog => [fog, emptyTally()]));
  const total = emptyTally();
  // One value per map, so the error bar reflects that maps, not games, are the independent unit.
  const perMap = new Map<string, { sum: number; games: number }>();
  for (const fog of FOGS) {
    const settings = maps.flatMap(map => Array.from({ length: seeds }, (_, i) => ({ map, fog, seed: 5_000_001 + i })));
    const tally = await compare(pool, config, against, settings, maxDays, byFog.get(fog)!, (setting, value) => {
      const entry = perMap.get(setting.map) ?? { sum: 0, games: 0 };
      entry.sum += value; entry.games++;
      perMap.set(setting.map, entry);
    });
    for (const key of Object.keys(total) as Array<keyof Tally>) total[key] += tally[key];
  }
  const means = [...perMap.values()].map(entry => entry.sum / entry.games);
  const mean = means.reduce((sum, value) => sum + value, 0) / means.length;
  const spread = Math.sqrt(means.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (means.length - 1) / means.length);
  console.log(`${arg('config', '')} v ${againstFile || 'shipped'}, ${maps.length} maps x ${seeds} seeds x 2 seats x 2 fog modes`);
  console.log(`all      ${describe(total)}   (+-${spread.toFixed(3)} over maps)`);
  console.log(`fog off  ${describe(byFog.get(GameEnums.Fog_Off)!)}`);
  console.log(`fog war  ${describe(byFog.get(GameEnums.Fog_OfWar)!)}`);
  const worst = [...perMap.entries()].map(([map, entry]) => ({ map, value: entry.sum / entry.games }))
    .sort((a, b) => a.value - b.value).slice(0, 3);
  console.log(`weakest maps: ${worst.map(entry => `${path.basename(entry.map, '.map')} ${entry.value.toFixed(2)}`).join(', ')}`);
  if (pool.errors > 0) console.log(`${pool.errors} matches failed and were scored as even`);
  pool.close();
} else {
  console.log('usage: node tools/evolve-normalai.ts evolve|confirm [options]  (see the header comment)');
  process.exit(1);
}
process.exit(0);
