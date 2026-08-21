/**
 * Reproduces the value net stalling: every unit waits, forever.
 *
 *   npx vite-node tools/repro-stall.ts
 *   MAP='maps/2_player/Central Lake.map' FUNDS=1000 npx vite-node tools/repro-stall.ts
 *
 * Reports what the agent actually chose each turn, because "stuck in a loop"
 * has two very different causes: the agent picking `wait` over and over, or the
 * agent ending its turn with everything unmoved. They need different fixes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import { GameEnvironment, HeuristicAgent, PlannerAgent, HeuristicEvaluator, playMatch } from '../src/ai/index.ts';
import { BudgetedValueNet } from '../src/ai/onnx-evaluator.ts';
import { loadValueNet } from '../src/ai/valuenet.node.ts';
import { GameEnums } from '../src/host/index.ts';
import type { Agent } from '../src/ai/index.ts';
import type { Evaluator } from '../src/ai/evaluator.ts';

const { registry, animations, rng } = bootstrap();
const mapFile = process.env.MAP ?? 'maps/2_player/Central Lake.map';
const funds = Number(process.env.FUNDS ?? 1000);
const days = Number(process.env.DAYS ?? 12);
const which = process.env.AGENT ?? 'valuenet';
const budget = Number(process.env.BUDGET_MS ?? 250);

const evaluator = await loadValueNet();
const cap = Number(process.env.MAX_PER_LAYER ?? 0);
const budgeted = new BudgetedValueNet(evaluator, new HeuristicEvaluator(), cap || 1);
function agentFor(): Agent {
  if (which === 'heuristic') return new HeuristicAgent();
  if (which === 'planner') return new PlannerAgent({ timeBudgetMs: budget });
  if (which === 'budgeted') return new PlannerAgent({ timeBudgetMs: budget, evaluator: budgeted as Evaluator<unknown> });
  return new PlannerAgent({ timeBudgetMs: budget, evaluator: evaluator as Evaluator<unknown> });
}

const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), mapFile))), registry);
const FOG: Record<string, number> = {
  off: GameEnums.Fog_Off, war: GameEnums.Fog_OfWar, shroud: GameEnums.Fog_OfShroud,
};
map.getGameRules().setFogMode(FOG[process.env.FOG ?? 'off'] ?? GameEnums.Fog_Off);
for (const player of map.players) player.funds = funds;
const game = new Game(map, registry, animations);
map.vision.update();
const seed = Number(process.env.SEED ?? 1);
const env = new GameEnvironment(map, registry, { maxDays: days, maxFieldChoices: 6, rng, seed }, game);
env.reset(seed);

console.log(`${mapFile}  ${map.width}x${map.height}  funds ${funds}  agent ${which}  budget ${budget}ms\n`);

const quiet = process.env.QUIET === '1';
const perTurn = new Map<string, Map<string, number>>();
let unitsBuilt = 0;
const built = new Map<string, number>();

await playMatch(env, [agentFor(), agentFor()], {
  maxSteps: Number(process.env.MAX_STEPS ?? 4000),
  onStep: (_step, action, player) => {
    const key = `day ${String(game.day).padStart(2)} p${player}`;
    let counts = perTurn.get(key);
    if (!counts) { counts = new Map(); perTurn.set(key, counts); }
    // A 'unit' action that neither moves nor does anything but WAIT is the
    // shape a stall takes: legal, accepted, and completely inert.
    let label: string = action.kind;
    if (action.kind === 'unit') {
      const unit = map.units.find(u => u.uid === action.uid);
      const moved = unit ? (unit.x !== action.to.x || unit.y !== action.to.y) : true;
      label = `${action.actionId}${moved ? '' : '(inplace)'}`;
    }
    counts.set(label, (counts.get(label) ?? 0) + 1);
    if (action.kind === 'build') { unitsBuilt++; built.set(action.unitId, (built.get(action.unitId) ?? 0) + 1); }
  },
});

if (!quiet) for (const [turn, counts] of perTurn) {
  const parts = [...counts].map(([kind, n]) => `${kind}x${n}`).join(' ');
  console.log(`${turn}  ${parts}`);
}

if (!quiet) console.log('\nbuilt: ' + [...built].sort((a,b)=>b[1]-a[1]).map(([k,n])=>`${k}x${n}`).join(' '));
const terrain = new Map<string, number>();
for (let y=0;y<map.height;y++) for (let x=0;x<map.width;x++) {
  const t = map.getTerrain(x,y).getTerrainID();
  terrain.set(t,(terrain.get(t)??0)+1);
}
if (!quiet) console.log('terrain: ' + [...terrain].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,n])=>`${k}x${n}`).join(' '));
const units = map.players.map(p => p.units.length).join(' v ');
console.log(`\nended day ${game.day}, units ${units}, built ${unitsBuilt}, ` +
  `winner ${game.over?.winner ?? 'none'}`);
// What is the losing side actually holding at the end? A stall that cannot be
// closed out usually means the last units are somewhere the winner never looks.
for (const p of map.players) {
  if (p.units.length === 0 || p.units.length > 6) continue;
  console.log(`  p${p.getPlayerID()} remnant: ` + p.units
    .map(u => `${u.getUnitID()}@${u.x},${u.y}hp${u.getHp().toFixed(1)}`).join(' '));
}
const props = map.players.map(p => {
  let n = 0;
  for (let y=0;y<map.height;y++) for (let x=0;x<map.width;x++) {
    const b = map.getTerrain(x,y).getBuilding();
    if (b && b.getOwner() === p) n++;
  }
  return n;
}).join(' v ');
console.log(`  buildings ${props}`);

// A turn whose only action is ending it means nothing was attempted at all.
const idle = [...perTurn.values()].filter(c => c.size === 1 && c.has('endTurn')).length;
console.log(idle > 0 ? `STALL: ${idle}/${perTurn.size} turns did nothing but end` : 'no idle turns');
