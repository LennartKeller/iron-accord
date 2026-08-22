/**
 * Single-process self-play driver for CPU profiling.
 *
 * Plays the same games a selfplay worker would — same map cycling, seeds, fog
 * and agent seating as tools/selfplay.ts — but in this process, so
 * `node --cpu-prof tools/profile-sim.ts` captures the actual simulation
 * rather than a parent that only shuffles messages between workers.
 *
 *   node --cpu-prof --cpu-prof-dir /tmp/prof tools/profile-sim.ts \
 *     --maps data/training-maps.json --games 12 --maxDays 60
 */
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import { GameEnvironment, HeuristicAgent, PlannerAgent, RandomAgent, playMatch } from '../src/ai/index.ts';
import type { Agent } from '../src/ai/index.ts';
import { GameEnums } from '../src/host/index.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const games = Number(arg('games', '12'));
const maxDays = Number(arg('maxDays', '60'));
const agents = arg('agents', 'heuristic,heuristic').split(',');
const mapsFile = arg('maps', 'data/training-maps.json');
const MAPS: string[] = JSON.parse(fs.readFileSync(mapsFile, 'utf8'));
const FOG: Record<string, number[]> = {
  off: [GameEnums.Fog_Off],
  war: [GameEnums.Fog_OfWar],
  mixed: [GameEnums.Fog_Off, GameEnums.Fog_OfWar],
};
const fogModes = FOG[arg('fog', 'mixed')] ?? FOG.mixed;

const { registry, animations, rng } = bootstrap();
const sources = new Map<string, ReturnType<typeof readMap>>();

function agentFor(name: string, seed: number): Agent {
  if (name === 'planner') return new PlannerAgent({ timeBudgetMs: 150 });
  if (name === 'random') return new RandomAgent(seed);
  return new HeuristicAgent();
}

let totalActions = 0;
const started = Date.now();
for (let i = 0; i < games; i++) {
  const mapPath = MAPS[i % MAPS.length];
  const seed = 1 + Math.floor(i / MAPS.length);
  const fog = fogModes[i % fogModes.length];
  const seats = i % 2 === 0 ? agents : [...agents].reverse();

  let source = sources.get(mapPath);
  if (!source) {
    source = readMap(fs.readFileSync(path.join(cwRoot(), mapPath)));
    sources.set(mapPath, source);
  }
  const map = loadIntoGameMap(source, registry);
  map.getGameRules().setFogMode(fog);
  const game = new Game(map, registry, animations);
  map.vision.update();
  const env = new GameEnvironment(
    map, registry, { maxDays, maxFieldChoices: 6, rng, seed }, game);
  env.reset(seed);

  const result = await playMatch(env, seats.map(
    (name, seat) => agentFor(name, seed * 31 + seat + 1)), {
    maxSteps: 8000,
    onStep: () => { totalActions++; },
  });
  console.log(`game ${i}: ${path.basename(mapPath)} fog=${fog} winner=${result.winner} days=${result.days} (${result.reason})`);
}
const secs = (Date.now() - started) / 1000;
console.log(`${games} games, ${totalActions} actions in ${secs.toFixed(1)}s — ${(games / secs).toFixed(2)} games/s`);
