import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { GameEnums } from '../src/host/index.ts';
import { CoreAI } from '../src/ai/cw/coreai.ts';
import { NORMAL_AI_DEFAULTS } from '../src/ai/cw/config.ts';
import { createProductionContext, ProductionBuildingList, ProductionUnitList } from '../src/ai/cw/production-context.ts';

const { createMap, registry } = bootstrap();
function scenario(width = 20) {
  const map = createMap(width, 3, 'PLAINS');
  const own = map.addPlayer('os'), enemy = map.addPlayer('bm');
  own.team = 0; enemy.team = 1;
  const game = new Game(map, registry);
  const core = new CoreAI(game, own, { ...NORMAL_AI_DEFAULTS });
  return { map, own, enemy, game, core };
}

describe('vendored production policy host context', () => {
  it('counts qualifying cargo but filters targets only on the board, as CoreAI does', () => {
    const { map, own, game, core } = scenario();
    const carrier = map.addUnit('APC', own, 0, 1);
    const cargo = map.addUnit('INFANTRY', own, 1, 1);
    cargo.setHp(7); cargo.setFuel(30);
    carrier.loadUnit(cargo);
    const { ai, units } = createProductionContext(game, core, [], [], []);
    // coreai.cpp:2778 counts loaded units independently of the carrier's type.
    expect(ai.getUnitCount(units, ['INFANTRY'], 7, 30)).toBe(1);
    expect(ai.getUnitCount(units, ['INFANTRY'], 8, 30)).toBe(0);
    expect(ai.getUnitCount(units, ['INFANTRY'], 7, 31)).toBe(0);
    expect(ai.getFilteredUnits(units, ['INFANTRY'], 7, 30).size()).toBe(0);
  });

  it('prunes at the strict proximity boundary and leaves the original roster intact', () => {
    const { map, own, enemy } = scenario();
    const ours = map.addUnit('INFANTRY', own, 0, 1);
    const near = map.addUnit('INFANTRY', enemy, 5, 1);
    const boundary = map.addUnit('INFANTRY', enemy, 6, 1);
    const list = new ProductionUnitList(enemy.units);
    // qmlvector.cpp:138: distance < multiplier * (3 + 3), not <=.
    list.pruneEnemies(new ProductionUnitList([ours]), new ProductionBuildingList([]), 10, 1);
    expect(list.items).toEqual([near]);
    expect(enemy.units).toContain(boundary);
  });

  it('counts only empty production buildings when reserving funds', () => {
    const { map, own } = scenario();
    for (const x of [0, 2]) map.getTerrain(x, 1).loadBuilding('FACTORY');
    const list = new ProductionBuildingList([map.getTerrain(0, 1).getBuilding()!, map.getTerrain(2, 1).getBuilding()!]);
    map.addUnit('INFANTRY', own, 0, 1);
    expect(list.getBuildingCount('FACTORY')).toBe(2);
    expect(list.getBuildingGroupCount(['FACTORY'], false)).toBe(2);
    expect(list.getBuildingGroupCount(['FACTORY'], true)).toBe(1);
  });

  it('distinguishes stranded combat units and buildings across islands', () => {
    const { map, own, enemy, game, core } = scenario(7);
    for (let y = 0; y < map.height; y++) map.setTerrainID(3, y, 'SEA');
    const tank = map.addUnit('LIGHT_TANK', own, 1, 1);
    const opponent = map.addUnit('LIGHT_TANK', enemy, 5, 1);
    map.getTerrain(0, 1).loadBuilding('FACTORY');
    map.getTerrain(6, 1).loadBuilding('FACTORY');
    const ours = map.getTerrain(0, 1).getBuilding()!;
    const theirs = map.getTerrain(6, 1).getBuilding()!;
    const context = createProductionContext(game, core, [ours], [opponent], [theirs]);
    expect(context.ai.getIdleUnitCount(context.units, ['LIGHT_TANK'], context.enemyUnits, context.enemyBuildings)).toBe(1);
    expect(context.ai.getBuildingCountsOnEnemyIslands(context.units, context.enemyBuildings)).toBe(1);
    expect(context.ai.shareIslandWithEnemy(context.units, context.buildings, context.enemyBuildings)).toBe(false);

    const copter = map.addUnit('T_HELI', own, 2, 1);
    expect(context.ai.getBuildingCountsOnEnemyIslands(new ProductionUnitList([tank, copter]), context.enemyBuildings)).toBe(0);
    expect(context.ai.getIdleUnitCount(new ProductionUnitList([copter]), [], context.enemyUnits, context.enemyBuildings)).toBe(0);
  });

  it('requires ground combat units and production on both sides when sharing an island', () => {
    const { map, own, game, core } = scenario();
    map.getTerrain(0, 1).loadBuilding('FACTORY');
    map.getTerrain(19, 1).loadBuilding('FACTORY');
    const infantry = map.addUnit('INFANTRY', own, 1, 1);
    const tank = map.addUnit('LIGHT_TANK', own, 2, 1);
    const context = createProductionContext(game, core, [map.getTerrain(0, 1).getBuilding()!], [], [map.getTerrain(19, 1).getBuilding()!]);
    expect(context.ai.shareIslandWithEnemy(new ProductionUnitList([infantry]), context.buildings, context.enemyBuildings)).toBe(false);
    expect(context.ai.shareIslandWithEnemy(new ProductionUnitList([tank]), context.buildings, context.enemyBuildings)).toBe(true);
  });

  it('keeps the upstream allied-list quirk within the visible-information boundary', () => {
    const { map, own, enemy, game, core } = scenario();
    map.getGameRules().setFogMode(GameEnums.Fog_OfWar);
    map.addUnit('INFANTRY', own, 0, 1);
    const seen = map.addUnit('INFANTRY', enemy, 1, 1);
    const hidden = map.addUnit('LIGHT_TANK', enemy, 19, 1);
    map.vision.update();
    const context = createProductionContext(game, core, [], [seen, hidden], []);
    // player.cpp:1717 returns enemies from getAlliedUnits; the port still must not expose unseen ones.
    expect(context.ai.getPlayer().getAlliedUnits().items).toEqual([seen]);
    expect(context.enemyUnits.items).toEqual([seen]);
  });
});
