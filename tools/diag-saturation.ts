/**
 * Does the value net still distinguish moves once the game is decided?
 *
 * A tanh head saturates: in a position that is already won, every continuation
 * scores +1 and the beam has nothing to rank. The planner then has no reason to
 * prefer killing the last enemy over waiting, which is what a game that never
 * ends looks like from the outside.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import { GameEnvironment, PlannerAgent, HeuristicEvaluator, Belief, playMatch, enumerateActions, applyAction } from '../src/ai/index.ts';
import { loadValueNet } from '../src/ai/valuenet.node.ts';
import { GameEnums } from '../src/host/index.ts';
import type { Evaluator } from '../src/ai/evaluator.ts';

const { registry, animations, rng } = bootstrap();
const net = await loadValueNet();
const hand = new HeuristicEvaluator();

const map = loadIntoGameMap(readMap(fs.readFileSync(
  path.join(cwRoot(), 'maps/2_player/Central Lake.map'))), registry);
map.getGameRules().setFogMode(GameEnums.Fog_OfWar);
for (const p of map.players) p.funds = 1000;
const game = new Game(map, registry, animations);
map.vision.update();
const env = new GameEnvironment(map, registry, { maxDays: 200, maxFieldChoices: 6, rng, seed: 1 }, game);
env.reset(1);

const stopDay = Number(process.env.STOP_DAY ?? 40);
await playMatch(env, [
  new PlannerAgent({ timeBudgetMs: 250, evaluator: net as Evaluator<unknown> }),
  new PlannerAgent({ timeBudgetMs: 250, evaluator: net as Evaluator<unknown> }),
], { maxSteps: 40000, onStep: () => { if (game.day >= stopDay) throw new Error('stop'); } })
  .catch(e => { if ((e as Error).message !== 'stop') throw e; });

const self = game.currentPlayer;
const belief = new Belief(self);
belief.observe(game);
const counts = map.players.map(p => p.units.length).join(' v ');
console.log(`day ${game.day}, units ${counts}, scoring player ${self.getPlayerID()}`);

// Score every legal opening move by playing it and evaluating the result.
const legal = enumerateActions(game, { maxFieldChoices: 6 }).filter(a => a.kind !== 'endTurn');
const netScores: number[] = [], handScores: number[] = [];
let tried = 0;
for (const action of legal.slice(0, 120)) {
  const ok = env.explore(() => {
    if (!applyAction(game, action)) return null;
    return { n: net.capture(game, self, belief), h: hand.capture(game, self, belief) };
  });
  if (!ok) continue;
  netScores.push((await net.score([ok.n]))[0]);
  handScores.push(ok.h);
  tried++;
}

// The decisive comparison: the planner keeps the empty plan unless some child
// beats the position as it already stands.
const openingNet = (await net.score([net.capture(game, self, belief)]))[0];
const openingHand = hand.score([hand.capture(game, self, belief)])[0];
console.log(`\nopening (do nothing): net ${openingNet.toFixed(1)}  heuristic ${openingHand.toFixed(1)}`);
const netBeat = netScores.filter(v => v > openingNet).length;
const handBeat = handScores.filter(v => v > openingHand).length;
console.log(`children beating it: net ${netBeat}/${netScores.length}  heuristic ${handBeat}/${handScores.length}`);
if (netBeat === 0) console.log('=> planner returns the EMPTY plan: every move looks worse than standing still');

const stat = (xs: number[]) => {
  const min = Math.min(...xs), max = Math.max(...xs);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { min, max, mean, sd, distinct: new Set(xs.map(x => x.toFixed(6))).size };
};
const n = stat(netScores), h = stat(handScores);
console.log(`\n${tried} legal moves scored`);
console.log(`value net : range ${n.min.toFixed(1)}..${n.max.toFixed(1)}  spread ${(n.max-n.min).toFixed(2)}  sd ${n.sd.toFixed(2)}  distinct ${n.distinct}`);
console.log(`heuristic : range ${h.min.toFixed(1)}..${h.max.toFixed(1)}  spread ${(h.max-h.min).toFixed(2)}  sd ${h.sd.toFixed(2)}  distinct ${h.distinct}`);
console.log(`\nnet tanh pre-scale: ${(n.min/100000).toFixed(6)}..${(n.max/100000).toFixed(6)}`);
