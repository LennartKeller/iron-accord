import { ProductionSystem } from '../src/ai/cw/production.ts';
import { applyAction } from '../src/ai/actions.ts';
import { snapshot } from '../src/game/snapshot.ts';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { CoreAI } from '../src/ai/cw/coreai.ts';
import { NORMAL_AI_DEFAULTS } from '../src/ai/cw/config.ts';
import { createProductionContext } from '../src/ai/cw/production-context.ts';
import { InfluenceFrontMap } from '../src/ai/cw/influencefrontmap.ts';
import { computeMovementRange } from '../src/game/pathfinding.ts';
import { BuildingHost } from '../src/host/building.ts';

const { createMap, registry } = bootstrap();
function fixture() {
  const map = createMap(12, 5, 'PLAINS');
  const player = map.addPlayer('os'), enemy = map.addPlayer('bm');
  enemy.team = 1;
  const game = new Game(map, registry);
  const core = new CoreAI(game, player, { ...NORMAL_AI_DEFAULTS });
  return { map, player, enemy, game, core };
}

describe('production and influence information boundary', () => {
  it('counts own cargo without disclosing cargo of a visible enemy carrier', () => {
    const { map, player, enemy, game, core } = fixture();
    const carrier = map.addUnit('APC', enemy, 8, 2);
    const context = () => createProductionContext(game, core, [], [carrier], []);
    expect(carrier.isStealthed(player)).toBe(false);
    const before = context().ai.getUnitCount(context().enemyUnits, ['INFANTRY']);
    carrier.loadUnit(map.addUnit('INFANTRY', enemy, 9, 2));
    const after = context();
    expect(after.ai.getUnitCount(after.enemyUnits, ['INFANTRY'])).toBe(before);
    expect(after.ai.getUnitCount(after.ai.getPlayer().getAlliedUnits(), ['INFANTRY'])).toBe(0);
    const ours = map.addUnit('APC', player, 1, 2);
    ours.loadUnit(map.addUnit('INFANTRY', player, 2, 2));
    const own = context();
    expect(own.ai.getUnitCount(own.units, ['INFANTRY'])).toBe(1);
  });

  it('keeps production reservation counts unchanged by hidden factory occupancy', () => {
    const { map, player, enemy, game, core } = fixture();
    const building = new BuildingHost(map, 'FACTORY', player);
    building.setTerrain(map.getTerrain(2, 2)); map.getTerrain(2, 2).building = building;
    const count = () => createProductionContext(game, core, [building], [], [])
      .buildings.getBuildingGroupCount(['FACTORY'], true);
    expect(count()).toBe(1);
    const hidden = map.addUnit('INFANTRY', enemy, 2, 2); hidden.setHidden(true);
    expect(hidden.isStealthed(player)).toBe(true);
    expect(count()).toBe(1);
    hidden.setHidden(false);
    expect(count()).toBe(0);
  });

  it('plans on apparently empty factories without mutating or overwriting the hidden occupant', () => {
    const { map, player, enemy, game, core } = fixture();
    player.funds = 10000;
    const building = new BuildingHost(map, 'FACTORY', player);
    building.setTerrain(map.getTerrain(2, 2)); map.getTerrain(2, 2).building = building; building.init();
    const hidden = map.addUnit('INFANTRY', enemy, 2, 2); hidden.setHidden(true);
    const before = snapshot(game);
    const action = new ProductionSystem(() => 0.25).chooseAction(game, core, [building], [hidden], []);
    expect(action).toMatchObject({ kind: 'build', at: { x: 2, y: 2 }, unitId: 'INFANTRY' });
    expect(snapshot(game)).toEqual(before);
    expect(applyAction(game, action!)).toBe(false);
    expect(snapshot(game)).toEqual(before);
    expect(map.getUnitAt(2, 2)).toBe(hidden);
  });

  it('does not populate island maps from private enemy cargo', () => {
    const { map, player, enemy, core } = fixture();
    player.setBuildList(['APC']);
    const carrier = map.addUnit('APC', enemy, 8, 2);
    core.rebuildIsland([carrier]);
    const before = core.islandMaps.map(island => island.getMovementType());
    carrier.loadUnit(map.addUnit('INFANTRY', enemy, 9, 2));
    core.rebuildIsland([carrier]);
    expect(core.islandMaps.map(island => island.getMovementType())).toEqual(before);
  });

  it('does not project enemy transport cargo or hidden combat-unit influence', () => {
    const { map, player, enemy, core } = fixture();
    const carrier = map.addUnit('APC', enemy, 8, 2);
    const influence = new InfluenceFrontMap(map, core.islandMaps); influence.setOwner(player);
    const project = () => {
      influence.reset();
      influence.addUnitInfluence(carrier, computeMovementRange(map, carrier), 6);
      return influence.getInfluenceInfo(8, 2).playerValues[enemy.getPlayerID()];
    };
    expect(project()).toBe(0);
    carrier.loadUnit(map.addUnit('INFANTRY', enemy, 9, 2));
    expect(project()).toBe(0);
    const hidden = map.addUnit('LIGHT_TANK', enemy, 10, 2); hidden.setHidden(true);
    influence.addUnitInfluence(hidden, computeMovementRange(map, hidden), 6);
    expect(influence.getInfluenceInfo(10, 2).playerValues[enemy.getPlayerID()]).toBe(0);
  });
});
