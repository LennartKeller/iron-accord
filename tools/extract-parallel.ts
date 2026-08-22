/**
 * Runs `extract-positions.ts` across many cores by splitting the map list.
 *
 * Extraction replays every game to re-derive its positions, which is the same
 * simulation cost self-play already pays — but `extract-positions.ts` is one
 * JS thread, so a 50k-game file took 67 minutes on a 32-core machine.
 *
 * It parallelises on maps rather than on games, for two reasons. The script RNG
 * is process-wide and every replay calls `env.reset(seed)`, so two replays
 * interleaved inside one process would corrupt each other's combat luck —
 * separate processes each get their own `bootstrap()` and sidestep that
 * entirely. And shards are already per map, so a map set is a set of output
 * files: disjoint partitions never touch the same shard, and the only thing
 * left to merge is the manifest.
 *
 * Each part re-reads the input file and skips replays outside its own maps.
 * That decompresses the input once per worker, which sounds wasteful and is
 * not: gunzip runs at hundreds of MB/s against minutes of simulation.
 *
 *   node tools/extract-parallel.ts --in data/train-wide.jsonl.gz \
 *     --out data/positions-wide --only data/training-maps.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const inFile = arg('in', 'data/train-wide.jsonl.gz');
const outDir = arg('out', 'data/positions');
const onlyFile = arg('only', 'data/training-maps.json');
const workers = Number(arg('workers', '0')) || Math.max(1, os.availableParallelism() - 2);
/** Passed through untouched, so this stays a scheduler and nothing else. */
const passthrough = ['perTurn', 'every', 'gamma', 'shardSize', 'baseline', 'split', 'valFraction'];

const maps: string[] = JSON.parse(fs.readFileSync(onlyFile, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });

// Round-robin rather than contiguous slices: the map list is sorted by name,
// and neighbouring names are often the same size and style of board, so
// contiguous chunks would hand one worker all the big slow ones.
const parts: string[][] = Array.from({ length: Math.min(workers, maps.length) }, () => []);
maps.forEach((map, i) => parts[i % parts.length].push(map));

const started = Date.now();
console.log(`${maps.length} maps across ${parts.length} workers`);

await Promise.all(parts.map((part, index) => new Promise<void>((resolve, reject) => {
  const listFile = path.join(outDir, `.part-${index}.maps.json`);
  fs.writeFileSync(listFile, JSON.stringify(part));
  const args = [
    'tools/extract-positions.ts',
    '--in', inFile, '--out', outDir,
    '--only', listFile,
    '--manifestName', `.manifest.part-${index}.json`,
  ];
  for (const name of passthrough) {
    const value = arg(name, '');
    if (value) args.push(`--${name}`, value);
  }
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  // Only the last worker's progress is echoed; N interleaved counters are noise.
  if (index === parts.length - 1) child.stdout.pipe(process.stdout);
  else child.stdout.resume();
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`part ${index} exited ${code}`)));
})));

// Merge. Shard entries are already namespaced by map slug, so this is a
// concatenation plus a sum; the spec fields are identical across parts because
// the vocabulary does not depend on which maps a part happened to see.
let merged: Record<string, unknown> | null = null;
const shards: Array<Record<string, unknown>> = [];
const labels = { win: 0, draw: 0, loss: 0 };
let games = 0, positions = 0;

for (let index = 0; index < parts.length; index++) {
  const file = path.join(outDir, `.manifest.part-${index}.json`);
  const part = JSON.parse(fs.readFileSync(file, 'utf8'));
  merged ??= part;
  shards.push(...part.shards);
  games += part.games;
  positions += part.positions;
  for (const key of ['win', 'draw', 'loss'] as const) labels[key] += part.labels[key];
  fs.unlinkSync(file);
  fs.unlinkSync(path.join(outDir, `.part-${index}.maps.json`));
}

if (!merged) throw new Error('no parts produced a manifest');
merged.source = inFile;
merged.games = games;
merged.positions = positions;
merged.labels = labels;
merged.shards = shards;
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(merged, null, 2));

const total = labels.win + labels.draw + labels.loss;
const secs = (Date.now() - started) / 1000;
console.log(`\n${games} games -> ${positions} positions in ${secs.toFixed(0)}s ` +
  `(${(games / secs).toFixed(1)} games/s across ${parts.length} workers)`);
console.log(`labels: win ${(labels.win / total * 100).toFixed(1)}%  ` +
  `draw ${(labels.draw / total * 100).toFixed(1)}%  loss ${(labels.loss / total * 100).toFixed(1)}%`);
console.log(`shards: ${shards.length} (${shards.filter(s => s.split === 'train').length} train, ` +
  `${shards.filter(s => s.split === 'validation').length} validation)`);
