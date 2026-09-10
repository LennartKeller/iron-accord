import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { snapshot } from '../src/game/snapshot.ts';
import { GameEnums } from '../src/host/index.ts';
import { BuildingHost } from '../src/host/building.ts';
import { GameEnvironment } from '../src/ai/environment.ts';
import { NormalAi } from '../src/ai/cw/normalai.ts';
import { CoreAI } from '../src/ai/cw/coreai.ts';
import { NORMAL_AI_DEFAULTS } from '../src/ai/cw/config.ts';
import { moveBlackBombs, moveFlares, moveOoziums } from '../src/ai/cw/special-actions.ts';
import { applyAction } from '../src/ai/actions.ts';

const { registry, createMap, animations, rng } = bootstrap();
function battlefield(width = 12, height = 7) {
  const map = createMap(width, height);
  const player = map.addPlayer('os');
  const enemyPlayer = map.addPlayer('bm');
  enemyPlayer.team = 1;
  const game = new Game(map, registry, animations);
  const ai = new CoreAI(game, player, { ...NORMAL_AI_DEFAULTS });
  return { map, game, ai, player, enemyPlayer };
}

describe('NormalAi special actions', () => {
  it('fires a legal stationary flare into fog, consuming ammo and revealing the area', () => {
    const { map, game, ai, player, enemyPlayer } = battlefield();
    const flare = map.addUnit('FLARE', player, 2, 3);
    map.addUnit('INFANTRY', enemyPlayer, 11, 6);
    map.rules.fogMode = GameEnums.Fog_OfWar;
    map.vision.update();
    const before = snapshot(game), randomBefore = rng.getState();
    const ammo = flare.ammo1;
    const action = moveFlares(ai, [flare], () => 0);
    expect(action).toMatchObject({ kind: 'unit', actionId: 'ACTION_FLARE', to: { x: 2, y: 3 } });
    expect(snapshot(game)).toEqual(before);
    expect(rng.getState()).toBe(randomBefore);
    expect(applyAction(game, action!)).toBe(true);
    expect(flare.ammo1).toBe(ammo - 1);
    expect(flare.hasMoved).toBe(true);
    expect(player.visionFields.length).toBeGreaterThan(0);
    const target = action!.kind === 'unit' ? action!.steps![0] : null;
    expect(typeof target).toBe('object');
    if (target && typeof target !== 'string') expect(player.getFieldVisible(target.x, target.y)).toBe(true);
  });

  it('does not spend a flare with clear vision or an empty launcher', () => {
    const { map, ai, player } = battlefield();
    const flare = map.addUnit('FLARE', player, 2, 3);
    expect(moveFlares(ai, [flare], () => 0)).toBeNull();
    map.rules.fogMode = GameEnums.Fog_OfWar;
    map.vision.update();
    flare.ammo1 = 0;
    expect(moveFlares(ai, [flare], () => 0)).toBeNull();
  });

  it('chooses the same flare area when hidden enemy positions change', () => {
    const { map, ai, player, enemyPlayer } = battlefield();
    const flare = map.addUnit('FLARE', player, 2, 3);
    const enemy = map.addUnit('INFANTRY', enemyPlayer, 7, 3);
    map.rules.fogMode = GameEnums.Fog_OfWar;
    map.vision.update();
    expect(enemy.isStealthed(player)).toBe(true);
    const before = moveFlares(ai, [flare], () => 0);
    map.removeUnit(enemy);
    const relocated = map.addUnit('INFANTRY', enemyPlayer, 10, 3);
    map.vision.update();
    expect(relocated.isStealthed(player)).toBe(true);
    expect(moveFlares(ai, [flare], () => 0)).toEqual(before);
  });

  it('consumes a visible enemy with the Oozium action rather than triggering an ambush', () => {
    const { map, game, ai, player, enemyPlayer } = battlefield();
    const ooze = map.addUnit('HOELLIUM', player, 2, 3);
    const enemy = map.addUnit('LIGHT_TANK', enemyPlayer, 3, 3);
    const before = snapshot(game);
    const action = moveOoziums(ai, [ooze], [enemy]);
    expect(action).toMatchObject({ kind: 'unit', actionId: 'ACTION_HOELLIUM_WAIT', to: { x: 3, y: 3 } });
    expect(snapshot(game)).toEqual(before);
    expect(applyAction(game, action!)).toBe(true);
    expect(map.getUnitByUid(enemy.uid)).toBeNull();
    expect(map.getUnitAt(3, 3)).toBe(ooze);
    expect(ooze.hasMoved).toBe(true);
  });

  it('advances Oozium toward a distant enemy within its one-point budget', () => {
    const { map, game, ai, player, enemyPlayer } = battlefield();
    const ooze = map.addUnit('HOELLIUM', player, 2, 3);
    const enemy = map.addUnit('INFANTRY', enemyPlayer, 7, 3);
    const action = moveOoziums(ai, [ooze], [enemy]);
    expect(action).toMatchObject({ kind: 'unit', actionId: 'ACTION_HOELLIUM_WAIT' });
    expect(applyAction(game, action!)).toBe(true);
    expect(Math.abs(ooze.x - 2) + Math.abs(ooze.y - 3)).toBe(1);
    expect(map.getUnitByUid(enemy.uid)).toBe(enemy);
  });

  it('runs the Oozium stage before ordinary capture in a real NormalAi decision', async () => {
    const { map, game, player, enemyPlayer } = battlefield();
    const ooze = map.addUnit('HOELLIUM', player, 2, 3);
    const enemy = map.addUnit('LIGHT_TANK', enemyPlayer, 3, 3);
    const capturer = map.addUnit('INFANTRY', player, 6, 3);
    const city = new BuildingHost(map, 'TOWN', null);
    city.setTerrain(map.getTerrain(6, 3));
    map.getTerrain(6, 3).building = city;
    city.init();
    expect(game.availableActions(capturer, capturer).map(action => action.id)).toContain('ACTION_CAPTURE');
    const env = new GameEnvironment(map, registry, { rng }, game);
    const ai = new NormalAi();
    ai.beginTurn(env);
    const action = await ai.selectAction(env);
    expect(action).toMatchObject({ kind: 'unit', uid: ooze.uid, actionId: 'ACTION_HOELLIUM_WAIT' });
    expect(applyAction(game, action!)).toBe(true);
    expect(map.getUnitByUid(enemy.uid)).toBeNull();
    expect(capturer.hasMoved).toBe(false);
    expect(city.getOwner()).toBeNull();
  });

  it('detonates a black bomb for a positive trade through the hosted field action', () => {
    const { map, game, ai, player, enemyPlayer } = battlefield();
    const bomb = map.addUnit('BLACK_BOMB', player, 2, 3);
    const enemy = map.addUnit('LIGHT_TANK', enemyPlayer, 3, 3);
    const before = snapshot(game);
    const action = moveBlackBombs(ai, [bomb], [enemy], () => 0);
    expect(action).toMatchObject({ kind: 'unit', actionId: 'ACTION_EXPLODE' });
    expect(snapshot(game)).toEqual(before);
    expect(applyAction(game, action!)).toBe(true);
    expect(map.getUnitByUid(bomb.uid)).toBeNull();
    expect(enemy.hp).toBe(6);
  });

  it('does not target hidden enemies with bombs or Oozium', () => {
    const { map, ai, player, enemyPlayer } = battlefield(20, 7);
    const bomb = map.addUnit('BLACK_BOMB', player, 1, 1);
    const ooze = map.addUnit('HOELLIUM', player, 1, 2);
    const enemy = map.addUnit('INFANTRY', enemyPlayer, 18, 5);
    map.rules.fogMode = GameEnums.Fog_OfWar;
    map.vision.update();
    expect(enemy.isStealthed(player)).toBe(true);
    expect(moveBlackBombs(ai, [bomb], [enemy], () => 0)).toBeNull();
    expect(moveOoziums(ai, [ooze], [enemy])).toBeNull();
  });

  it('moves a bomb toward an enemy beyond blast reach instead of detonating', () => {
    const { map, game, ai, player, enemyPlayer } = battlefield(30, 7);
    const bomb = map.addUnit('BLACK_BOMB', player, 2, 3);
    const enemy = map.addUnit('LIGHT_TANK', enemyPlayer, 25, 3);
    const action = moveBlackBombs(ai, [bomb], [enemy], () => 0);
    expect(action).toMatchObject({ kind: 'unit', actionId: 'ACTION_WAIT' });
    expect(applyAction(game, action!)).toBe(true);
    expect(bomb.x).toBeGreaterThan(2);
    expect(Math.abs(bomb.x - 2) + Math.abs(bomb.y - 3)).toBeLessThanOrEqual(bomb.baseMovementPoints);
    expect(enemy.hp).toBe(10);
  });
});
