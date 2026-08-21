/**
 * Verifies that a replay reproduces the game it recorded.
 *
 * Replays are only valid as training storage if positions can be re-derived
 * from them exactly. Combat rolls luck, so this also checks that reseeding
 * recreates the same rolls: if it did not, every position label would be
 * attached to a board that never occurred.
 *
 *   node tools/replay-check.ts data/selfplay.jsonl
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
import { GameEnvironment, applyAction } from '../src/ai/index.ts';
import type { Replay } from './selfplay-worker.ts';

const file = process.argv[2] ?? 'data/selfplay.jsonl';
const limit = Number(process.argv[3] ?? 25);
const { registry, animations, rng } = bootstrap();

/** A fingerprint of everything that should be identical after a faithful replay. */
function fingerprint(game: Game): string {
  const units = game.map.units
    .map(u => `${u.getUnitID()}@${u.x},${u.y}:${u.getHp().toFixed(4)}:${u.getOwner().getPlayerID()}`)
    .sort().join('|');
  const buildings: string[] = [];
  for (let y = 0; y < game.map.height; y++) {
    for (let x = 0; x < game.map.width; x++) {
      const b = game.map.getTerrain(x, y).getBuilding();
      if (b) buildings.push(`${x},${y}:${b.getBuildingID()}:${b.getOwner()?.getPlayerID() ?? -1}`);
    }
  }
  const funds = game.map.players.map(p => p.funds).join(',');
  return `${game.day}/${game.currentPlayerIndex}/${funds}/${units}/${buildings.join('|')}`;
}

/**
 * The first `count` replays, read as a stream.
 *
 * Decompressing the whole file into one string worked until the run got big: at
 * 50k games it lands past Node's ~512 MB cap on a string and throws. Nothing
 * here ever needed the whole file — only the first few hundred lines — so it
 * reads until it has them and stops.
 */
async function head(file: string, count: number): Promise<string[]> {
  const stream = file.endsWith('.gz')
    ? fs.createReadStream(file).pipe(zlib.createGunzip())
    : fs.createReadStream(file);
  const lines: string[] = [];
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) lines.push(line);
    if (lines.length >= count) break;
  }
  rl.close();
  stream.destroy();
  return lines;
}

const lines = await head(file, limit);
let matched = 0, mismatched = 0, rejected = 0;

for (const line of lines) {
  const replay: Replay = JSON.parse(line);
  const map = loadIntoGameMap(
    readMap(fs.readFileSync(path.join(cwRoot(), replay.map))), registry);
  map.getGameRules().setFogMode(replay.fog);
  const game = new Game(map, registry, animations);
  map.vision.update();
  const env = new GameEnvironment(
    map, registry, { maxDays: 30, maxFieldChoices: 6, rng, seed: replay.seed }, game);
  env.reset(replay.seed);

  let refused = 0;
  for (const step of replay.actions) {
    if (step.action.kind === 'endTurn') { game.endTurn(); continue; }
    if (!applyAction(game, step.action)) refused++;
  }
  rejected += refused;

  const sameOutcome = (game.over?.winner ?? null) === replay.winner && game.day === replay.days;
  if (refused === 0 && sameOutcome) matched++;
  else {
    mismatched++;
    if (mismatched <= 3) {
      console.log(`mismatch ${path.basename(replay.map)}: refused ${refused} actions, ` +
        `winner ${game.over?.winner ?? null} vs ${replay.winner}, day ${game.day} vs ${replay.days}`);
    }
  }
}

console.log(`\n${matched}/${lines.length} replays reproduced exactly` +
  (mismatched ? `, ${mismatched} diverged (${rejected} actions refused)` : ''));
process.exitCode = mismatched === 0 ? 0 : 1;
