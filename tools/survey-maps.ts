/**
 * Picks a benchmark suite for agent comparison.
 *
 * A map is only useful as a yardstick if it actually resolves — a match that
 * hits the day cap scores half a point for both sides whatever they did, so it
 * costs a lot of wall clock and carries no signal. This plays a mirror match on
 * each candidate map and reports how it ended and how long it took.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import { GameEnvironment, HeuristicAgent, playMatch } from '../src/ai/index.ts';

const { registry, animations, rng } = bootstrap();

// Both categories: pre_deployed maps hand out fixed armies, so a suite drawn
// only from those never exercises production at all — which is how the first
// suite came to measure tactics and nothing else.
const DIRS = ['maps/pre_deployed', 'maps/2_player'];
const files = DIRS.flatMap(dir => fs.readdirSync(path.join(cwRoot(), dir))
  .filter(f => f.endsWith('.map'))
  .map(f => `${dir}/${f}`));

interface Row {
  file: string; days: number; winner: number | null; ms: number; size: string;
  production: number[]; water: number; transports: number;
}
const rows: Row[] = [];
for (const rel of files) {
  let map;
  try {
    map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), rel))), registry);
  } catch { continue; }
  if (map.players.length !== 2) continue;             // two-player only, for clean duels
  if (map.width * map.height > 500) continue;         // big boards are slow to play out

  const game = new Game(map, registry, animations);

  // What kind of game is this map, before anyone plays it?
  const production = map.players.map(p => {
    let n = 0;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const b = map.getTerrain(x, y).getBuilding();
        if (b?.getOwner() === p && b.canBuildUnits()) n++;
      }
    }
    return n;
  });
  let water = 0;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (map.getTerrain(x, y).getTerrainID() === 'SEA') water++;
    }
  }
  const transports = map.units.filter(u => u.getLoadingPlace() > 0).length;

  const env = new GameEnvironment(map, registry, { maxDays: 30, maxFieldChoices: 6, rng, seed: 1 }, game);
  env.reset(1);
  const started = Date.now();
  const result = await playMatch(env, [new HeuristicAgent(), new HeuristicAgent()], { maxSteps: 8000 });
  rows.push({
    file: rel, days: result.days, winner: result.winner, ms: Date.now() - started,
    size: `${map.width}x${map.height}`,
    production, water: water / (map.width * map.height), transports,
  });
  const row = rows.at(-1)!;
  console.log(`${path.basename(rel, '.map').padEnd(26).slice(0, 26)} ${row.size.padEnd(7)} ` +
    `${result.winner === null ? 'draw' : 'P' + (result.winner + 1)} day ${String(result.days).padStart(2)} ` +
    `prod ${production.join('/')} water ${(row.water * 100).toFixed(0)}% trans ${transports} ` +
    `${(row.ms / 1000).toFixed(1)}s`);
}

/** A map earns a place only if it resolves and both sides can actually build. */
const usable = rows.filter(r =>
  r.winner !== null && r.production.every(n => n > 0) && r.ms < 20_000);
const naval = usable.filter(r => r.water > 0.15 || r.transports > 0);
const land = usable.filter(r => !naval.includes(r));

console.log(`\n${rows.length} maps played, ${usable.length} usable ` +
  `(resolve + both sides have production): ${naval.length} naval, ${land.length} land.`);
console.log('NAVAL', JSON.stringify(naval.sort((a, b) => a.ms - b.ms).slice(0, 8).map(r => r.file), null, 2));
console.log('LAND', JSON.stringify(land.sort((a, b) => a.ms - b.ms).slice(0, 10).map(r => r.file), null, 2));
