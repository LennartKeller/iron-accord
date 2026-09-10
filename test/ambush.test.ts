import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { key, stoppableTiles } from '../src/game/pathfinding.ts';
import { BuildingHost } from '../src/host/building.ts';
import { GameEnums } from '../src/host/index.ts';

const { createMap, registry, animations, rng } = bootstrap();

function encounter(unitID = 'INFANTRY', concealment: 'forest' | 'stealth' | 'fog' = 'forest') {
  const map = createMap(7, 1, 'PLAINS');
  const player = map.addPlayer('os');
  const enemy = map.addPlayer('bm');
  player.team = 0;
  enemy.team = 1;
  map.getGameRules().setFogMode(concealment === 'stealth' ? GameEnums.Fog_Off : GameEnums.Fog_OfWar);
  const blockerX = concealment === 'fog' ? 3 : 2;
  if (concealment === 'forest') map.setTerrainID(blockerX, 0, 'FOREST');
  const game = new Game(map, registry, animations);
  const mover = map.addUnit(unitID, player, 0, 0);
  const blocker = map.addUnit('INFANTRY', enemy, blockerX, 0);
  if (concealment === 'stealth') blocker.setHidden(true);
  map.vision.update();
  expect(blocker.isStealthed(player)).toBe(true);
  return { map, game, player, enemy, mover, blocker };
}

describe('hidden-enemy ambushes', () => {
  it.each(['forest', 'stealth'] as const)('allows planning onto and beyond an enemy hidden by %s', concealment => {
    const { game, mover } = encounter('INFANTRY', concealment);
    const range = game.select(0, 0)!;
    expect(range.tiles.get(key(2, 0))).toMatchObject({ canStop: true, canAct: true });
    expect(stoppableTiles(range).some(tile => tile.x === 2)).toBe(true);
    expect(game.previewPath(3, 0).map(tile => tile.x)).toEqual([0, 1, 2, 3]);
    expect(game.availableActions(mover, { x: 2, y: 0 }).map(action => action.id)).toContain('ACTION_WAIT');
  });

  it.each([2, 3])('stops before a concealed enemy when moving to tile %i', destination => {
    const { game, map, mover, blocker, player } = encounter();
    const fuel = mover.fuel;
    mover.setCapturePoints(10);
    game.select(0, 0);
    const result = game.moveSelected(destination, 0);
    expect(result.moved).toBe(true);
    expect(result.cost).toBe(1);
    expect(result.path.map(tile => tile.x)).toEqual([0, 1]);
    expect(map.getUnitAt(1, 0)).toBe(mover);
    expect(map.getUnitAt(2, 0)).toBe(blocker);
    expect(mover.fuel).toBe(fuel - 1);
    expect(mover.getCapturePoints()).toBe(0);
    expect(mover.hasMoved).toBe(true);
    expect(blocker.isStealthed(player)).toBe(false);
    expect(game.select(1, 0)).toBeNull();
  });

  it('also intercepts an enemy hidden solely by the vision radius', () => {
    const { game, mover, blocker, player } = encounter('LIGHT_TANK', 'fog');
    const fuel = mover.fuel;
    game.select(0, 0);
    expect(game.moveSelected(4, 0).moved).toBe(true);
    expect(mover.x).toBe(2);
    expect(mover.fuel).toBe(fuel - 2);
    expect(mover.hasMoved).toBe(true);
    expect(blocker.isStealthed(player)).toBe(false);
  });

  it('replaces scripted waiting with an ambush before entering the occupied tile', () => {
    const { game, map, mover, blocker } = encounter();
    expect(game.performAction('ACTION_WAIT', mover, { x: 2, y: 0 })).toBe(true);
    expect(map.getUnitAt(1, 0)).toBe(mover);
    expect(map.getUnitAt(2, 0)).toBe(blocker);
    expect(mover.hasMoved).toBe(true);
  });

  it('suppresses capture at the planned destination', () => {
    const { game, map, mover } = encounter();
    const terrain = map.getTerrain(3, 0);
    const town = new BuildingHost(map, 'TOWN', null);
    terrain.building = town;
    town.setTerrain(terrain);
    expect(game.performAction('ACTION_CAPTURE', mover, { x: 3, y: 0 })).toBe(true);
    expect(mover.x).toBe(1);
    expect(mover.getCapturePoints()).toBe(0);
    expect(town.getOwner()).toBeNull();
    expect(mover.hasMoved).toBe(true);
  });

  it('suppresses attack damage and ammunition expenditure', () => {
    const { game, map, mover, player, enemy, blocker } = encounter();
    const target = map.addUnit('INFANTRY', enemy, 4, 0);
    map.addUnit('INFANTRY', player, 5, 0);
    map.vision.update();
    expect(blocker.isStealthed(player)).toBe(true);
    expect(target.isStealthed(player)).toBe(false);
    const ammo = mover.getAmmo1();
    const luck = rng.getState();
    expect(game.attack(mover, { x: 3, y: 0 }, { x: 4, y: 0 })).toBe(true);
    expect(mover.x).toBe(1);
    expect(mover.hasMoved).toBe(true);
    expect(mover.getAmmo1()).toBe(ammo);
    expect(rng.getState()).toBe(luck);
    expect(mover.getHp()).toBe(10);
    expect(target.getHp()).toBe(10);
    expect(blocker.getHp()).toBe(10);
  });

  it('suppresses a support action after the route is intercepted', () => {
    const { game, map, mover, player, blocker } = encounter('APC');
    const recipient = map.addUnit('INFANTRY', player, 4, 0);
    recipient.fuel = 5;
    map.vision.update();
    expect(blocker.isStealthed(player)).toBe(true);
    expect(game.performAction('ACTION_SUPPORTALL_RATION', mover, { x: 3, y: 0 })).toBe(true);
    expect(mover.x).toBe(1);
    expect(mover.hasMoved).toBe(true);
    expect(recipient.fuel).toBe(5);
  });

  it('keeps visible enemies impassable without consuming an action', () => {
    const { game, map, mover, blocker, player } = encounter();
    map.getGameRules().setFogMode(GameEnums.Fog_Off);
    map.vision.update();
    expect(blocker.isStealthed(player)).toBe(false);
    const fuel = mover.fuel;
    const range = game.select(0, 0)!;
    expect(range.tiles.has(key(2, 0))).toBe(false);
    expect(range.tiles.has(key(3, 0))).toBe(false);
    expect(game.moveSelected(3, 0).moved).toBe(false);
    expect(game.performAction('ACTION_WAIT', mover, { x: 2, y: 0 })).toBe(false);
    expect(mover.x).toBe(0);
    expect(mover.fuel).toBe(fuel);
    expect(mover.hasMoved).toBe(false);
  });

  it('commits an intercepted unload move without dropping cargo or allowing rollback', () => {
    const { game, map, mover, player } = encounter('APC');
    const cargo = map.addUnit('INFANTRY', player, 6, 0);
    mover.loadUnit(cargo);
    map.vision.update();
    const fuel = mover.fuel;
    expect(game.moveForUnload(mover, 3, 0)).toBe(false);
    expect(mover.x).toBe(1);
    expect(mover.fuel).toBe(fuel - 1);
    expect(mover.hasMoved).toBe(true);
    expect(mover.loaded).toEqual([cargo]);
    expect(map.units).not.toContain(cargo);
    expect(game.cancelUnloadMove()).toBe(false);
    expect(mover.x).toBe(1);
  });

  it('intercepts a completed multistep unload before deploying its cargo', () => {
    const { game, map, mover, player } = encounter('APC');
    const cargo = map.addUnit('INFANTRY', player, 6, 0);
    mover.loadUnit(cargo);
    map.vision.update();
    const state = game.beginAction('ACTION_UNLOAD', mover, { x: 3, y: 0 });
    expect(state.kind).toBe('field');
    if (state.kind !== 'field') throw new Error('Expected unload destination selection');
    expect(state.fields).toContainEqual({ x: 4, y: 0 });
    expect(game.provideField(4, 0)).toEqual({ kind: 'done' });
    expect(mover.x).toBe(1);
    expect(mover.hasMoved).toBe(true);
    expect(mover.loaded).toEqual([cargo]);
    expect(map.units).not.toContain(cargo);
    expect(map.getUnitAt(4, 0)).toBeNull();
    expect(game.pending).toBeNull();
  });

  it('runs the water-mine trap callbacks, damaging the ship and removing the mine', () => {
    const map = createMap(5, 1, 'SEA');
    const player = map.addPlayer('os');
    const enemy = map.addPlayer('bm');
    player.team = 0;
    enemy.team = 1;
    const game = new Game(map, registry, animations);
    const ship = map.addUnit('LANDER', player, 0, 0);
    const mine = map.addUnit('WATERMINE', enemy, 2, 0);
    mine.setHidden(true);
    map.vision.update();
    expect(mine.isStealthed(player)).toBe(true);
    expect(game.performAction('ACTION_WAIT', ship, { x: 3, y: 0 })).toBe(true);
    expect(ship.x).toBe(1);
    expect(ship.hasMoved).toBe(true);
    expect(ship.getHp()).toBe(5);
    expect(map.units).not.toContain(mine);
    expect(map.getUnitAt(2, 0)).toBeNull();
  });
  it('backs up to the origin if an allied unit occupies the preceding tile', () => {
    const { game, map, mover, player, blocker } = encounter('APC');
    const cargo = map.addUnit('INFANTRY', player, 6, 0);
    mover.loadUnit(cargo);
    const fuel = mover.fuel;
    expect(game.beginAction('ACTION_UNLOAD', mover, { x: 3, y: 0 }).kind).toBe('field');
    // The route was selected before this tile became occupied. Execution must
    // use current occupancy and never stack the transport on its ally.
    const ally = map.addUnit('INFANTRY', player, 1, 0);
    map.vision.update();
    expect(game.provideField(4, 0).kind).toBe('done');
    expect(map.getUnitAt(0, 0)).toBe(mover);
    expect(map.getUnitAt(1, 0)).toBe(ally);
    expect(map.getUnitAt(2, 0)).toBe(blocker);
    expect(mover.hasMoved).toBe(true);
    expect(mover.fuel).toBe(fuel);
    expect(mover.loaded).toEqual([cargo]);
  });

});
