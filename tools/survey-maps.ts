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

const dir = path.join(cwRoot(), 'maps/pre_deployed');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.map'));

const rows: Array<{ file: string; days: number; winner: number | null; ms: number; size: string }> = [];
for (const file of files) {
  const rel = `maps/pre_deployed/${file}`;
  let map;
  try {
    map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), rel))), registry);
  } catch { continue; }
  if (map.players.length !== 2) continue;             // two-player only, for clean duels
  if (map.width * map.height > 500) continue;         // big boards are slow to play out

  const game = new Game(map, registry, animations);
  const env = new GameEnvironment(map, registry, { maxDays: 30, maxFieldChoices: 6, rng, seed: 1 }, game);
  env.reset(1);
  const started = Date.now();
  const result = await playMatch(env, [new HeuristicAgent(), new HeuristicAgent()], { maxSteps: 8000 });
  rows.push({
    file: rel, days: result.days, winner: result.winner, ms: Date.now() - started,
    size: `${map.width}x${map.height}`,
  });
  console.log(`${file.padEnd(28).slice(0, 28)} ${rows.at(-1)!.size.padEnd(7)} ` +
    `${result.winner === null ? 'draw' : 'P' + (result.winner + 1)} day ${String(result.days).padStart(2)} ` +
    `${(rows.at(-1)!.ms / 1000).toFixed(1)}s`);
}

const decisive = rows.filter(r => r.winner !== null).sort((a, b) => a.ms - b.ms);
console.log(`\n${decisive.length}/${rows.length} maps resolved. Fastest decisive:`);
console.log(JSON.stringify(decisive.slice(0, 14).map(r => r.file), null, 2));
