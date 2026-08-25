/**
 * What is wrong with this agent, as opposed to how often it wins.
 *
 * A win rate against one opponent is the wrong instrument for two reasons, both
 * of which this project has now hit. It reports an AVERAGE, so a policy that is
 * strong generally and catastrophic against one style scores well — exploitable
 * in the sense that matters. And it cannot see a MUTUAL pathology at all: two
 * agents that both buy immobile units and block their own factories draw, score
 * 0.500 against each other, and look unremarkable. That is exactly how PIPERUNNER
 * production survived in 96% of the training data until someone watched a game.
 *
 * So this reports two things a rate does not:
 *
 *   worst case over a panel of opponents, rather than the mean, which is the
 *   cheap stand-in for exploitability: a best-response opponent is the real
 *   measure, but a diverse panel catches the same class of hole for far less
 *   compute;
 *
 *   pathology signatures from the agent playing ITSELF, where mutual failures
 *   live — factories blocked by their owner's units, units that cannot leave
 *   the tile they were built on, and games that end on the day limit rather
 *   than by anyone winning.
 *
 *   MODEL=models/value.onnx npx vite-node tools/probe-agent.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import { GameEnvironment, HeuristicAgent, PlannerAgent, RandomAgent, HeuristicEvaluator, playMatch } from '../src/ai/index.ts';
import { BudgetedValueNet } from '../src/ai/onnx-evaluator.ts';
import { loadValueNet } from '../src/ai/valuenet.node.ts';
import { computeMovementRange } from '../src/game/pathfinding.ts';
import { GameEnums } from '../src/host/index.ts';
import type { Agent } from '../src/ai/agent.ts';
import type { Evaluator } from '../src/ai/evaluator.ts';

const { registry, animations, rng } = bootstrap();
const modelPath = process.env.MODEL ?? '';
const nodes = Number(process.env.NODES ?? 400);
const mapLimit = Number(process.env.MAP_LIMIT ?? 8);
const maps: string[] = JSON.parse(fs.readFileSync(
  process.env.MAPS_FILE ?? 'data/heldout-maps.json', 'utf8')).slice(0, mapLimit);

const evaluator = modelPath ? await loadValueNet(modelPath) : null;
const budgeted = evaluator
  ? new BudgetedValueNet(evaluator, new HeuristicEvaluator(), 36) as Evaluator<unknown> : undefined;

/** The agent under test, and the panel it is measured against. */
const subject = (): Agent => new PlannerAgent({ nodeBudget: nodes, evaluator: budgeted });
const panel: Record<string, () => Agent> = {
  greedy: () => new HeuristicAgent(),
  random: () => new RandomAgent(7),
  'plain planner': () => new PlannerAgent({ nodeBudget: nodes }),
  'deep plain': () => new PlannerAgent({ nodeBudget: nodes * 4 }),
};

interface Quality {
  games: number; draws: number; dayLimit: number;
  blockedFactoryTurns: number; immobileUnits: number; days: number;
}
const quality: Quality = { games: 0, draws: 0, dayLimit: 0, blockedFactoryTurns: 0, immobileUnits: 0, days: 0 };

function inspect(game: Game): void {
  for (const player of game.map.players) {
    for (let y = 0; y < game.map.height; y++) {
      for (let x = 0; x < game.map.width; x++) {
        const building = game.map.getTerrain(x, y).getBuilding();
        if (!building?.canBuildUnits() || building.getOwner() !== player) continue;
        const occupant = game.map.getUnitAt(x, y);
        // A factory its owner has parked a unit on cannot produce.
        if (occupant && occupant.getOwner() === player) quality.blockedFactoryTurns++;
      }
    }
  }
  for (const unit of game.map.units) {
    if (computeMovementRange(game.map, unit).tiles.size <= 1) quality.immobileUnits++;
  }
}

async function play(file: string, fog: number, left: () => Agent, right: () => Agent, seat: number, watch: boolean) {
  const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), file))), registry);
  map.getGameRules().setFogMode(fog);
  const game = new Game(map, registry, animations);
  map.vision.update();
  const env = new GameEnvironment(map, registry, { maxDays: 60, maxFieldChoices: 6, rng, seed: 1 }, game);
  env.reset(1);
  const agents = seat === 0 ? [left(), right()] : [right(), left()];
  const result = await playMatch(env, agents, { maxSteps: 6000 });
  if (watch) {
    quality.games++; quality.days += result.days;
    if (result.winner === null) quality.draws++;
    if (result.reason === 'day-limit') quality.dayLimit++;
    inspect(game);
  }
  return result;
}

const fogs = [GameEnums.Fog_Off, GameEnums.Fog_OfWar];
console.log(`${modelPath || 'hand-priced planner'}, ${nodes} nodes, ${maps.length} maps\n`);

const rates: Array<[string, number]> = [];
for (const [name, opponent] of Object.entries(panel)) {
  let wins = 0, losses = 0, draws = 0;
  for (const file of maps) for (const fog of fogs) for (const seat of [0, 1]) {
    const r = await play(file, fog, subject, opponent, seat, false);
    if (r.winner === null) draws++; else if (r.winner === seat) wins++; else losses++;
  }
  const played = wins + losses + draws;
  const rate = (wins + draws / 2) / played;
  rates.push([name, rate]);
  console.log(`  v ${name.padEnd(15)} ${rate.toFixed(3)}  (${wins}W ${losses}L ${draws}D)`);
}

const worst = rates.reduce((a, b) => (b[1] < a[1] ? b : a));
console.log(`\n  worst case:  ${worst[1].toFixed(3)} v ${worst[0]}   <- the number that matters`);

// Self-play, where mutual pathologies live.
for (const file of maps) for (const fog of fogs) await play(file, fog, subject, subject, 0, true);
const q = quality;
console.log(`\nself-play quality over ${q.games} games:`);
console.log(`  draws                 ${(q.draws / q.games * 100).toFixed(0)}%`);
console.log(`  ended on day limit    ${(q.dayLimit / q.games * 100).toFixed(0)}%   <- nobody could finish`);
console.log(`  mean days             ${(q.days / q.games).toFixed(1)}`);
console.log(`  blocked own factories ${(q.blockedFactoryTurns / q.games).toFixed(2)} per game at end`);
console.log(`  immobile units left   ${(q.immobileUnits / q.games).toFixed(2)} per game at end   <- the PIPERUNNER signature`);
