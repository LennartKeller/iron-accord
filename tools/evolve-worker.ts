/**
 * One match worker for tools/evolve-normalai.ts.
 *
 * Plays a Commander Wars AI with one set of tunables against another and
 * reports who won, when, and how the two sides stood at the end. The scripts
 * are loaded once per worker and maps are cached, as in selfplay-worker.ts.
 *
 * Run by plain `node` through type stripping, so nothing on this import path
 * may use TypeScript that needs code generation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import { GameEnvironment, NormalAi, playMatch } from '../src/ai/index.ts';
import type { NormalAiConfig } from '../src/ai/cw/config.ts';

export interface MatchJob {
  id: number;
  map: string;
  fog: number;
  seed: number;
  maxDays: number;
  /** Tunables per seat; null plays the shipped profile. */
  configs: Array<Partial<NormalAiConfig> | null>;
}

export interface MatchOutcome {
  id: number;
  winner: number | null;
  days: number;
  reason: string;
  /** Army value plus three turns of income, per seat, at the final position. */
  standing: number[];
  ms: number;
  error?: string;
}

const { registry, animations, rng } = bootstrap();
const sources = new Map<string, ReturnType<typeof readMap>>();
console.warn = () => {};

async function play(job: MatchJob): Promise<MatchOutcome> {
  let source = sources.get(job.map);
  if (!source) {
    source = readMap(fs.readFileSync(path.join(cwRoot(), job.map)));
    sources.set(job.map, source);
  }
  const map = loadIntoGameMap(source, registry);
  map.getGameRules().setFogMode(job.fog);
  const game = new Game(map, registry, animations);
  map.vision.update();
  const env = new GameEnvironment(
    map, registry, { maxDays: job.maxDays, maxFieldChoices: 6, rng, seed: job.seed }, game);
  env.reset(job.seed);

  const started = Date.now();
  // Both seats share the match seed, so swapping the two configs replays the
  // same dice with the sides exchanged.
  const agents = job.configs.map(config => new NormalAi({ seed: job.seed, config: config ?? undefined }));
  const result = await playMatch(env, agents, { maxSteps: 12000 });
  const standing = map.players.map(player => {
    let army = 0;
    for (const unit of player.units) army += unit.getCosts() * (unit.getHp() / 10);
    return army + 3 * player.calcIncome();
  });
  return { id: job.id, winner: result.winner, days: result.days, reason: result.reason, standing, ms: Date.now() - started };
}

parentPort?.on('message', (job: MatchJob | 'stop') => {
  if (job === 'stop') { parentPort?.close(); return; }
  play(job).then(
    outcome => parentPort?.postMessage(outcome),
    error => parentPort?.postMessage({
      id: job.id, winner: null, days: 0, reason: 'error', standing: [0, 0], ms: 0, error: (error as Error).message,
    } satisfies MatchOutcome),
  );
});
