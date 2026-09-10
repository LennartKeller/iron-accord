import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { computeMovementRange, key } from '../src/game/pathfinding.ts';
import { CoreAI } from '../src/ai/cw/coreai.ts';
import { NORMAL_AI_DEFAULTS } from '../src/ai/cw/config.ts';
import { InfluenceFrontMap } from '../src/ai/cw/influencefrontmap.ts';
import { hasTargets, moveToSafety } from '../src/ai/cw/movement.ts';
import { appendCaptureTransporterTargets, appendLoadingTargets } from '../src/ai/cw/transport.ts';
import { createUnitData } from '../src/ai/cw/unitdata.ts';
import type { MoveTargetField } from '../src/ai/cw/targets.ts';

const { createMap, registry } = bootstrap();

function transportScenario(townX: number | null) {
  const map = createMap(20, 3, 'PLAINS');
  const player = map.addPlayer('os');
  const infantry = map.addUnit('INFANTRY', player, 2, 1);
  const transport = map.addUnit('APC', player, 0, 1);
  if (townX !== null) map.getTerrain(townX, 1).loadBuilding('TOWN');
  const buildings = townX === null ? [] : [map.getTerrain(townX, 1).getBuilding()!];
  const ai = new CoreAI(new Game(map, registry), player, { ...NORMAL_AI_DEFAULTS });
  return { map, ai, infantry, transport, buildings };
}

describe('CW transport target boundaries', () => {
  it.each([
    { name: 'no objectives', townX: null, hasLocalWork: false, seekRide: false, pickupWeight: 1 },
    { name: 'near capture', townX: 4, hasLocalWork: true, seekRide: false, pickupWeight: null },
    { name: 'far capture', townX: 15, hasLocalWork: false, seekRide: true, pickupWeight: 3 },
  ])('$name controls whether infantry walk or seek transport', ({ townX, hasLocalWork, seekRide, pickupWeight }) => {
    const { ai, infantry, transport, buildings } = transportScenario(townX);
    const islandIndex = ai.getIslandIndex(infantry);
    const island = ai.getIsland(infantry);
    expect(hasTargets(ai, transport.getMovementpoints(), infantry, true,
      [], buildings, islandIndex, island)).toBe(hasLocalWork);

    const rides: MoveTargetField[] = [];
    appendCaptureTransporterTargets(ai, infantry, [transport], buildings, rides);
    expect(rides.length > 0).toBe(seekRide);

    const pickup: MoveTargetField[] = [];
    const passengers = appendLoadingTargets(ai, transport, [infantry], [], buildings,
      true, false, pickup, true, 1, true);
    if (pickupWeight === null) {
      expect(passengers).toEqual([]);
      expect(pickup).toEqual([]);
    } else {
      expect(passengers).toEqual([infantry]);
      expect(pickup).toHaveLength(1);
      expect(pickup[0].z).toBe(pickupWeight);
    }
  });

  it('keeps safety moves inside the actual turn budget despite an expanded search range', () => {
    const map = createMap(6, 1, 'PLAINS');
    const player = map.addPlayer('os');
    const infantry = map.addUnit('INFANTRY', player, 0, 0);
    const ai = new CoreAI(new Game(map, registry), player, { ...NORMAL_AI_DEFAULTS });
    const data = createUnitData(infantry, false, 2, [], 0, true);
    const influence = new InfluenceFrontMap(map, ai.islandMaps);
    influence.setOwner(player);
    const { point } = moveToSafety({
      ai, ownUnits: [data], enemyUnits: [], influence,
      targetOptions: { ...NORMAL_AI_DEFAULTS, enableNeutralTerrainAttack: false },
    }, data, { x: 5, y: 0 }, [], [], data.movementPoints);

    expect(point).toEqual({ x: 3, y: 0 });
    const tile = computeMovementRange(map, infantry).tiles.get(key(point.x, point.y));
    expect(tile?.canStop).toBe(true);
    expect(tile!.cost).toBeLessThanOrEqual(infantry.getMovementpoints());
  });
});
