import { expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { snapshot } from '../src/game/snapshot.ts';
import { GameEnvironment } from '../src/ai/environment.ts';
import { NormalAi } from '../src/ai/cw/normalai.ts';
import type { MoveUnitData } from '../src/ai/cw/unitdata.ts';
import type { Player } from '../src/host/index.ts';
import { applyAction, type ActionDescriptor } from '../src/ai/actions.ts';

const { registry, createMap, animations, rng } = bootstrap();
interface Internals {
  ownUnits: MoveUnitData[];
  enemyUnits: MoveUnitData[];
  refresh(game: Game, player: Player): void;
  bestShotFrom(game: Game, data: MoveUnitData, from: { x: number; y: number }): ActionDescriptor | null;
}
function battle() {
  const map = createMap(7, 7);
  const player = map.addPlayer('os');
  const enemy = map.addPlayer('bm');
  enemy.team = 1;
  const tank = map.addUnit('LIGHT_TANK', player, 2, 2);
  const infantry = map.addUnit('INFANTRY', enemy, 3, 2);
  const defender = map.addUnit('LIGHT_TANK', enemy, 2, 3);
  const game = new Game(map, registry, animations);
  const env = new GameEnvironment(map, registry, { rng }, game);
  const ai = new NormalAi();
  ai.beginTurn(env);
  const cache = ai as unknown as Internals;
  return { player, tank, infantry, defender, game, env, ai, cache };
}

it('chooses the more valuable tank trade for a follow-up shot and produces a legal action', () => {
  const { player, tank, defender, game, cache } = battle();
  cache.refresh(game, player);
  const action = cache.bestShotFrom(game, cache.ownUnits[0], tank);
  expect(action).toMatchObject({ kind: 'unit', actionId: 'ACTION_FIRE', target: { x: defender.x, y: defender.y } });
  expect(applyAction(game, action!)).toBe(true);
});

it('distributes projected damage once per turn and preserves it across cache rebuilds', () => {
  const { player, game, env, ai, cache } = battle();
  const before = snapshot(game);
  const randomBefore = rng.getState();
  cache.refresh(game, player);
  // Two unique defenders split the one ally's projected damage: 6 * HP / 2.
  const damage = () => cache.enemyUnits.map(data => data.virtualDamageData);
  expect(damage()).toEqual([7.65 * 3, 5.4 * 3]);
  const initial = damage();
  cache.refresh(game, player);
  expect(damage()).toEqual(initial);
  ai.beginTurn(env);
  cache.refresh(game, player);
  expect(damage()).toEqual(initial);
  expect(snapshot(game)).toEqual(before);
  expect(rng.getState()).toBe(randomBefore);
});
