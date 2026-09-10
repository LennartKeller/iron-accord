import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { snapshot, restore, withRollback } from '../src/game/snapshot.ts';
import { GameMap, BuildingHost, Terrain } from '../src/host/index.ts';
import { ScriptVariables } from '../src/host/variables.ts';

const { registry, animations } = bootstrap();
function setup() {
  const map = new GameMap(5, 5, 'PLAINS', registry);
  map.addPlayer('OS').team = 0;
  map.addPlayer('BM').team = 1;
  return { map, game: new Game(map, registry, animations) };
}

describe('snapshot isolation regressions', () => {
  it('restores indestructible terrain and its nested base after scripted replacement', () => {
    const { map, game } = setup();
    const plasma = map.getTerrain(1, 1);
    plasma.terrainID = 'PLASMA';
    plasma.baseTerrain = new Terrain(map, 1, 1, 'SEA');
    plasma.variables.createVariable('state').writeDataInt32(7);
    expect(plasma.hp).toBe(-1);
    withRollback(game, () => {
      map.replaceTerrainOnly('PLAINS', 1, 1);
      map.getTerrain(1, 1).baseTerrain!.terrainID = 'ROAD';
    });
    expect(map.getTerrain(1, 1).getTerrainID()).toBe('PLASMA');
    expect(map.getTerrain(1, 1).baseTerrain!.getTerrainID()).toBe('SEA');
    expect(map.getTerrain(1, 1).variables.getVariable('state')!.readDataInt32()).toBe(7);
  });

  it('rewinds the real meteor destruction hook and its adjoining plasma web', () => {
    const { map, game } = setup();
    for (const [x, id] of [[1, 'METEOR'], [2, 'PLASMA'], [3, 'PLASMA']] as const) {
      map.replaceTerrainOnly(id, x, 1, true);
    }
    withRollback(game, () => {
      registry.METEOR.onDestroyed(map.getTerrain(1, 1), map);
      expect(map.getTerrain(2, 1).getTerrainID()).toBe('PLAINS_PLASMA');
      expect(map.getTerrain(3, 1).getTerrainID()).toBe('PLAINS_PLASMA');
    });
    expect(map.getTerrain(1, 1).getTerrainID()).toBe('METEOR');
    expect(map.getTerrain(2, 1).getTerrainID()).toBe('PLASMA');
    expect(map.getTerrain(3, 1).getTerrainID()).toBe('PLASMA');
  });

  it('removes branch-created buildings and restores destroyed building variables', () => {
    const { map, game } = setup();
    const field = map.getTerrain(1, 1);
    const town = new BuildingHost(map, 'TOWN', map.players[0]);
    town.setTerrain(field);
    field.building = town;
    town.variables.createVariable('counter').writeDataInt32(3);
    withRollback(game, () => {
      field.building = null;
      const created = new BuildingHost(map, 'FACTORY', map.players[0]);
      created.setTerrain(map.getTerrain(2, 2));
      map.getTerrain(2, 2).building = created;
    });
    expect(map.getTerrain(2, 2).building).toBeNull();
    expect(field.building!.getBuildingID()).toBe('TOWN');
    expect(field.building!.variables.getVariable('counter')!.readDataInt32()).toBe(3);
  });

  it('preserves temporary bonuses and cargo state across repeated restores', () => {
    const { map, game } = setup();
    const transport = map.addUnit('APC', map.players[0], 1, 1);
    const cargo = map.addUnit('INFANTRY', map.players[0], 2, 1);
    transport.loadUnit(cargo);
    cargo.addMovementBonus(2, 3);
    cargo.addOffensiveBonus(20, 2);
    cargo.setCloaked(true);
    const saved = snapshot(game);
    restore(game, saved);
    let restored = map.getUnitByUid(transport.uid)!.loaded[0];
    expect(restored.movementBonus).toEqual([{ value: 2, duration: 3 }]);
    expect(restored.offensiveBonus).toEqual([{ value: 20, duration: 2 }]);
    expect(restored.getCloaked()).toBe(true);
    restored.movementBonus[0].duration = 1;
    restore(game, saved);
    restored = map.getUnitByUid(transport.uid)!.loaded[0];
    expect(restored.movementBonus[0].duration).toBe(3);
    expect(map.units).toHaveLength(1);
    expect(map.players[0].units).toHaveLength(1);
  });

  it('copies nested script variables in both snapshot directions', () => {
    const variables = new ScriptVariables();
    variables.createVariable('nested').writeValue({ values: [1, 2] });
    const saved = variables.toJSON();
    (variables.getVariable('nested')!.readValue() as { values: number[] }).values.push(3);
    expect(saved.nested).toEqual({ values: [1, 2] });
    variables.fromJSON(saved);
    (variables.getVariable('nested')!.readValue() as { values: number[] }).values.push(4);
    expect(saved.nested).toEqual({ values: [1, 2] });
  });
});


describe('neutral property targeting', () => {
  it('treats neutral buildings as enemy capture targets, matching checkAlliance', () => {
    const { map } = setup();
    const building = new BuildingHost(map, 'TOWN', null);
    expect(map.players[0].isEnemy(null)).toBe(true);
    expect(building.isEnemyBuilding(map.players[0])).toBe(true);
    building.setOwner(map.players[0]);
    expect(building.isEnemyBuilding(map.players[0])).toBe(false);
    building.setOwner(map.players[1]);
    expect(building.isEnemyBuilding(map.players[0])).toBe(true);
    map.players[1].isDefeated = true;
    expect(building.isEnemyBuilding(map.players[0])).toBe(false);
  });
});
