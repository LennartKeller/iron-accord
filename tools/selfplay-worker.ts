/**
 * One self-play worker.
 *
 * Bootstrapping the Commander Wars scripts is the expensive part — hundreds of
 * files evaluated into a sandbox — so it happens once per worker and every job
 * afterwards reuses the registry. Maps are cached by path for the same reason.
 *
 * Run by plain `node` through type stripping, so nothing on this import path
 * may use TypeScript that needs code generation (parameter properties, enums,
 * decorators).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import { BudgetedValueNet } from '../src/ai/onnx-evaluator.ts';
import { loadValueNet } from '../src/ai/valuenet.node.ts';
import { HeuristicEvaluator } from '../src/ai/evaluator.ts';
import type { Evaluator } from '../src/ai/evaluator.ts';
import { GameEnvironment, HeuristicAgent, PlannerAgent, RandomAgent, playMatch } from '../src/ai/index.ts';
import type { Agent } from '../src/ai/index.ts';
import type { ActionDescriptor } from '../src/ai/actions.ts';

export interface Job {
  id: number;
  map: string;
  seed: number;
  fog: number;
  agents: string[];
  maxDays: number;
  /** Exploration for the heuristic seats; 0 keeps the agent deterministic. */
  epsilon?: number;
  topK?: number;
  /** Per-turn budget for planner seats, in nodes. 0 keeps the time budget. */
  plannerNodes?: number;
  /** Opponent-reply actions for planner seats; -1 keeps the planner default. */
  replyActions?: number;
  /** ONNX value net for planner seats; empty uses the hand-priced evaluation. */
  model?: string;
}

export interface Replay {
  map: string;
  seed: number;
  fog: number;
  agents: string[];
  winner: number | null;
  winningTeam: number | null;
  days: number;
  reason: string;
  /** Every action played, in order, with the seat that played it. */
  actions: Array<{ player: number; action: ActionDescriptor }>;
  ms: number;
}

const { registry, animations, rng } = bootstrap();
const sources = new Map<string, ReturnType<typeof readMap>>();

/**
 * `seed` matters only for the random agent, and it matters a lot: on a fixed
 * seed it replays one stream, so every game on a map comes out identical and
 * the slice adds no diversity at all — the exact failure the wider map pool is
 * meant to fix. Derived from the job seed, so a job still reproduces exactly.
 */
function agentFor(name: string, seed: number, job: Job): Agent {
  const epsilonFor = (job.epsilon ?? 0) > 0
    ? { epsilon: job.epsilon!, topK: job.topK ?? 3, seed }
    : null;
  if (name === 'planner') {
    // Exploration matters more here than for the heuristic: the planner picks
    // its whole turn by argmax, so without it planner self-play regenerates one
    // continuation per position and the data carries no counterfactual.
    return new PlannerAgent({
      timeBudgetMs: 150,
      nodeBudget: job.plannerNodes ?? 0,
      ...(job.replyActions !== undefined && job.replyActions >= 0
        ? { opponentReplyActions: job.replyActions } : {}),
      evaluator: sharedEvaluator ?? undefined,
      exploration: epsilonFor,
    });
  }
  if (name === 'random') return new RandomAgent(seed);
  // Exploration is seeded from the job so a generated game stays reproducible.
  return new HeuristicAgent({}, 'heuristic', epsilonFor);
}

/**
 * One evaluator per worker, not per game: building a session and its encoders
 * costs far more than a match, and the evaluator holds no per-game state.
 */
let sharedEvaluator: Evaluator<unknown> | null = null;

/**
 * Loads the value net once, on the first job that asks for one.
 *
 * The session and its per-board encoders cost far more to build than a match,
 * and neither holds per-game state, so one per worker is right. `maxPerLayer`
 * is the whole layer here: this is Node, where a forward pass is ~1.25 ms, and
 * capping it would put the hand-priced score back in charge of what gets
 * searched — the exact thing generating with the planner is meant to escape.
 */
async function ensureEvaluator(job: Job): Promise<void> {
  if (sharedEvaluator || !job.model) return;
  const net = await loadValueNet(job.model);
  sharedEvaluator = new BudgetedValueNet(net, new HeuristicEvaluator(), 64) as Evaluator<unknown>;
}

async function play(job: Job): Promise<Replay> {
  await ensureEvaluator(job);
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

  const actions: Replay['actions'] = [];
  const started = Date.now();
  const result = await playMatch(env, job.agents.map(
    (name, seat) => agentFor(name, job.seed * 31 + seat + 1, job)), {
    maxSteps: 8000,
    onStep: (_step, action, player) => { actions.push({ player, action }); },
  });

  return {
    map: job.map, seed: job.seed, fog: job.fog, agents: job.agents,
    winner: result.winner, winningTeam: game.over?.winningTeam ?? null,
    days: result.days, reason: result.reason, actions, ms: Date.now() - started,
  };
}

parentPort?.on('message', (job: Job | 'stop') => {
  if (job === 'stop') { parentPort?.close(); return; }
  play(job).then(
    replay => parentPort?.postMessage({ id: job.id, replay }),
    error => parentPort?.postMessage({ id: job.id, error: (error as Error).message }),
  );
});
