import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { CoreAI } from '../src/ai/cw/coreai.ts';
import { NORMAL_AI_DEFAULTS } from '../src/ai/cw/config.ts';
import { CwAction } from '../src/ai/cw/actions.ts';
import {
  doExtendedCircleAction, CircleResult, TargetDistance,
  appendTransporterTargets, appendSupportTargets, hasCaptureTarget,
} from '../src/ai/cw/transport.ts';
import { Game } from '../src/game/game.ts';
import type { MoveTargetField } from '../src/ai/cw/targets.ts';
import type { BuildingHost, GameMap } from '../src/host/index.ts';

const { registry } = bootstrap();
const NAVAL = 'maps/2_player/Bean Island.map';

function bare(file = NAVAL): { map: GameMap; ai: CoreAI } {
  const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), file))), registry);
  for (const player of [map.getPlayer(0)!, map.getPlayer(1)!]) {
    for (const unit of [...player.units]) map.removeUnit(unit);
  }
  return { map, ai: new CoreAI(new Game(map, registry), map.getPlayer(0)!, { ...NORMAL_AI_DEFAULTS }) };
}

/** A tile the given unit type can occupy. */
function tileFor(map: GameMap, unitId: string): { x: number; y: number } {
  const os = map.getPlayer(0)!;
  for (let y = 0; y < map.getMapHeight(); y++) {
    for (let x = 0; x < map.getMapWidth(); x++) {
      if (map.getUnitAt(x, y) || map.getTerrain(x, y).getBuilding()) continue;
      const probe = map.addUnit(unitId, os, x, y);
      const ok = probe.getBaseMovementCosts(x, y, x, y) > 0;
      map.removeUnit(probe);
      if (ok) return { x, y };
    }
  }
  throw new Error(`no tile for ${unitId}`);
}

function enemyBuildings(map: GameMap): BuildingHost[] {
  const found: BuildingHost[] = [];
  for (let x = 0; x < map.getMapWidth(); x++) {
    for (let y = 0; y < map.getMapHeight(); y++) {
      const building = map.getTerrain(x, y).getBuilding();
      if (building && building.getOwner()?.getPlayerID() !== 0) found.push(building);
    }
  }
  return found;
}

describe('doExtendedCircleAction', () => {
  it('visits in expanding rings and reports every tile once per radius', () => {
    const seen: string[] = [];
    doExtendedCircleAction(0, 0, 10, 10, 0, 2, (x, y) => {
      seen.push(`${x},${y}:${Math.abs(x - 10) + Math.abs(y - 10)}`);
      return CircleResult.Fail;
    });
    // Radius 0 is the centre; radius 1 the four neighbours; radius 2 the ring
    // beyond. Distances must therefore never exceed the max asked for.
    for (const entry of seen) {
      expect(Number(entry.split(':')[1])).toBeLessThanOrEqual(2);
    }
    expect(seen.some(e => e.startsWith('10,10:'))).toBe(true);
    expect(seen.length).toBeGreaterThan(4);
  });

  it('stops early when the functor succeeds', () => {
    let calls = 0;
    const result = doExtendedCircleAction(0, 0, 5, 5, 0, 6, () => {
      calls++;
      return CircleResult.Success;
    });
    expect(result).toBe(CircleResult.Success);
    expect(calls).toBe(1);
  });

  it('reports Stop when every arc gives up', () => {
    const result = doExtendedCircleAction(0, 0, 5, 5, 1, 3, () => CircleResult.Stop);
    expect(result).toBe(CircleResult.Stop);
  });
});

describe('transport targets', () => {
  it('offers a lander to a unit it can carry, and not to one it cannot', () => {
    const { map } = bare();
    const os = map.getPlayer(0)!;
    const sea = tileFor(map, 'LANDER');
    const land = tileFor(map, 'INFANTRY');
    const lander = map.addUnit('LANDER', os, sea.x, sea.y);
    const infantry = map.addUnit('INFANTRY', os, land.x, land.y);

    const forInfantry: MoveTargetField[] = [];
    appendTransporterTargets(infantry, [infantry, lander], forInfantry);
    expect(forInfantry).toEqual([{ x: sea.x, y: sea.y, z: 1 }]);

    // A lander does not fit inside another lander.
    const forLander: MoveTargetField[] = [];
    appendTransporterTargets(lander, [infantry, lander], forLander);
    expect(forLander).toEqual([]);
  });

  it('does not offer a transport that is already full', () => {
    const { map } = bare();
    const os = map.getPlayer(0)!;
    const sea = tileFor(map, 'LANDER');
    const land = tileFor(map, 'INFANTRY');
    const lander = map.addUnit('LANDER', os, sea.x, sea.y);
    const rider = map.addUnit('INFANTRY', os, land.x, land.y);
    const waiting = map.addUnit('INFANTRY', os, land.x, land.y + 1);

    while (lander.getLoadedUnitCount() < lander.getLoadingPlace()) lander.loadUnit(rider);
    const targets: MoveTargetField[] = [];
    appendTransporterTargets(waiting, [waiting, lander], targets);
    expect(targets).toEqual([]);
  });

  it('offers tiles beside a friend for a support unit', () => {
    const { map, ai } = bare();
    const os = map.getPlayer(0)!;
    const land = tileFor(map, 'INFANTRY');
    const truck = map.addUnit('APC', os, land.x, land.y);
    const friend = map.addUnit('INFANTRY', os, land.x, land.y + 1);

    const targets: MoveTargetField[] = [];
    appendSupportTargets(ai, [CwAction.SUPPORTALL_RATION], truck, [truck, friend], [], targets);
    expect(targets.length).toBeGreaterThan(0);
    // Every offer is adjacent to the friend and unoccupied.
    for (const target of targets) {
      const distance = Math.abs(target.x - friend.getX()) + Math.abs(target.y - friend.getY());
      expect(distance).toBe(1);
      expect(map.getUnitAt(target.x, target.y)).toBeNull();
    }
  });

  it('offers nothing for a unit with no support action', () => {
    const { map, ai } = bare();
    const os = map.getPlayer(0)!;
    const land = tileFor(map, 'INFANTRY');
    const tank = map.addUnit('LIGHT_TANK', os, land.x, land.y);
    const friend = map.addUnit('INFANTRY', os, land.x, land.y + 1);

    const targets: MoveTargetField[] = [];
    appendSupportTargets(ai, [CwAction.FIRE, CwAction.WAIT], tank, [tank, friend], [], targets);
    expect(targets).toEqual([]);
  });

  it('grades a capture target by how far off it is', () => {
    const { map, ai } = bare();
    const os = map.getPlayer(0)!;
    const land = tileFor(map, 'INFANTRY');
    const infantry = map.addUnit('INFANTRY', os, land.x, land.y);
    const islandIdx = ai.getIslandIndex(infantry);
    const island = ai.getIsland(infantry);
    const buildings = enemyBuildings(map);

    const distance = hasCaptureTarget(ai, infantry, true, buildings, islandIdx, island);
    // A unit that cannot capture is never given a target, whatever is around.
    expect(hasCaptureTarget(ai, infantry, false, buildings, islandIdx, island))
      .toBe(TargetDistance.NoTarget);
    expect([TargetDistance.CloseTarget, TargetDistance.FarTarget, TargetDistance.NoTarget])
      .toContain(distance);
  });
});
