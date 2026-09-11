/** Bounded, deterministic CW self-play diagnostics; no files written by default.
 * node tools/probe-cw-stalemate.ts --map 'Squash Island' --days 50 --steps 12000 --seed 1
 * --snapshot /tmp/squash-day40.json resumes board state with fresh AI state/RNG.
 * --output /tmp/result.json writes the same JSON report printed to stdout.
 * --progress logs completed days to stderr while the match runs.
 * --agents coordinated,commanderwars selects experimental and original opponents.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import { restore, type GameState } from '../src/game/snapshot.ts';
import { GameEnvironment } from '../src/ai/environment.ts';
import { playMatch } from '../src/ai/agent.ts';
import { NormalAi } from '../src/ai/cw/normalai.ts';
import { CoordinatedAi } from '../src/ai/coordinated.ts';
import { GameEnums } from '../src/host/index.ts';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing --${name} value`);
  return args[index + 1];
};
const positive = (name: string, fallback: string) => {
  const value = Number(option(name, fallback));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
};
const mapName = option('map', 'Squash Island');
const days = positive('days', '50'), maxSteps = positive('steps', '20000'), seed = positive('seed', '1');
const input = option('snapshot', ''), output = option('output', '');
const progress = args.includes('--progress');
const requestedAgents = option('agents', 'commanderwars').split(',');
if (requestedAgents.some(name => name !== 'commanderwars' && name !== 'coordinated')) {
  throw new Error('--agents accepts commanderwars and coordinated, separated by commas');
}
const { registry, animations, rng } = bootstrap();
const file = mapName.endsWith('.map') ? mapName : `maps/2_player/${mapName}.map`;
const map = loadIntoGameMap(readMap(fs.readFileSync(path.resolve(cwRoot(), file))), registry);
const game = new Game(map, registry, animations);
if (input) restore(game, JSON.parse(fs.readFileSync(input, 'utf8')) as GameState);
map.getGameRules().setFogMode(GameEnums.Fog_Off);
const startDay = game.day;
const env = new GameEnvironment(map, registry, { maxDays: startDay + days - 1, rng, seed }, game);
env.reset(seed);
if (requestedAgents.length !== 1 && requestedAgents.length !== map.getPlayerCount()) {
  throw new Error('--agents must name one agent for all seats or one per map player');
}
const agentNames = Array.from({ length: map.getPlayerCount() }, (_, seat) =>
  requestedAgents[seat % requestedAgents.length]);
const agents = agentNames.map(name => name === 'coordinated' ? new CoordinatedAi({ seed }) : new NormalAi({ seed }));
type Day = { fire: number; coordinatedFire: number; build: number; moves: number; rejected: number; units: number[]; funds: number[] };
const daily: Record<number, Day> = {};
const purchases: Record<string, { count: number; units: Record<string, number>; days: number[] }> = {};
const started = Date.now();
const step = env.step.bind(env);
env.step = action => {
  const day = game.day;
  const stats = daily[day] ??= { fire: 0, coordinatedFire: 0, build: 0, moves: 0, rejected: 0, units: [], funds: [] };
  const actingAgent = agents[game.currentPlayerIndex];
  const coordinated = action.kind === 'unit' && action.actionId === 'ACTION_FIRE'
    && actingAgent instanceof CoordinatedAi
    && (actingAgent.saveState() as { pending: unknown }).pending !== null;
  const building = action.kind === 'build' ? map.getTerrain(action.at.x, action.at.y).getBuilding() : null;
  const unit = action.kind === 'unit' ? map.getUnitByUid(action.uid) : null;
  const moved = (action.kind === 'unit' && !!unit &&
    (unit.x !== action.to.x || unit.y !== action.to.y));
  const result = step(action);
  if (!result.info.accepted) stats.rejected++;
  else {
    if (action.kind === 'unit' && action.actionId === 'ACTION_FIRE') stats.fire++;
    if (coordinated) stats.coordinatedFire++;
    if (moved) stats.moves++;
    if (action.kind === 'build') {
      stats.build++;
      const key = `${building?.getBuildingID()}@${action.at.x},${action.at.y}`;
      const purchase = purchases[key] ??= { count: 0, units: {}, days: [] };
      purchase.count++;
      purchase.units[action.unitId] = (purchase.units[action.unitId] ?? 0) + 1;
      if (!purchase.days.includes(day)) purchase.days.push(day);
    }
  }
  stats.units = map.players.map(player => player.units.length);
  stats.funds = map.players.map(player => player.funds);
  if (progress && game.day !== day) console.error(JSON.stringify({ day, ...stats, elapsedMs: Date.now() - started }));
  return result;
};
const result = await playMatch(env, agents, { maxSteps });
const report = { map: mapName, seed, agents: agentNames, fog: 'off', resumed: input || null,
  resumeNote: input ? 'Board snapshot only; fresh AI state and RNG, not exact continuation.' : null,
  startDay, days, maxSteps, elapsedMs: Date.now() - started, result, daily, purchases };
const json = JSON.stringify(report, null, 2);
if (output) fs.writeFileSync(output, json + '\n');
console.log(json);
