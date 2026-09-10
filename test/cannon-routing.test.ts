import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { BuildingHost } from '../src/host/building.ts';
import { CoreAI } from '../src/ai/cw/coreai.ts';
import { NORMAL_AI_DEFAULTS } from '../src/ai/cw/config.ts';
import { TargetedUnitPathFindingSystem } from '../src/ai/cw/targetedpfs.ts';
import { DamagePredictor } from '../src/ai/cw/damage.ts';

const { createMap, registry, animations } = bootstrap();
function fixture() {
  const map = createMap(11, 11, 'PLAINS');
  const player = map.addPlayer('os'), enemy = map.addPlayer('bm');
  player.team = 0; enemy.team = 1;
  const game = new Game(map, registry, animations);
  const place = (id: string, x: number, y: number, owner = enemy) => {
    const building = new BuildingHost(map, id, owner);
    building.setTerrain(map.getTerrain(x, y)); map.getTerrain(x, y).building = building;
    building.init(); building.setFireCount(1);
    return building;
  };
  const core = () => new CoreAI(game, player, { ...NORMAL_AI_DEFAULTS });
  return { map, player, enemy, game, place, core };
}

describe('hosted cannon routing', () => {
  it.each([
    ['W', -1, 0], ['E', 1, 0], ['N', 0, -1], ['S', 0, 1],
  ] as const)('reads the %s minicannon cone from its PointVector', (direction, dx, dy) => {
    const { place } = fixture();
    const cannon = place(`ZMINICANNON_${direction}`, 5, 5);
    const fields = cannon.getActionTargetFields()!;
    expect(fields).toHaveLength(16);
    expect(fields).toContainEqual({ x: dx, y: dy });
    expect(fields).toContainEqual({ x: dx ? dx * 4 : 3, y: dy ? dy * 4 : 3 });
    expect(fields).not.toContainEqual({ x: dy, y: dx });
    expect(cannon.getDamage(null)).toBe(3);
  });

  it('applies large-cannon offsets and scripted dimensions to the danger geometry', () => {
    const { place, core, map, player } = fixture();
    const cannon = place('ZBLACKHOLE_CANNON_W', 8, 6);
    expect(cannon.getBuildingWidth()).toBe(3);
    expect(cannon.getBuildingHeigth()).toBe(3);
    expect(cannon.getActionTargetOffset()).toEqual({ x: -2, y: -1 });
    const ai = core();
    expect(ai.moveCostMap[5 * map.width + 5]).toBe(5);
    expect(ai.moveCostMap[5 * map.width + 6]).toBe(0);
    const unit = map.addUnit('INFANTRY', player, 5, 5);
    expect(new DamagePredictor(map).calcBuildingDamage(player, unit, { x: 5, y: 5 }, cannon)).toBe(500);
  });

  it('adds overlapping ready weapons, ignores enemy-only friendly cannons, and refreshes cooldowns', () => {
    const { place, core, map, player } = fixture();
    const west = place('ZMINICANNON_W', 5, 5);
    const east = place('ZMINICANNON_E', 3, 5);
    place('ZMINICANNON_N', 4, 6, player);
    const ai = core();
    const index = 5 * map.width + 4;
    expect(ai.moveCostMap[index]).toBe(6);
    east.setFireCount(2);
    ai.createMovementMap();
    expect(ai.moveCostMap[index]).toBe(3);
    west.setOwner(player);
    ai.createMovementMap();
    expect(ai.moveCostMap[index]).toBe(0);
    // An owned laser targets everyone, so it remains a routing hazard.
    place('ZLASER', 4, 7, player);
    ai.createMovementMap();
    expect(ai.moveCostMap[index]).toBe(5);
  });

  it('routes around actual cannon coverage without a manually supplied penalty map', () => {
    const { place, core, map, player } = fixture();
    place('ZMINICANNON_N', 4, 7);
    const unit = map.addUnit('INFANTRY', player, 0, 4);
    const target = [{ x: 8, y: 4, z: 1 }];
    const ai = core();
    const normal = new TargetedUnitPathFindingSystem(map, unit, target).getReachableTargetField(3);
    const cautious = new TargetedUnitPathFindingSystem(map, unit, target, { moveCostMap: ai.moveCostMap }).getReachableTargetField(3);
    expect(normal).toEqual({ x: 3, y: 4 });
    expect(cautious).not.toEqual(normal);
    expect(cautious.y).not.toBe(4);
    expect(ai.moveCostMap[cautious.y * map.width + cautious.x]).toBe(0);
  });
});
