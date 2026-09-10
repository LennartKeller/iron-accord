import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { snapshot } from '../src/game/snapshot.ts';
import { GameEnums } from '../src/host/enums.ts';

const { createMap, registry, animations } = bootstrap();
function fixture(transportId = 'APC', terrain = 'PLAINS') {
  const map = createMap(5, 3, terrain);
  const player = map.addPlayer('os');
  const enemy = map.addPlayer('bm');
  player.team = 0;
  enemy.team = 1;
  const game = new Game(map, registry, animations);
  const transport = map.addUnit(transportId, player, 1, 1);
  const cargo = map.addUnit('INFANTRY', player, 0, 1);
  transport.loadUnit(cargo);
  return { map, game, transport, cargo, player, enemy };
}

describe('unload destination planning', () => {
  it('queries fields beside the planned destination and includes the vacated origin without mutating state', () => {
    const { game, transport } = fixture();
    const before = snapshot(game);
    const fields = game.unloadTargets(transport, 0, { x: 2, y: 1 });
    expect(fields).toEqual([{ x: 3, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 0 }, { x: 2, y: 2 }]);
    expect(fields).toContainEqual({ x: 1, y: 1 });
    expect(game.unloadTargets(transport, 0)).toContainEqual({ x: 0, y: 1 });
    expect(snapshot(game)).toEqual(before);
  });

  it.each(['BRIDGE', 'BRIDGE1', 'BRIDGE2'])('rejects a boat destination on %s even when its origin is a beach', bridge => {
    const { map, game, transport } = fixture('LANDER', 'BEACH');
    expect(game.unloadTargets(transport, 0).length).toBeGreaterThan(0);
    map.setTerrainID(2, 1, bridge);
    expect(game.unloadTargets(transport, 0, { x: 2, y: 1 })).toEqual([]);
  });

  it('uses cargo movement on the destination tile and each neighbouring tile', () => {
    const { map, game, transport, player } = fixture('LANDER', 'SEA');
    const tank = map.addUnit('LIGHT_TANK', player, 0, 0);
    transport.loadUnit(tank);
    expect(transport.loaded).toHaveLength(2);
    map.setTerrainID(2, 1, 'BEACH');
    map.setTerrainID(3, 1, 'MOUNTAIN');
    map.setTerrainID(2, 0, 'PLAINS');
    expect(game.unloadTargets(transport, 0)).toEqual([]);
    expect(game.unloadTargets(transport, 0, { x: 2, y: 1 }))
      .toEqual([{ x: 3, y: 1 }, { x: 2, y: 0 }]);
    expect(game.unloadTargets(transport, 1, { x: 2, y: 1 }))
      .toEqual([{ x: 2, y: 0 }]);
    expect(game.unloadTargets(transport, 2, { x: 2, y: 1 })).toEqual([]);
    expect(game.unloadTargets(transport, 1, { x: 4, y: 1 })).toEqual([]);
  });

  it('blocks visible occupants but keeps hidden occupants as planning choices and never unloads onto them', () => {
    const { map, game, transport, cargo, player, enemy } = fixture();
    const blocker = map.addUnit('INFANTRY', player, 2, 1);
    expect(game.unloadTargets(transport, 0)).not.toContainEqual({ x: 2, y: 1 });
    map.getGameRules().setFogMode(GameEnums.Fog_OfWar);
    map.removeUnit(blocker);
    map.setTerrainID(3, 1, 'FOREST');
    const hidden = map.addUnit('INFANTRY', enemy, 3, 1);
    map.vision.update();
    expect(hidden.isStealthed(player)).toBe(true);
    expect(game.unloadTargets(transport, 0, { x: 2, y: 1 })).toContainEqual({ x: 3, y: 1 });
    expect(game.moveForUnload(transport, 2, 1)).toBe(true);
    expect(game.unloadUnit(transport, 0, 3, 1)).toBe(false);
    expect(map.getUnitAt(3, 1)).toBe(hidden);
    expect(transport.loaded).toContain(cargo);
  });

  it('retains original cargo indexes in the hosted multi-cargo menu', () => {
    const { map, game, transport, player } = fixture('LANDER', 'BEACH');
    const tank = map.addUnit('LIGHT_TANK', player, 0, 0);
    transport.loadUnit(tank);
    const step = game.probeAction('ACTION_UNLOAD', transport, { x: 2, y: 1 });
    expect(step.kind).toBe('menu');
    if (step.kind !== 'menu') throw new Error('Expected cargo choices');
    expect(step.entries.map(entry => entry.actionID)).toEqual(['0', '1', 'ACTION_WAIT']);
    expect(transport.loaded[1]).toBe(tank);
  });

  it('moves and unloads the second original cargo index through the hosted menu', () => {
    const { map, game, transport, cargo, player } = fixture('LANDER', 'BEACH');
    const tank = map.addUnit('LIGHT_TANK', player, 0, 0);
    transport.loadUnit(tank);
    expect(game.beginAction('ACTION_UNLOAD', transport, { x: 2, y: 1 }).kind).toBe('menu');
    const fields = game.provideMenu('1', 0);
    expect(fields.kind).toBe('field');
    if (fields.kind !== 'field') throw new Error('Expected drop fields');
    expect(fields.fields).toContainEqual({ x: 3, y: 1 });
    expect(game.provideField(3, 1).kind).toBe('menu');
    expect(game.provideMenu('ACTION_WAIT', 0).kind).toBe('done');
    expect(map.getUnitAt(2, 1)).toBe(transport);
    expect(map.getUnitAt(3, 1)).toBe(tank);
    expect(transport.loaded).toEqual([cargo]);
  });

});
