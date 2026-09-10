import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { BuildingHost } from '../src/host/building.ts';
import { CoreAI } from '../src/ai/cw/coreai.ts';
import { NORMAL_AI_DEFAULTS } from '../src/ai/cw/config.ts';
import { ProductionSystem } from '../src/ai/cw/production.ts';
import { selectBuildingAction } from '../src/ai/cw/building-actions.ts';
import { applyAction } from '../src/ai/actions.ts';
import { NormalAi } from '../src/ai/cw/normalai.ts';
import { GameEnvironment } from '../src/ai/environment.ts';

const { createMap, registry, animations } = bootstrap();
function fixture() {
  const map = createMap(8, 8, 'PLAINS');
  const player = map.addPlayer('os'), enemy = map.addPlayer('bm');
  player.team = 0; enemy.team = 1;
  player.setBuildList(['INFANTRY', 'LIGHT_TANK']);
  const game = new Game(map, registry, animations);
  const building = new BuildingHost(map, 'ZBLACKHOLE_FACTORY', player);
  building.setTerrain(map.getTerrain(4, 4)); map.getTerrain(4, 4).building = building;
  building.init(); building.setFireCount(7);
  map.addUnit('INFANTRY', enemy, 7, 7);
  const core = new CoreAI(game, player, { ...NORMAL_AI_DEFAULTS });
  const production = new ProductionSystem(() => 0.25);
  return { map, game, player, building, core, production };
}

describe('special factory production policy', () => {
  it('preserves the pinned menu query negative-cost ceiling and initializes only base policy', () => {
    const { game, player, core, building, production } = fixture();
    expect(player.getCosts('INFANTRY')).toBeGreaterThanOrEqual(0);
    const ordinary = new BuildingHost(game.map, 'FACTORY', player);
    ordinary.setTerrain(game.map.getTerrain(1, 1)); game.map.getTerrain(1, 1).building = ordinary;
    ordinary.init();
    // C++ getProductionFromList passes minCost=0,maxCost=-1 directly to
    // getBuildDistribution, so no ordinary nonnegative unit price survives.
    expect(production.chooseMenuItem(game, core, ['INFANTRY', 'LIGHT_TANK'], [true, true], [ordinary])).toBe(-1);
    expect(production.ready).toBe(true);
    expect(production.saveState()).toMatchObject({ producedCount: 0, preparedForTurn: '',
      initialProduction: [{ unitIds: ['INFANTRY'], count: 6 }] });
  });

  it('executes a real special-factory door through the native enabled-menu fallback', () => {
    const { map, game, core, building, production } = fixture();
    let fallback = false;
    const action = selectBuildingAction(game, [building], () => 0, (_building, _actionId, entries) => {
      const index = production.chooseMenuItem(game, core, entries.map(entry => entry.actionID),
        entries.map(entry => entry.enabled), [building]);
      fallback = index < 0;
      return entries[index >= 0 ? index : 0].actionID;
    });
    expect(fallback).toBe(true);
    expect(action).toMatchObject({ kind: 'building', actionId: 'ACTION_BLACKHOLEFACTORY_DOOR1' });
    expect(applyAction(game, action!)).toBe(true);
    expect(map.getUnitAt(2, 5)).not.toBeNull();
    expect(building.getFireCount()).toBe(6);
    expect(production.saveState()).toMatchObject({ producedCount: 0,
      initialProduction: [{ unitIds: ['INFANTRY'], count: 6 }] });
  });

  it('continues the AI after special doors without the broken construction-list script aborting its turn', async () => {
    const { map, game, building } = fixture();
    expect(building.getConstructionList()).toEqual([]);
    const env = new GameEnvironment(map, registry, {}, game);
    const ai = new NormalAi({ seed: 7 });
    ai.beginTurn(env);
    let doors = 0, ended = false;
    for (let step = 0; step < 30; step++) {
      const action = await ai.selectAction(env);
      if (!action || action.kind === 'endTurn') { ended = true; break; }
      expect(applyAction(game, action)).toBe(true);
      if (action.kind === 'building' && action.actionId.startsWith('ACTION_BLACKHOLEFACTORY_DOOR')) doors++;
    }
    expect(doors).toBe(3);
    expect(ended).toBe(true);
    expect(building.getFireCount()).toBe(0);
  });

});
