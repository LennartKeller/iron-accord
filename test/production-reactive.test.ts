import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { BuildingHost, GameEnums, ScriptVariables, type Player } from '../src/host/index.ts';
import { CoreAI } from '../src/ai/cw/coreai.ts';
import { NORMAL_AI_DEFAULTS } from '../src/ai/cw/config.ts';
import { ProductionSystem } from '../src/ai/cw/production.ts';
import { createProductionContext } from '../src/ai/cw/production-context.ts';

const { createMap, registry } = bootstrap();
function fixture(width = 18) {
  const map = createMap(width, 3, 'PLAINS');
  const player = map.addPlayer('os'), enemy = map.addPlayer('bm');
  player.team = 0; enemy.team = 1;
  const game = new Game(map, registry);
  const building = (id: string, owner: Player, x: number, y = 1) => {
    const value = new BuildingHost(map, id, owner);
    value.setTerrain(map.getTerrain(x, y));
    map.getTerrain(x, y).building = value;
    value.init();
    return value;
  };
  const factory = building('FACTORY', player, 0);
  player.funds = 10000;
  const core = new CoreAI(game, player, { ...NORMAL_AI_DEFAULTS });
  const production = new ProductionSystem(() => 0.25);
  return { map, game, player, enemy, core, production, factory, building };
}

function state(production: ProductionSystem) {
  return production.saveState() as {
    initialProduction: Array<{ count: number }>;
    forcedProduction: Array<{ unitIds: string[]; targetUids?: number[] }>;
    variables: Record<string, number | null>;
    buildDistribution: Array<[string, { distribution: number }]>;
  };
}

describe('reactive production queues', () => {
  it('queues the upstream anti-air counter list and enemy targets while opening infantry are pending', () => {
    const { map, game, enemy, core, production, factory } = fixture();
    const copter = map.addUnit('K_HELI', enemy, 4, 1);
    // Keep counters pending so their complete weighted list and target IDs are observable.
    production.chooseAction(game, core, [factory], [copter], [], (_at, id) => id === 'INFANTRY');

    const source = fs.readFileSync('ext/Commander_Wars/resources/aidata/normal/__coreai.js', 'utf8');
    const scope = vm.createContext({ GameEnums });
    vm.runInContext(source.replace('highPrioBuildings = [', 'highPrioBuildings : ['), scope);
    const context = createProductionContext(game, core, [factory], [copter], []);
    const expected: Array<{ unitIds: string[]; targetUids: number[] }> = [];
    scope.COREAI.forceAntiAirProduction({
      getVariables: () => new ScriptVariables(),
      addForcedProductionCloseToTargets: (ids: string[], targets: typeof context.enemyUnits) =>
        expected.push({ unitIds: [...ids], targetUids: targets.items.map(unit => unit.uid) }),
    }, context.ai, context.units, context.enemyUnits, context.ai.getPlayer().getAlliedUnits());
    expect(expected).toHaveLength(1);
    expect(state(production).forcedProduction).toEqual(expected);
    expect(state(production).initialProduction[0].count).toBe(5);
  });

  it('refreshes naval topology on day three without restarting the opening infantry queue', () => {
    const { map, game, player, enemy, core, production, factory, building } = fixture(14);
    for (let y = 0; y < map.height; y++) map.setTerrainID(6, y, 'SEA');
    const harbour = building('HARBOUR', player, 1, 0);
    const enemyFactory = building('FACTORY', enemy, 12);
    const enemyHarbour = building('HARBOUR', enemy, 11, 0);
    map.addUnit('LIGHT_TANK', player, 2, 1);
    const owned = [factory, harbour], hostile = [enemyFactory, enemyHarbour];
    production.chooseAction(game, core, owned, [], hostile);
    expect(state(production).initialProduction[0].count).toBe(5);
    game.day = 3;
    production.chooseAction(game, core, owned, [], hostile);
    const saved = state(production);
    // __coreai.js: shareIsland=false + harbours present + no airports => naval=4.
    expect(saved.variables.NAVALBATTLE).toBe(4);
    expect(saved.forcedProduction.map(item => item.unitIds)).toContainEqual(['LANDER']);
    expect(saved.forcedProduction.map(item => item.unitIds)).toContainEqual(['T_HELI', 'BLACK_BOAT']);
    expect(saved.buildDistribution.some(([name]) => name === 'HEAVY_NAVAL_GROUP')).toBe(true);
    expect(saved.initialProduction).toHaveLength(1);
    expect(saved.initialProduction[0].count).toBe(4);
  });

  it('queues fog scouts on day four and observes the four-day cooldown', () => {
    const { map, game, player, core, production, factory } = fixture();
    map.addUnit('INFANTRY', player, 2, 1);
    map.getGameRules().setFogMode(GameEnums.Fog_OfWar);
    map.vision.update();
    game.day = 4;
    production.chooseAction(game, core, [factory], [], []);
    expect(state(production).forcedProduction.map(item => item.unitIds)).toContainEqual(['RECON', 'FLARE']);
    expect(state(production).variables.LASTGROUNDSCOUTDAY).toBe(4);
    game.day = 5;
    production.chooseAction(game, core, [factory], [], []);
    expect(state(production).forcedProduction.map(item => item.unitIds)).not.toContainEqual(['RECON', 'FLARE']);
    expect(state(production).variables.LASTGROUNDSCOUTDAY).toBe(4);
  });

  it('queues the pinned supply list at day fifteen when the source fuel-count condition holds', () => {
    const { map, game, player, core, production, factory } = fixture();
    for (const x of [2, 3, 4]) {
      const unit = map.addUnit('INFANTRY', player, x, 1);
      unit.setHp(5); unit.setFuel(30);
    }
    game.day = 15;
    production.chooseAction(game, core, [factory], [], []);
    // __coreai.js forceApcProduction calls getUnitCount([],5,30); C++ means fuel >=30.
    expect(state(production).forcedProduction.map(item => item.unitIds)).toContainEqual([
      'APC', 'ZCOUNIT_LOGIC_TRUCK', 'ZCOUNIT_LOGIC_TRUCK', 'ZCOUNIT_REPAIR_TANK', 'ZCOUNIT_REPAIR_TANK',
    ]);
  });
});
