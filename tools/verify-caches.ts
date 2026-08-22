/**
 * Differential test for the GameMap derived-state caches.
 *
 * Plays real games and, after EVERY action, checks the two caches added for
 * speed against the uncached ground truth they replaced:
 *
 *  - getUnitAt versus a linear scan of map.units (the exact code it replaced);
 *  - getBaseMovementCosts versus a direct movement-table script call for every
 *    tile and every distinct movement type on the board.
 *
 * The AI snapshots and restores constantly during these games, so this
 * exercises precisely the invalidation paths a stale cache would corrupt.
 *
 *   node tools/verify-caches.ts --games 6 --maxDays 25
 */
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import { GameEnvironment, HeuristicAgent, playMatch } from '../src/ai/index.ts';
import { GameEnums } from '../src/host/index.ts';
import type { GameMap, Unit } from '../src/host/index.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const games = Number(arg('games', '6'));
const maxDays = Number(arg('maxDays', '25'));
const MAPS: string[] = JSON.parse(fs.readFileSync(arg('maps', 'data/training-maps.json'), 'utf8'));

const { registry, animations, rng } = bootstrap();
let checks = 0;
let failures = 0;

function checkBoard(map: GameMap): void {
  // Ground truth for occupancy: the linear scan getUnitAt used to be.
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const expected = map.units.find(u => u.x === x && u.y === y) ?? null;
      const actual = map.getUnitAt(x, y);
      checks++;
      if (actual !== expected) {
        failures++;
        console.error(`getUnitAt(${x},${y}) mismatch: got ${actual?.getUnitID()}, want ${expected?.getUnitID()}`);
      }
    }
  }
  // Ground truth for movement costs: the direct script call, one probe unit
  // per movement type present on the board.
  const probes = new Map<string, Unit>();
  for (const unit of map.units) {
    const type = unit.getMovementType();
    if (!probes.has(type)) probes.set(type, unit);
  }
  for (const [type, unit] of probes) {
    const table = map.registry[type];
    if (!table?.getMovementpoints) continue;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const target = map.getTerrain(x, y);
        const raw = table.getMovementpoints(target, unit, target, false, map);
        const expected = typeof raw === 'number' ? raw : -1;
        const actual = unit.getBaseMovementCosts(x, y);
        checks++;
        if (actual !== expected) {
          failures++;
          console.error(`cost mismatch ${type} at (${x},${y}): got ${actual}, want ${expected}`);
        }
      }
    }
  }
}

for (let i = 0; i < games; i++) {
  const mapPath = MAPS[(i * 7) % MAPS.length];
  const fog = i % 2 === 0 ? GameEnums.Fog_Off : GameEnums.Fog_OfWar;
  const source = readMap(fs.readFileSync(path.join(cwRoot(), mapPath)));
  const map = loadIntoGameMap(source, registry);
  map.getGameRules().setFogMode(fog);
  const game = new Game(map, registry, animations);
  map.vision.update();
  const env = new GameEnvironment(
    map, registry, { maxDays, maxFieldChoices: 6, rng, seed: 1 }, game);
  env.reset(1);
  const result = await playMatch(env, [new HeuristicAgent(), new HeuristicAgent()], {
    maxSteps: 4000,
    onStep: () => { checkBoard(map); },
  });
  console.log(`game ${i}: ${path.basename(mapPath)} fog=${fog} days=${result.days} (${result.reason}) — cumulative ${checks} checks, ${failures} failures`);
}

console.log(failures === 0
  ? `OK: ${checks} checks, no divergence between caches and ground truth.`
  : `FAILED: ${failures} of ${checks} checks diverged.`);
process.exit(failures === 0 ? 0 : 1);
