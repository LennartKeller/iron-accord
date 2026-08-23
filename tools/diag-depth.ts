/**
 * Does a deeper plan overpromise? The direct test of the depth paradox.
 *
 * The beam search expands only the acting player's actions — no endTurn, no
 * opponent reply anywhere in `plan()` — and `selectAction` executes the adopted
 * plan blindly until a step goes illegal. Two mechanical consequences follow,
 * and this tool measures both instead of arguing about them:
 *
 *   1. The plan's promised score is the evaluator's opinion of a position in
 *      the middle of the planner's own turn, against a frozen enemy. The
 *      position the game actually reaches — end of the turn, then the start of
 *      the next one after the opponent has replied — can be scored with the
 *      same evaluator. `predicted - actual`, as a function of plan length, is
 *      the overpromise curve. If it rises with plan length, deeper search
 *      buys systematically less honest promises.
 *
 *   2. Longer plans should break more often (a queued step going illegal dumps
 *      the whole tail), so the broken-plan rate per plan length is the direct
 *      test of brittleness.
 *
 * Runs fog OFF only, deliberately: the reference scoring below builds a fresh
 * Belief per measurement, which under fog would lack the planner's memory and
 * pollute the comparison. Fog off, a fresh Belief sees exactly what the
 * planner's did.
 *
 *   NODES=200,1600 MAP_LIMIT=6 npx vite-node tools/diag-depth.ts
 *
 * NODES (a comma list) keeps every comparison reproducible; there is no
 * wall-clock mode here on purpose. Win rates over so few matches are noise
 * (SE ~0.14 at 12 matches) and are printed only as context, never as findings.
 * The per-turn gap statistics are the point: hundreds of planner turns per
 * cell, so their standard errors are honest.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import {
  GameEnvironment, HeuristicAgent, PlannerAgent, HeuristicEvaluator, Belief, playMatch,
} from '../src/ai/index.ts';
import { GameEnums } from '../src/host/index.ts';
import { VALIDATION_MAPS } from './tune-ai.ts';

const { registry, animations, rng } = bootstrap();

const budgets = (process.env.NODES ?? '200,1600').split(',').map(Number);
const mapLimit = Number(process.env.MAP_LIMIT ?? 6);
/** Opponent-reply verification (PlannerOptions.opponentReplyActions). 0 = off. */
const reply = Number(process.env.REPLY ?? 0);
const maps = VALIDATION_MAPS.slice(0, mapLimit);

/** One planner turn: what the search promised, and what the game delivered. */
interface TurnRecord {
  turnId: number;
  planLength: number;
  scored: number;
  depthSearched: number;
  predicted: number;
  opening: number;
  /** Same evaluator, on the position when the planner ends its turn. */
  endOfTurn?: number;
  /** Same evaluator, at the start of the planner's next turn — opponent replied. */
  nextTurn?: number;
  broken?: { executed: number; planned: number };
}

const reference = new HeuristicEvaluator();

function scoreNow(game: Game, seat: number): number | undefined {
  const player = game.map.getPlayer(seat);
  if (!player) return undefined;
  const belief = new Belief(player);
  belief.observe(game);
  return reference.score([reference.capture(game, player, belief)])[0];
}

async function playOne(file: string, seed: number, plannerSeat: number, nodeBudget: number) {
  const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), file))), registry);
  map.getGameRules().setFogMode(GameEnums.Fog_Off);
  const game = new Game(map, registry, animations);
  map.vision.update();
  const env = new GameEnvironment(map, registry, { maxDays: 60, maxFieldChoices: 6, rng, seed }, game);
  env.reset(seed);

  const records: TurnRecord[] = [];
  const byTurn = new Map<number, TurnRecord>();
  let current: TurnRecord | null = null;
  /**
   * The previous planner turn's record. `onPlan` for turn t+1 fires inside
   * selectAction, BEFORE the first onStep of that turn, so by the time onStep
   * can measure "the position after the opponent replied" the record for turn
   * t has already been rotated out of `current`.
   */
  let previous: TurnRecord | null = null;

  const planner = new PlannerAgent({
    // A huge time budget so only the node budget is ever the limiter.
    timeBudgetMs: 3_600_000,
    nodeBudget,
    opponentReplyActions: reply,
    diagnostics: {
      onPlan: info => {
        const record: TurnRecord = {
          turnId: info.turnId, planLength: info.planLength, scored: info.scored,
          depthSearched: info.depthSearched, predicted: info.predictedScore,
          opening: info.openingScore,
        };
        records.push(record);
        byTurn.set(info.turnId, record);
        previous = current;
        current = record;
      },
      onPlanBroken: info => {
        const record = byTurn.get(info.turnId);
        if (record) record.broken = { executed: info.executed, planned: info.planned };
      },
    },
  });
  const greedy = new HeuristicAgent();
  const agents = plannerSeat === 0 ? [planner, greedy] : [greedy, planner];

  let prevPlayer = -1;
  const result = await playMatch(env, agents, {
    maxSteps: 6000,
    // onStep fires BEFORE the action is applied, so the board seen here is the
    // position the action is about to be played from.
    onStep: (_step, action, player) => {
      if (player === plannerSeat && previous && previous.nextTurn === undefined
          && prevPlayer !== -1 && prevPlayer !== plannerSeat) {
        // First planner action of a new turn: the opponent has replied and the
        // day boundary (income, repairs) has run. This is "reality" for the
        // PREVIOUS turn's promise.
        previous.nextTurn = scoreNow(game, plannerSeat);
      }
      if (player === plannerSeat && action.kind === 'endTurn' && current
          && current.endOfTurn === undefined) {
        current.endOfTurn = scoreNow(game, plannerSeat);
      }
      prevPlayer = player;
    },
  });
  return { records, result };
}

function mean(xs: number[]) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function sem(xs: number[]) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  const variance = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance / xs.length);
}
function pearson(xs: number[], ys: number[]) {
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

const BUCKETS: Array<[string, (n: number) => boolean]> = [
  ['0      ', n => n === 0],
  ['1-3    ', n => n >= 1 && n <= 3],
  ['4-6    ', n => n >= 4 && n <= 6],
  ['7-11   ', n => n >= 7 && n <= 11],
  ['12+    ', n => n >= 12],
];

console.log(`maps: ${maps.length} (validation), both seats, fog off, seed 1, hand evaluator`);
console.log(`budgets: ${budgets.join(', ')} nodes/turn; opponent reply ${reply || 'off'}\n`);

for (const nodes of budgets) {
  const all: TurnRecord[] = [];
  let wins = 0, losses = 0, draws = 0;
  for (const file of maps) {
    for (const seat of [0, 1]) {
      const { records, result } = await playOne(file, 1, seat, nodes);
      all.push(...records);
      if (result.winner === null) draws++;
      else if (result.winner === seat) wins++;
      else losses++;
    }
  }

  // Only turns with both reality measurements count; the last turn of a match
  // has no "next turn" and is dropped rather than imputed.
  const complete = all.filter(r => r.endOfTurn !== undefined && r.nextTurn !== undefined);
  const lengths = complete.map(r => r.planLength);
  const overEnd = complete.map(r => r.predicted - r.endOfTurn!);
  const overNext = complete.map(r => r.predicted - r.nextTurn!);
  const brokenAll = all.filter(r => r.broken);

  console.log(`=== ${nodes} nodes ===`);
  console.log(`context only (noise at this n): planner ${wins}W ${losses}L ${draws}D`);
  console.log(`turns measured ${complete.length} (of ${all.length} planned)`);
  console.log(`plan length: mean ${mean(lengths).toFixed(2)}, ` +
    `p50 ${[...lengths].sort((a, b) => a - b)[Math.floor(lengths.length / 2)]}, ` +
    `max ${Math.max(...lengths)};  nodes spent: mean ${mean(all.map(r => r.scored)).toFixed(0)}, ` +
    `depth searched: mean ${mean(all.map(r => r.depthSearched)).toFixed(1)}`);
  console.log(`plans broken mid-execution: ${brokenAll.length}/${all.length} ` +
    `(${(100 * brokenAll.length / all.length).toFixed(1)}%)` +
    (brokenAll.length
      ? `, executed before break: mean ${mean(brokenAll.map(r => r.broken!.executed)).toFixed(1)}` +
        ` of ${mean(brokenAll.map(r => r.broken!.planned)).toFixed(1)} planned`
      : ''));
  console.log(`overpromise end-of-turn  (predicted - actual): ` +
    `${mean(overEnd).toFixed(0)} +- ${sem(overEnd).toFixed(0)}`);
  console.log(`overpromise next-turn    (predicted - actual): ` +
    `${mean(overNext).toFixed(0)} +- ${sem(overNext).toFixed(0)}`);
  console.log(`corr(plan length, overpromise next-turn): ` +
    `${pearson(lengths, overNext).toFixed(3)}   (n=${complete.length})`);

  console.log(`by plan length:  n      overEnd            overNext           broken%`);
  for (const [label, test] of BUCKETS) {
    const rows = complete.filter(r => test(r.planLength));
    if (rows.length === 0) continue;
    const oe = rows.map(r => r.predicted - r.endOfTurn!);
    const on = rows.map(r => r.predicted - r.nextTurn!);
    const broken = rows.filter(r => r.broken).length;
    console.log(`  ${label}      ${String(rows.length).padStart(4)}  ` +
      `${mean(oe).toFixed(0).padStart(7)} +- ${sem(oe).toFixed(0).padEnd(6)} ` +
      `${mean(on).toFixed(0).padStart(7)} +- ${sem(on).toFixed(0).padEnd(6)} ` +
      `${(100 * broken / rows.length).toFixed(0).padStart(5)}%`);
  }
  console.log('');
}
