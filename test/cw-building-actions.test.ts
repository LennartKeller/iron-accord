import { expect, it, vi } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { snapshot } from '../src/game/snapshot.ts';
import { BuildingHost } from '../src/host/building.ts';
import { NormalAi } from '../src/ai/cw/normalai.ts';
import { GameEnvironment } from '../src/ai/environment.ts';
import { applyAction } from '../src/ai/actions.ts';
import { selectBuildingAction } from '../src/ai/cw/building-actions.ts';

const { registry, createMap, animations, rng } = bootstrap();
function battle() {
  const map = createMap(8, 7);
  const owner = map.addPlayer('os');
  const enemy = map.addPlayer('bm'); enemy.team = 1;
  const cannon = new BuildingHost(map, 'ZMINICANNON_E', owner);
  const terrain = map.getTerrain(1, 3);
  terrain.building = cannon; cannon.setTerrain(terrain); cannon.init(); cannon.setFireCount(1);
  map.addUnit('INFANTRY', owner, 0, 0);
  const cheap = map.addUnit('INFANTRY', enemy, 2, 3);
  const valuable = map.addUnit('HEAVY_TANK', enemy, 3, 3);
  const game = new Game(map, registry, animations);
  return { map, owner, enemy, cannon, cheap, valuable, game };
}

it('fires an owned cannon before ordinary unit orders at the most valuable offered target', async () => {
  const { map, game, cannon, cheap, valuable } = battle();
  const ai = new NormalAi();
  const env = new GameEnvironment(map, registry, { rng }, game);
  ai.beginTurn(env);
  const before = snapshot(game);
  const action = await ai.selectAction(env);
  expect(snapshot(game)).toEqual(before);
  expect(action).toEqual({ kind: 'building', at: { x: 1, y: 3 }, actionId: 'ACTION_CANNON_FIRE', steps: [{ x: 3, y: 3 }] });
  expect(applyAction(game, action!)).toBe(true);
  expect(valuable.getHp()).toBe(7);
  expect(cheap.getHp()).toBe(10);
  expect(cannon.getFireCount()).toBe(0);
  expect(selectBuildingAction(game, [cannon], () => 0)).toBeNull();
});

it('rejects foreign, unoffered and invalid-target building orders without spending their shot', () => {
  const { game, cannon, enemy } = battle();
  const at = { x: 1, y: 3 };
  const before = snapshot(game);
  expect(game.performBuildingAction(at, 'ACTION_CANNON_FIRE', [{ x: 0, y: 0 }])).toBe(false);
  expect(game.performBuildingAction(at, 'ACTION_EXPLODE')).toBe(false);
  expect(game.performBuildingAction(at, 'ACTION_CANNON_FIRE')).toBe(false);
  expect(snapshot(game)).toEqual(before);
  cannon.setOwner(enemy);
  expect(game.performBuildingAction(at, 'ACTION_CANNON_FIRE', [{ x: 3, y: 3 }])).toBe(false);
  expect(cannon.getFireCount()).toBe(1);
});

it('recomputes silo desirability after a building action without initializing stale unit forecasts', async () => {
  const { map, game, owner } = battle();
  const ai = new NormalAi();
  const env = new GameEnvironment(map, registry, { rng }, game);
  ai.beginTurn(env);
  const silo = vi.spyOn(owner, 'getSiloRockettarget').mockReturnValue({ x: 3, y: 3, damage: 100000 });
  const state = ai as unknown as { core: { missileTarget: boolean }; virtualDamageInitialized: boolean };
  const action = await ai.selectAction(env);
  expect(state.core.missileTarget).toBe(true);
  expect(state.virtualDamageInitialized).toBe(false);
  expect(applyAction(game, action!)).toBe(true);
  silo.mockReturnValue({ x: 3, y: 3, damage: 0 });
  await ai.selectAction(env);
  expect(state.core.missileTarget).toBe(false);
  expect(state.virtualDamageInitialized).toBe(true);
  expect(silo).toHaveBeenCalledTimes(2);
  silo.mockRestore();
});
