import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { snapshot } from '../src/game/snapshot.ts';
import { computeMovementRange } from '../src/game/pathfinding.ts';
import { CoreAI } from '../src/ai/cw/coreai.ts';
import { NORMAL_AI_DEFAULTS } from '../src/ai/cw/config.ts';
import { TargetedUnitPathFindingSystem } from '../src/ai/cw/targetedpfs.ts';
import { getClosestReachableMovePath, getMoveTargetField, moveToSafety } from '../src/ai/cw/movement.ts';
import { appendUnloadTargetsForCapturing, appendUnloadTargetsForAttacking } from '../src/ai/cw/transport.ts';
import { InfluenceFrontMap } from '../src/ai/cw/influencefrontmap.ts';
import { createUnitData } from '../src/ai/cw/unitdata.ts';
import type { MoveTargetField } from '../src/ai/cw/targets.ts';

const { createMap, registry, animations } = bootstrap();
function board(terrain = 'PLAINS') {
  const map = createMap(9, 3, terrain);
  const player = map.addPlayer('os'), enemy = map.addPlayer('bm');
  player.team = 0; enemy.team = 1;
  const game = new Game(map, registry, animations);
  const core = new CoreAI(game, player, { ...NORMAL_AI_DEFAULTS });
  return { map, player, enemy, game, core };
}

describe('AI navigation sees apparent occupancy', () => {
  it('does not let an unseen future blocker consume its long-route fuel budget', () => {
    const { map, player, enemy } = board();
    const infantry = map.addUnit('INFANTRY', player, 0, 1);
    infantry.setFuel(8);
    const hidden = map.addUnit('INFANTRY', enemy, 5, 1);
    hidden.setHidden(true);
    const plan = () => new TargetedUnitPathFindingSystem(map, infantry, [{ x: 8, y: 1, z: 1 }])
      .getReachableTargetField(infantry.getMovementpoints());
    expect(hidden.isStealthed(player)).toBe(true);
    const onRoute = plan();
    hidden.y = 0;
    expect(hidden.isStealthed(player)).toBe(true);
    expect(plan()).toEqual(onRoute);
    expect(onRoute).toEqual({ x: 3, y: 1 });
  });

  it('keeps nearest-route and safety choices invariant, while real execution still ambushes', () => {
    const { map, game, player, enemy, core } = board();
    const infantry = map.addUnit('INFANTRY', player, 0, 1);
    const hidden = map.addUnit('INFANTRY', enemy, 3, 1);
    hidden.setHidden(true);
    const influence = new InfluenceFrontMap(map, core.islandMaps);
    influence.setOwner(player);
    const plan = () => {
      const data = createUnitData(infantry, false, 2, [], 0, true);
      const context = { ai: core, ownUnits: [data], enemyUnits: [], influence,
        targetOptions: { ...NORMAL_AI_DEFAULTS, enableNeutralTerrainAttack: false } };
      const path = getClosestReachableMovePath(core, infantry, data.range!, { x: 3, y: 1 }, 3);
      return {
        path: path.map(({ x, y }) => ({ x, y })),
        selected: getMoveTargetField(context, data, path, [], [], 3),
        safety: moveToSafety(context, data, { x: 4, y: 1 }, [], [], 3).point,
      };
    };
    const before = snapshot(game);
    const occupied = plan();
    expect(snapshot(game)).toEqual(before);
    hidden.y = 2;
    expect(plan()).toEqual(occupied);
    expect(occupied.path[0]).toEqual({ x: 3, y: 1 });
    expect(occupied.safety).toEqual({ x: 3, y: 1 });
    hidden.y = 1;
    const fuel = infantry.fuel;
    game.select(infantry.x, infantry.y);
    expect(game.moveSelected(3, 1).moved).toBe(true);
    expect(infantry.x).toBe(2);
    expect(infantry.fuel).toBe(fuel - 2);
    expect(map.getUnitAt(3, 1)).toBe(hidden);
  });

  it('does not remove a planned unloading shore because a hidden enemy occupies it', () => {
    const { map, game, player, enemy, core } = board('SEA');
    for (let y = 0; y < map.height; y++) {
      for (const x of [0, 1, 2, 7, 8]) map.setTerrainID(x, y, 'PLAINS');
      for (const x of [3, 6]) map.setTerrainID(x, y, 'BEACH');
    }
    const lander = map.addUnit('LANDER', player, 3, 1);
    const cargo = map.addUnit('INFANTRY', player, 2, 1);
    lander.loadUnit(cargo);
    map.getTerrain(7, 1).loadBuilding('TOWN');
    const town = map.getTerrain(7, 1).getBuilding()!;
    const hidden = map.addUnit('INFANTRY', enemy, 6, 1);
    hidden.setHidden(true);
    const plan = () => {
      const targets: MoveTargetField[] = [];
      appendUnloadTargetsForCapturing(core, lander, player.units, [town], targets);
      return targets;
    };
    expect(hidden.isStealthed(player)).toBe(true);
    const onShore = plan();
    const before = snapshot(game);
    expect(plan()).toEqual(onShore);
    expect(snapshot(game)).toEqual(before);
    hidden.x = 8; hidden.y = 2;
    expect(plan()).toEqual(onShore);
    expect(onShore).toContainEqual({ x: 6, y: 1, z: 1 });
  });

  it('ignores unseen attack objectives even when callers supply an unfiltered enemy list', () => {
    const { map, player, enemy, core } = board('SEA');
    for (let y = 0; y < map.height; y++) {
      map.setTerrainID(6, y, 'BEACH');
      for (const x of [7, 8]) map.setTerrainID(x, y, 'PLAINS');
    }
    const lander = map.addUnit('LANDER', player, 2, 1);
    const cargo = map.addUnit('INFANTRY', player, 0, 0);
    lander.loadUnit(cargo);
    const hidden = map.addUnit('INFANTRY', enemy, 7, 1);
    hidden.setHidden(true);
    const targets: MoveTargetField[] = [];
    appendUnloadTargetsForAttacking(core, lander, [hidden], targets, 2);
    expect(targets).toEqual([]);
    hidden.setHidden(false);
    appendUnloadTargetsForAttacking(core, lander, [hidden], targets, 2);
    expect(targets.length).toBeGreaterThan(0);
    expect(computeMovementRange(map, lander).tiles.size).toBeGreaterThan(1);
  });
});
