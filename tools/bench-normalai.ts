/**
 * The ported Commander Wars NormalAi, against everything else we have.
 *
 *   npx vite-node tools/bench-normalai.ts
 *   NODES=400 MODEL=models/value.onnx npx vite-node tools/bench-normalai.ts
 *
 * The point of the port was an opponent authored outside this project, so that
 * "0.867 against greedy" finally has an external referent. Structure follows
 * bench-valuenet.ts deliberately -- same held-out maps, both seats, both fog
 * modes, and the mirror check first -- so the numbers sit beside the ones
 * already in the handoff doc rather than needing their own caveats.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import { GameEnvironment, HeuristicAgent, PlannerAgent, HeuristicEvaluator, playMatch } from '../src/ai/index.ts';
import { DEFAULT_PLANNER_OPTIONS } from '../src/ai/planner.ts';
import { BudgetedValueNet } from '../src/ai/onnx-evaluator.ts';
import { loadValueNet } from '../src/ai/valuenet.node.ts';
import { NormalAi } from '../src/ai/cw/normalai.ts';
import { GameEnums } from '../src/host/index.ts';
import { TRAIN_MAPS, VALIDATION_MAPS } from './tune-ai.ts';
import type { Agent } from '../src/ai/agent.ts';

const { registry, animations, rng } = bootstrap();
const nodeBudget = Number(process.env.NODES ?? 400);
const budget = Number(process.env.BUDGET_MS ?? 250);
const maxPerLayer = Number(process.env.MAX_PER_LAYER ?? 36);
const replyActions = Number(process.env.REPLY ?? DEFAULT_PLANNER_OPTIONS.opponentReplyActions);
const modelPath = process.env.MODEL ?? 'models/value.onnx';

const evaluator = fs.existsSync(modelPath) ? await loadValueNet(modelPath) : null;
const budgeted = evaluator
  ? new BudgetedValueNet(evaluator, new HeuristicEvaluator(), maxPerLayer) : null;

type Side = 'normalai' | 'greedy' | 'plain' | 'net';

function agentFor(side: Side, seed: number): Agent {
  switch (side) {
    case 'normalai': return new NormalAi({ seed });
    case 'greedy': return new HeuristicAgent();
    case 'plain':
      return new PlannerAgent({
        timeBudgetMs: budget, nodeBudget, opponentReplyActions: replyActions,
      });
    case 'net':
      return new PlannerAgent({
        timeBudgetMs: budget, nodeBudget, opponentReplyActions: replyActions,
        evaluator: budgeted ?? undefined,
      });
  }
}

async function duel(file: string, seed: number, fog: number, left: Side, right: Side, leftSeat: number) {
  const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), file))), registry);
  map.getGameRules().setFogMode(fog);
  const game = new Game(map, registry, animations);
  map.vision.update();
  const env = new GameEnvironment(map, registry, { maxDays: 60, maxFieldChoices: 6, rng, seed }, game);
  // The script RNG is process-wide; without a reset the previous match's combat
  // luck carries into this one.
  env.reset(seed);
  const agents = leftSeat === 0
    ? [agentFor(left, seed), agentFor(right, seed)]
    : [agentFor(right, seed), agentFor(left, seed)];
  const started = Date.now();
  const result = await playMatch(env, agents, { maxSteps: 6000 });
  return { winner: result.winner, ms: Date.now() - started, reason: result.reason };
}

async function series(label: string, left: Side, right: Side, maps: string[], fogs: number[]) {
  const tally = new Map<number, { wins: number; losses: number; draws: number; ms: number }>();
  for (const fog of fogs) tally.set(fog, { wins: 0, losses: 0, draws: 0, ms: 0 });
  let stepLimited = 0;

  for (const file of maps) {
    for (const fog of fogs) {
      for (const seat of [0, 1]) {
        const r = await duel(file, 1, fog, left, right, seat);
        const t = tally.get(fog)!;
        t.ms += r.ms;
        if (r.reason === 'step-limit') stepLimited++;
        if (r.winner === null) t.draws++;
        else if (r.winner === seat) t.wins++;
        else t.losses++;
      }
    }
  }

  let wins = 0, losses = 0, draws = 0, ms = 0;
  for (const t of tally.values()) { wins += t.wins; losses += t.losses; draws += t.draws; ms += t.ms; }
  const played = wins + losses + draws;
  const rate = (wins + draws / 2) / played;
  const split = fogs.map(fog => {
    const t = tally.get(fog)!;
    const n = t.wins + t.losses + t.draws;
    return `${fog === GameEnums.Fog_Off ? 'off' : 'war'} ${((t.wins + t.draws / 2) / n).toFixed(3)}`;
  }).join('  ');
  console.log(`${label.padEnd(30)} ${wins}W ${losses}L ${draws}D  rate ${rate.toFixed(3)}  ` +
    `[fog ${split}]  n=${played}  ${(ms / played / 1000).toFixed(1)}s/match` +
    (stepLimited > 0 ? `  STEP-LIMITED ${stepLimited}` : ''));
  return rate;
}

/**
 * Defaults to the same held-out list the value-net numbers in the handoff doc
 * were measured on, so this sits directly beside "net v greedy" rather than
 * needing its own caveats. VALIDATION_MAPS is only six boards -- 24 matches,
 * standard error near 0.1 -- which cannot separate anything.
 */
const mapsFile = process.env.MAPS_FILE ?? 'data/heldout-maps.json';
const maps = process.env.MAPS === 'all'
  ? [...TRAIN_MAPS, ...VALIDATION_MAPS]
  : (fs.existsSync(mapsFile) ? JSON.parse(fs.readFileSync(mapsFile, 'utf8')) as string[]
    : VALIDATION_MAPS);
const fogs = [GameEnums.Fog_Off, GameEnums.Fog_OfWar];

console.log(`model ${evaluator ? modelPath : '(none found -- net series skipped)'}`);
console.log(`${nodeBudget} nodes/turn, maxPerLayer ${maxPerLayer}, reply ${replyActions}, ` +
  `${maps.length} maps, both fog modes\n`);

// If a mirror duel is not exactly 0.500 the harness is biased and nothing below
// it means anything.
const mirror = await series('mirror (greedy v greedy)', 'greedy', 'greedy', maps, fogs);
if (Math.abs(mirror - 0.5) > 1e-9) {
  console.log(`\nHARNESS BIASED: mirror returned ${mirror.toFixed(3)}, expected 0.500. Stop.`);
  process.exit(1);
}
// NormalAi against itself must also be 0.500, or the port carries a seat bias
// and every number below it is measuring that instead.
const selfMirror = await series('mirror (normalai v normalai)', 'normalai', 'normalai', maps, fogs);
if (Math.abs(selfMirror - 0.5) > 1e-9) {
  console.log(`\nPORT SEAT-BIASED: normalai mirror returned ${selfMirror.toFixed(3)}. Stop.`);
  process.exit(1);
}
console.log('');

await series('normalai v greedy', 'normalai', 'greedy', maps, fogs);
await series('normalai v plain planner', 'normalai', 'plain', maps, fogs);
if (budgeted) await series('normalai v net planner', 'normalai', 'net', maps, fogs);
