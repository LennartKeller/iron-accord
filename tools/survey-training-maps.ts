/**
 * Picks the map pool the value net trains on, which is not the benchmark suite.
 *
 * `survey-maps.ts` chooses a *yardstick*: it keeps the fastest-resolving maps,
 * because a benchmark wants matches that finish. That is the wrong distribution
 * to learn from — a fast resolution means a forced line, and the 50k-game run
 * showed what that costs: Feline Basin produced 5 distinct action sequences
 * across 1389 games, Burger Isle 4, every game ending on the same day. Those
 * positions are memorisable by terrain signature and teach nothing.
 *
 * So this keeps the opposite end: every playable two-player map, benchmark maps
 * excluded so the Phase 4 numbers stay uncontaminated. The filter here is
 * static — two players, a board small enough to play quickly, and production on
 * both sides — because deciding whether a map resolves needs a game, and games
 * are what `selfplay.ts` already runs 16 at a time. Play the probe with this
 * list, then narrow it with `--resolved`.
 *
 *   node tools/survey-training-maps.ts --out data/candidate-maps.json
 *   node tools/selfplay.ts --maps data/candidate-maps.json --games 600 --maxDays 60 --out data/probe.jsonl.gz
 *   node tools/survey-training-maps.ts --resolved data/probe.jsonl.gz --out data/training-maps.json
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { NAVAL_MAPS, LAND_MAPS } from './tune-ai.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const outFile = arg('out', 'data/training-maps.json');
const resolvedFrom = arg('resolved', '');
/** The benchmark suite. Held out entirely, so Phase 4 measures generalisation. */
const BENCHMARK = new Set([...NAVAL_MAPS, ...LAND_MAPS]);

if (resolvedFrom) {
  // Second pass: keep the maps whose probe games actually ended in a result.
  const rl = readline.createInterface({
    input: fs.createReadStream(resolvedFrom).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  const played = new Map<string, { decided: number; total: number }>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    const replay = JSON.parse(line);
    let tally = played.get(replay.map);
    if (!tally) { tally = { decided: 0, total: 0 }; played.set(replay.map, tally); }
    tally.total++;
    if (replay.winner !== null && replay.winner !== undefined) tally.decided++;
  }
  // A map that never resolves is a map every game on it labels 0.
  const keep = [...played].filter(entry => entry[1].decided > 0).map(entry => entry[0]).sort();
  const dropped = [...played].filter(entry => entry[1].decided === 0).length;
  fs.writeFileSync(outFile, JSON.stringify(keep, null, 2));
  console.log(`${played.size} maps probed, ${keep.length} resolve at least once, ${dropped} never do`);
  console.log(`wrote ${outFile}`);
} else {
  const { registry } = bootstrap();
  const dirs = ['maps/pre_deployed', 'maps/2_player'];
  const files = dirs.flatMap(dir => fs.readdirSync(path.join(cwRoot(), dir))
    .filter(name => name.endsWith('.map'))
    .map(name => `${dir}/${name}`));

  const kept: string[] = [];
  let twoPlayer = 0, sized = 0, benched = 0;
  for (const rel of files) {
    if (BENCHMARK.has(rel)) { benched++; continue; }
    let map;
    try {
      map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), rel))), registry);
    } catch { continue; }
    if (map.players.length !== 2) continue;
    twoPlayer++;
    if (map.width * map.height > 500) continue;
    sized++;
    // Both sides must be able to build, or the map measures tactics with a
    // fixed army and nothing else — the mistake the first benchmark suite made.
    const production = map.players.map(player => {
      let n = 0;
      for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
          const building = map.getTerrain(x, y).getBuilding();
          if (building?.getOwner() === player && building.canBuildUnits()) n++;
        }
      }
      return n;
    });
    if (!production.every(n => n > 0)) continue;
    kept.push(rel);
  }

  fs.writeFileSync(outFile, JSON.stringify(kept.sort(), null, 2));
  console.log(`${files.length} files, ${benched} benchmark maps held out, ${twoPlayer} two-player, ` +
    `${sized} small enough, ${kept.length} with production on both sides`);
  console.log(`wrote ${outFile}`);
}
