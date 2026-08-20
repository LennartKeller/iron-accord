/**
 * Counts everything the engine swallows.
 *
 * Script failures do not stop the game: an action that throws is logged and
 * skipped, and an animation callback that throws is logged and abandoned
 * part-way. That is deliberate — one missing host method should not end a match
 * — but it means a real rules bug can run for months in silence. ACTION_JOIN
 * was handing out free units this way, visible only as a log line nobody read.
 *
 * This plays the whole suite and ranks what actually went wrong.
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
import { NAVAL_MAPS, LAND_MAPS } from './tune-ai.ts';

const { registry, animations, rng } = bootstrap();

const counts = new Map<string, number>();
const record = (parts: unknown[]) => {
  // Normalise away the varying tail so the same fault aggregates.
  const text = parts.map(p => (p instanceof Error ? `${p.name}: ${p.message}` : String(p))).join(' ');
  const key = text.split('\n')[0].slice(0, 140);
  counts.set(key, (counts.get(key) ?? 0) + 1);
};
console.warn = (...parts: unknown[]) => record(parts);
console.error = (...parts: unknown[]) => record(parts);

// A clean report only means something if the audit can see a dirty one, so
// AUDIT_SELFTEST removes the host method whose absence caused the ACTION_JOIN
// corruption and checks the failure is actually counted.
if (process.env.AUDIT_SELFTEST) {
  const { Unit } = await import('../src/host/index.ts');
  // @ts-expect-error deliberately breaking the host for the self-test
  delete Unit.prototype.removeUnit;
}

let matches = 0;
for (const file of [...NAVAL_MAPS, ...LAND_MAPS]) {
  for (const fog of [GameEnums.Fog_Off, GameEnums.Fog_OfWar]) {
    const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), file))), registry);
    map.getGameRules().setFogMode(fog);
    const game = new Game(map, registry, animations);
    map.vision.update();
    const env = new GameEnvironment(map, registry, { maxDays: 30, maxFieldChoices: 6, rng, seed: 1 }, game);
    env.reset(1);
    await playMatch(env, [new HeuristicAgent(), new HeuristicAgent()], { maxSteps: 6000 });
    matches++;
  }
}

const log = console.log;
log(`\n${matches} matches played (whole suite, fog off and on).`);
if (counts.size === 0) log('No swallowed failures.');
for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  log(`${String(n).padStart(6)}  ${key}`);
}
