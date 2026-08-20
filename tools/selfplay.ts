/**
 * Parallel self-play, for generating training data.
 *
 * Writes one replay per line as JSONL: the map, the seed, and every action in
 * order. Positions are re-derived from a replay rather than stored as tensors —
 * a replay is a couple of KB where an encoded position is ~48 KB, and the
 * encoder is still changing, so anything dumped today would need regenerating.
 *
 *   node tools/selfplay.ts --games 2000 --out data/selfplay.jsonl
 *   node tools/selfplay.ts --games 200 --agents planner,heuristic --fog war
 */
import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { GameEnums } from '../src/host/index.ts';
import { NAVAL_MAPS, LAND_MAPS } from './tune-ai.ts';
import type { Job, Replay } from './selfplay-worker.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const games = Number(arg('games', '100'));
const out = arg('out', 'data/selfplay.jsonl');
const agents = arg('agents', 'heuristic,heuristic').split(',');
const fogName = arg('fog', 'mixed');
const maxDays = Number(arg('maxDays', '30'));
// Leave a core for the OS and this process; oversubscribing slows everything.
const workerCount = Math.max(1, Math.min(Number(arg('workers', '0')) || os.availableParallelism() - 2, games));

const MAPS = [...NAVAL_MAPS, ...LAND_MAPS];
const FOG: Record<string, number[]> = {
  off: [GameEnums.Fog_Off],
  war: [GameEnums.Fog_OfWar],
  mixed: [GameEnums.Fog_Off, GameEnums.Fog_OfWar],
};
const fogModes = FOG[fogName] ?? FOG.mixed;

/**
 * Jobs cycle through maps, fog modes and seats so a run is balanced by
 * construction: stopping early still leaves an even spread rather than every
 * game on the first map.
 */
function* jobs(): Generator<Job> {
  for (let i = 0; i < games; i++) {
    const seats = i % 2 === 0 ? agents : [...agents].reverse();
    yield {
      id: i,
      map: MAPS[i % MAPS.length],
      seed: 1 + Math.floor(i / MAPS.length),
      fog: fogModes[Math.floor(i / MAPS.length) % fogModes.length],
      agents: seats,
      maxDays,
    };
  }
}

fs.mkdirSync(path.dirname(out), { recursive: true });
// Replays are extremely repetitive JSON — gzip takes them to about a
// twentieth, which turns a 50k-game dataset from ~2 GB into under 100 MB.
// Writing `.gz` is enough to ask for it.
const file = fs.createWriteStream(out, { flags: 'w' });
const sink = out.endsWith('.gz') ? zlib.createGzip() : file;
if (sink !== file) sink.pipe(file);
const queue = jobs();
const started = Date.now();
let done = 0, failed = 0, actions = 0;
const outcomes = { p1: 0, p2: 0, draw: 0 };

await new Promise<void>(resolve => {
  let live = workerCount;
  for (let w = 0; w < workerCount; w++) {
    const worker = new Worker(new URL('./selfplay-worker.ts', import.meta.url));

    const next = () => {
      const job = queue.next();
      if (job.done) { worker.postMessage('stop'); return; }
      worker.postMessage(job.value);
    };

    worker.on('message', (message: { id: number; replay?: Replay; error?: string }) => {
      if (message.replay) {
        const replay = message.replay;
        sink.write(JSON.stringify(replay) + '\n');
        done++;
        actions += replay.actions.length;
        if (replay.winner === null) outcomes.draw++;
        else if (replay.winner === 0) outcomes.p1++;
        else outcomes.p2++;
        if (done % 25 === 0 || done === games) {
          const secs = (Date.now() - started) / 1000;
          process.stdout.write(
            `\r${done}/${games} games  ${(done / secs).toFixed(1)}/s  ` +
            `${(secs / done * games / 60).toFixed(1)} min projected   `);
        }
      } else {
        failed++;
        if (failed <= 3) console.error(`\njob ${message.id} failed: ${message.error}`);
      }
      next();
    });

    worker.on('error', error => { console.error('\nworker error:', error.message); });
    worker.on('exit', () => { if (--live === 0) resolve(); });
    next();
  }
});

sink.end();
await new Promise<void>(done => { file.on('close', () => done()); });
const secs = (Date.now() - started) / 1000;
console.log(`\n\n${done} games in ${secs.toFixed(1)}s across ${workerCount} workers` +
  ` — ${(done / secs).toFixed(1)} games/s, ${(actions / Math.max(1, done)).toFixed(0)} actions/game`);
console.log(`outcomes: P1 ${outcomes.p1}, P2 ${outcomes.p2}, draw ${outcomes.draw}, failed ${failed}`);
const size = fs.statSync(out).size;
console.log(`positions available: ~${actions} in ${(size / 1048576).toFixed(1)} MB (${out})`);
