/**
 * Turns replays into training positions.
 *
 * Replays store actions, not tensors, so every position has to be re-derived by
 * replaying the game — see `tools/replay-check.ts` for why that reproduces the
 * original board exactly, and why reseeding is part of it.
 *
 *   node tools/extract-positions.ts --in data/pilot.jsonl.gz --out data/positions
 *
 * Storage. A position encodes to `channels * H * W` floats, which is ~360 KB on
 * a 24x17 board — a million of those is not going on this disk. But the tensor
 * is nearly all one-hot: terrain, unit and building each light exactly one
 * channel per tile. So a position is stored as three uint8 index planes plus the
 * derived planes quantised to uint8, which is ~50x smaller and lossless for
 * everything except the four continuous channels (hp, fuel, ammo, capture),
 * where 1/255 is far below any threshold that matters.
 *
 * That also keeps the open question open: index planes can be scattered back to
 * one-hot for a 226-channel net, or fed to an embedding layer, from the same
 * file.
 *
 * Shards are per map, because a map is the only thing that fixes H and W. That
 * makes every shard a fixed-shape array the trainer can batch without padding,
 * and it makes the train/validation split — which must be by map — a matter of
 * which directory a shard is written to.
 *
 * Run by plain `node` through type stripping: no parameter properties, enums or
 * decorators anywhere on this import path.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import { GameEnvironment, applyAction, Belief, HeuristicEvaluator } from '../src/ai/index.ts';
import { ObservationEncoder } from '../src/ai/observation.ts';
import { vocabulary } from '../src/scripts/vocabulary.ts';
import { TRAIN_MAPS } from './tune-ai.ts';
import type { Replay } from './selfplay-worker.ts';
import type { Player } from '../src/host/index.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const inFile = arg('in', 'data/pilot.jsonl.gz');
const outDir = arg('out', 'data/positions');
/**
 * Positions to take from each player-turn, evenly spaced through it.
 *
 * Sampling on a plain every-Nth-action stride looked simpler and was wrong: the
 * winning side has more units, so it takes more actions per turn, so it gets
 * more samples. A 64-game probe came out 33% win / 21% loss purely from that.
 * Turns alternate, so budgeting per turn balances the seats by construction.
 */
const perTurn = Number(arg('perTurn', '2'));
/** Density cap within a turn, so a long turn cannot hand over near-identical boards. */
const every = Number(arg('every', '4'));
/** Discount toward the result: an opening position in a won game is not the win. 1 disables it. */
const gamma = Number(arg('gamma', '1'));
const limit = Number(arg('limit', '0')) || Infinity;
/** Positions per shard file, so a shard stays memory-mappable and flushes bound RAM. */
const shardSize = Number(arg('shardSize', '4096'));
/** Also score each position with the hand-priced evaluation, for the phase-3 comparison. */
const baseline = arg('baseline', '1') !== '0';

const { registry, animations, rng } = bootstrap();
const trainSet = new Set(TRAIN_MAPS);
const evaluator = new HeuristicEvaluator();

/** One map's accumulating shard. Fixed H/W is what makes this a rectangular array. */
interface Bucket {
  map: string;
  slug: string;
  split: string;
  width: number;
  height: number;
  /**
   * Preallocated, not number[]. A JS array holds each byte as an 8-byte double
   * plus boxing slack, so a 16k-position shard of a 24x17 board came to about a
   * gigabyte per bucket — and 18 buckets fill at once. Typed arrays store what
   * they say they store.
   */
  planes: Uint8Array;
  scalars: Float32Array;
  labels: Float32Array;
  baselines: Float32Array;
  games: Uint32Array;
  plies: Uint32Array;
  /** Write cursor into `planes`; the rest index by `count`. */
  offset: number;
  count: number;
  shard: number;
  written: number;
}

const buckets = new Map<string, Bucket>();
const encoders = new Map<string, ObservationEncoder>();
const sources = new Map<string, ReturnType<typeof readMap>>();
let spec: ObservationEncoder['spec'] | null = null;
/** Index of the first derived channel: everything before it is one-hot vocabulary. */
let derivedBase = 0;
let terrainCount = 0, unitCount = 0, buildingCount = 0, derivedCount = 0;
let scalarCount = 0;

function slugify(mapPath: string): string {
  return path.basename(mapPath, '.map').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function bucketFor(replay: Replay, width: number, height: number): Bucket {
  let bucket = buckets.get(replay.map);
  if (!bucket) {
    bucket = {
      map: replay.map,
      slug: slugify(replay.map),
      split: trainSet.has(replay.map) ? 'train' : 'validation',
      width, height,
      planes: new Uint8Array(shardSize * (3 + derivedCount) * width * height),
      scalars: new Float32Array(shardSize * scalarCount),
      labels: new Float32Array(shardSize),
      baselines: new Float32Array(shardSize),
      games: new Uint32Array(shardSize),
      plies: new Uint32Array(shardSize),
      offset: 0, count: 0, shard: 0, written: 0,
    };
    buckets.set(replay.map, bucket);
  }
  return bucket;
}

const manifest: Array<Record<string, unknown>> = [];

function flush(bucket: Bucket): void {
  if (bucket.count === 0) return;
  const dir = path.join(outDir, bucket.split);
  fs.mkdirSync(dir, { recursive: true });
  const stem = path.join(dir, `${bucket.slug}-${bucket.shard}`);

  // Separate files per array so the trainer can memory-map each one directly
  // instead of trusting byte offsets computed in two languages.
  // Sliced to `count`: the last shard of a map is almost never full.
  fs.writeFileSync(`${stem}.planes.u8`, Buffer.from(bucket.planes.buffer, 0, bucket.offset));
  fs.writeFileSync(`${stem}.scalars.f32`, Buffer.from(bucket.scalars.buffer, 0, bucket.count * scalarCount * 4));
  fs.writeFileSync(`${stem}.labels.f32`, Buffer.from(bucket.labels.buffer, 0, bucket.count * 4));
  fs.writeFileSync(`${stem}.baseline.f32`, Buffer.from(bucket.baselines.buffer, 0, bucket.count * 4));
  fs.writeFileSync(`${stem}.games.u32`, Buffer.from(bucket.games.buffer, 0, bucket.count * 4));
  fs.writeFileSync(`${stem}.plies.u32`, Buffer.from(bucket.plies.buffer, 0, bucket.count * 4));

  manifest.push({
    map: bucket.map,
    split: bucket.split,
    stem: path.relative(outDir, stem),
    count: bucket.count,
    width: bucket.width,
    height: bucket.height,
    indexPlanes: 3,
    derivedPlanes: derivedCount,
  });

  bucket.written += bucket.count;
  bucket.shard++;
  bucket.count = 0;
  bucket.offset = 0;
}

/**
 * Re-packs one dense observation into index planes plus quantised derived planes.
 *
 * Reading back from the real encoder rather than re-deriving the fields is
 * deliberate: the net has to see exactly what the planner will hand it at
 * inference time, so there is only ever one encoding implementation.
 */
function pack(planes: Float32Array, width: number, height: number,
              out: Uint8Array, at: number): number {
  const planeSize = width * height;
  const NONE = 255;
  let cursor = at;

  for (let group = 0; group < 3; group++) {
    const start = group === 0 ? 0 : group === 1 ? terrainCount : terrainCount + unitCount;
    const size = group === 0 ? terrainCount : group === 1 ? unitCount : buildingCount;
    for (let tile = 0; tile < planeSize; tile++) {
      let found = NONE;
      for (let c = 0; c < size; c++) {
        if (planes[(start + c) * planeSize + tile] !== 0) { found = c; break; }
      }
      out[cursor++] = found;
    }
  }

  for (let d = 0; d < derivedCount; d++) {
    const offset = (derivedBase + d) * planeSize;
    for (let tile = 0; tile < planeSize; tile++) {
      const value = planes[offset + tile];
      const clamped = value < 0 ? 0 : value > 1 ? 1 : value;
      out[cursor++] = Math.round(clamped * 255);
    }
  }
  return cursor;
}

/**
 * Which action indices to sample, chosen up front from the recorded seat of each
 * action — turn boundaries are already in the replay, so this needs no simulation.
 */
function sampleIndices(actions: Replay['actions']): Set<number> {
  const picks = new Set<number>();
  let start = 0;
  for (let i = 0; i <= actions.length; i++) {
    const ended = i === actions.length || actions[i].player !== actions[start].player;
    if (!ended) continue;
    const length = i - start;
    if (length > 0) {
      const take = Math.max(1, Math.min(perTurn, Math.ceil(length / every)));
      for (let k = 0; k < take; k++) {
        // Evenly spaced through the turn, so opening, middle and end all appear.
        picks.add(start + Math.floor(((k + 0.5) * length) / take));
      }
    }
    start = i;
  }
  return picks;
}

/** The result from the acting player's side, as +1 / 0 / -1. */
function outcomeFor(replay: Replay, game: Game, playerIndex: number): number {
  const player = game.map.getPlayer(playerIndex);
  if (replay.winningTeam !== null && replay.winningTeam !== undefined && player) {
    return player.getTeam() === replay.winningTeam ? 1 : -1;
  }
  if (replay.winner === null || replay.winner === undefined) return 0;
  return replay.winner === playerIndex ? 1 : -1;
}

const stream = fs.createReadStream(inFile);
const lines = readline.createInterface({
  input: inFile.endsWith('.gz') ? stream.pipe(zlib.createGunzip()) : stream,
  crlfDelay: Infinity,
});

let games = 0, positions = 0, diverged = 0;
const labelTally = { win: 0, draw: 0, loss: 0 };
const started = Date.now();

for await (const line of lines) {
  if (!line.trim()) continue;
  if (games >= limit) break;
  const replay: Replay = JSON.parse(line);

  let source = sources.get(replay.map);
  if (!source) {
    source = readMap(fs.readFileSync(path.join(cwRoot(), replay.map)));
    sources.set(replay.map, source);
  }

  const map = loadIntoGameMap(source, registry);
  map.getGameRules().setFogMode(replay.fog);
  const game = new Game(map, registry, animations);
  map.vision.update();
  const env = new GameEnvironment(
    map, registry, { maxDays: replay.days + 8, maxFieldChoices: 6, rng, seed: replay.seed }, game);
  // The script RNG is process-wide; without this the combat luck of the
  // previous replay leaks into this one and the board diverges.
  env.reset(replay.seed);

  let encoder = encoders.get(replay.map);
  if (!encoder) {
    encoder = ObservationEncoder.fromGame(game);
    encoders.set(replay.map, encoder);
    if (!spec) {
      spec = encoder.spec;
      // Taken from the vocabulary itself, not by matching channel-name prefixes:
      // the derived channels share those prefixes ('unit:hp', 'building:mine').
      const vocab = vocabulary(registry);
      terrainCount = vocab.terrain.length;
      unitCount = vocab.units.length;
      buildingCount = vocab.buildings.length;
      derivedBase = terrainCount + unitCount + buildingCount;
      derivedCount = spec.channels - derivedBase;
      scalarCount = spec.scalarNames.length;
      console.log(`spec: ${spec.channels} channels = ${terrainCount} terrain + ${unitCount} unit ` +
        `+ ${buildingCount} building + ${derivedCount} derived`);
    }
  }

  const bucket = bucketFor(replay, map.width, map.height);
  let refused = 0;

  // One Belief per seat, kept across turns and refreshed at each turn start —
  // the same lifecycle PlannerAgent gives it, so the baseline score is the one
  // the planner would actually have computed here.
  const beliefs = new Map<number, Belief>();
  const picks = sampleIndices(replay.actions);
  let lastPlayer = -1;

  for (let i = 0; i < replay.actions.length; i++) {
    const acting = game.currentPlayerIndex;
    const player: Player | null = game.map.getPlayer(acting) ?? null;
    if (player && acting !== lastPlayer) {
      let belief = beliefs.get(acting);
      if (!belief) { belief = new Belief(player); beliefs.set(acting, belief); }
      belief.observe(game);
      lastPlayer = acting;
    }

    // Sample before applying, so the position is the one the acting player faced.
    if (picks.has(i) && !game.over && player) {
      // Before writing, not after the game: one game contributes ~120 positions,
      // so a bucket can cross the shard size mid-game — and a typed array drops
      // out-of-range writes silently rather than throwing.
      if (bucket.count >= shardSize) flush(bucket);
      const observation = encoder.encode(game, acting);
      let label = outcomeFor(replay, game, acting);
      if (gamma !== 1) {
        const remaining = Math.max(0, replay.days - game.day);
        label *= Math.pow(gamma, remaining);
      }
      bucket.offset = pack(observation.planes, map.width, map.height, bucket.planes, bucket.offset);
      bucket.scalars.set(observation.scalars, bucket.count * scalarCount);
      bucket.labels[bucket.count] = label;
      bucket.baselines[bucket.count] = baseline
        ? evaluator.score([evaluator.capture(game, player, beliefs.get(acting)!)])[0]
        : 0;
      bucket.games[bucket.count] = games;
      bucket.plies[bucket.count] = i;
      bucket.count++;
      positions++;
      if (label > 0) labelTally.win++; else if (label < 0) labelTally.loss++; else labelTally.draw++;
    }

    const step = replay.actions[i];
    if (step.action.kind === 'endTurn') { game.endTurn(); continue; }
    if (!applyAction(game, step.action)) refused++;
  }

  if (refused > 0) diverged++;
  if (bucket.count >= shardSize) flush(bucket);

  games++;
  if (games % 200 === 0) {
    const rate = games / ((Date.now() - started) / 1000);
    console.log(`${games} games  ${positions} positions  ${rate.toFixed(1)} games/s`);
  }
}

for (const bucket of buckets.values()) flush(bucket);

fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
  source: inFile,
  perTurn, every, gamma, baseline,
  channels: spec?.channels ?? 0,
  channelNames: spec?.channelNames ?? [],
  scalarNames: spec?.scalarNames ?? [],
  terrainCount, unitCount, buildingCount, derivedCount,
  none: 255,
  games, positions,
  shards: manifest,
}, null, 2));

const total = labelTally.win + labelTally.draw + labelTally.loss;
console.log(`\n${games} games -> ${positions} positions in ${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log(`labels: win ${(labelTally.win / total * 100).toFixed(1)}%  ` +
  `draw ${(labelTally.draw / total * 100).toFixed(1)}%  loss ${(labelTally.loss / total * 100).toFixed(1)}%`);
console.log(`shards: ${manifest.length} across ${buckets.size} maps ` +
  `(${manifest.filter(s => s.split === 'train').length} train, ` +
  `${manifest.filter(s => s.split === 'validation').length} validation)`);
if (diverged > 0) console.log(`WARNING: ${diverged} replays refused at least one action`);
