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
import { computeMovementRange } from '../src/game/pathfinding.ts';
import { Game } from '../src/game/game.ts';
import type { MoveTargetField } from '../src/ai/cw/targets.ts';
import type { BuildingHost, GameMap } from '../src/host/index.ts';

const { registry } = bootstrap();
const LAND = 'maps/2_player/60-ZWEITER KRIEG.map';

/** A board cleared of the map's own units, so assertions are about what we place. */
function bare(): { map: GameMap; ai: CoreAI } {
  const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), LAND))), registry);
  for (const player of [map.getPlayer(0)!, map.getPlayer(1)!]) {
    for (const unit of [...player.units]) map.removeUnit(unit);
  }
  const game = new Game(map, registry);
  return { map, ai: new CoreAI(game, map.getPlayer(0)!, { ...NORMAL_AI_DEFAULTS }) };
}

function buildingsOf(map: GameMap, owner: number | null): BuildingHost[] {
  const found: BuildingHost[] = [];
  for (let x = 0; x < map.getMapWidth(); x++) {
    for (let y = 0; y < map.getMapHeight(); y++) {
      const building = map.getTerrain(x, y).getBuilding();
      if (!building) continue;
      const id = building.getOwner()?.getPlayerID() ?? null;
      if (id === owner) found.push(building);
    }
  }
  return found;
}

/** Somewhere infantry can stand. */
function landTile(map: GameMap): { x: number; y: number } {
  const os = map.getPlayer(0)!;
  for (let y = 0; y < map.getMapHeight(); y++) {
    for (let x = 0; x < map.getMapWidth(); x++) {
      if (map.getUnitAt(x, y) || map.getTerrain(x, y).getBuilding()) continue;
      const probe = map.addUnit('INFANTRY', os, x, y);
      const ok = computeMovementRange(map, probe).tiles.size > 1;
      map.removeUnit(probe);
      if (ok) return { x, y };
    }
  }
  throw new Error('no land tile');
}

/** `count` collinear tiles in a column that infantry and tanks can all stand on. */
function landRun(map: GameMap, count: number): Array<{ x: number; y: number }> {
  const os = map.getPlayer(0)!;
  const passable = (x: number, y: number): boolean => {
    if (map.getUnitAt(x, y) || map.getTerrain(x, y).getBuilding()) return false;
    const probe = map.addUnit('LIGHT_TANK', os, x, y);
    const ok = probe.getBaseMovementCosts(x, y, x, y) > 0;
    map.removeUnit(probe);
    return ok;
  };
  for (let x = 0; x < map.getMapWidth(); x++) {
    for (let y = 0; y + count <= map.getMapHeight(); y++) {
      const run = [];
      for (let i = 0; i < count; i++) {
        if (!passable(x, y + i)) break;
        run.push({ x, y: y + i });
      }
      if (run.length === count) return run;
    }
  }
  throw new Error(`no run of ${count} land tiles`);
}

describe('CoreAI', () => {
  it('builds one island map per movement type, reusing them', () => {
    const { map, ai } = bare();
    const os = map.getPlayer(0)!;
    const at = landTile(map);
    const infantry = map.addUnit('INFANTRY', os, at.x, at.y);
    const second = map.addUnit('INFANTRY', os, at.x, at.y + 1);
    const lander = map.addUnit('LANDER', os, at.x, at.y);

    const feet = ai.getIslandIndex(infantry);
    // Same movement type, same map -- the cache is keyed on the type, not the unit.
    expect(ai.getIslandIndex(second)).toBe(feet);
    expect(ai.islandMaps.length).toBe(1);
    // A different movement type gets its own, because it reaches other tiles.
    expect(map.movementTypeOfId('LANDER')).not.toBe(map.movementTypeOfId('INFANTRY'));
    expect(ai.getIslandIndex(lander)).not.toBe(feet);
    expect(ai.islandMaps.length).toBe(2);
  });

  it('reports whether a unit can walk to a building', () => {
    const { map, ai } = bare();
    const os = map.getPlayer(0)!;
    const at = landTile(map);
    const infantry = map.addUnit('INFANTRY', os, at.x, at.y);
    ai.getIslandIndex(infantry);
    // Its own tile is trivially on its own island.
    expect(ai.onSameIsland(infantry, at.x, at.y)).toBe(true);
  });

  it('offers capture targets only for a unit that can capture', () => {
    const { map, ai } = bare();
    const os = map.getPlayer(0)!;
    const at = landTile(map);
    const infantry = map.addUnit('INFANTRY', os, at.x, at.y);
    const enemyBuildings = buildingsOf(map, 1).concat(buildingsOf(map, null));

    const withCapture: MoveTargetField[] = [];
    ai.appendCaptureTargets([CwAction.CAPTURE], infantry, enemyBuildings, withCapture, 1);
    const without: MoveTargetField[] = [];
    ai.appendCaptureTargets([CwAction.WAIT], infantry, enemyBuildings, without, 1);

    expect(withCapture.length).toBeGreaterThan(0);
    // A tank has no ACTION_CAPTURE, so it must be offered nothing here at all.
    expect(without).toEqual([]);
  });

  it('offers firing positions at exactly maximum range', () => {
    const { map, ai } = bare();
    const os = map.getPlayer(0)!, bm = map.getPlayer(1)!;
    const at = landTile(map);
    const artillery = map.addUnit('ARTILLERY', os, at.x, at.y);
    const victim = map.addUnit('INFANTRY', bm, at.x, at.y + 1);

    const targets: MoveTargetField[] = [];
    ai.appendAttackTargets(artillery, [victim], targets, 1);
    const reach = artillery.getMaxRange();
    for (const target of targets) {
      const distance = Math.abs(target.x - victim.getX()) + Math.abs(target.y - victim.getY());
      expect(distance).toBe(reach);
      // Only free tiles: you cannot set up where something already stands.
      expect(map.getUnitAt(target.x, target.y)).toBeNull();
    }
  });

  it('ranks a firing position held by a friend below a free one', () => {
    const { map, ai } = bare();
    const os = map.getPlayer(0)!, bm = map.getPlayer(1)!;
    const run = landRun(map, 3);
    const tank = map.addUnit('LIGHT_TANK', os, run[0].x, run[0].y);
    const victim = map.addUnit('INFANTRY', bm, run[2].x, run[2].y);
    // A friend parked on a tile the tank would otherwise shoot from.
    map.addUnit('INFANTRY', os, run[1].x, run[1].y);

    const free: MoveTargetField[] = [];
    ai.appendAttackTargets(tank, [victim], free, 1);
    const blocked: MoveTargetField[] = [];
    ai.appendAttackTargetsIgnoreOwnUnits(tank, [victim], blocked, 1);

    expect(blocked).toContainEqual({ x: run[1].x, y: run[1].y, z: 5 });
    // The +4 is what keeps "wait for a friend to move" below "just go there".
    for (const target of blocked) expect(target.z).toBeGreaterThanOrEqual(5);
    for (const target of free) expect(target.z).toBe(1);
    // The occupied tile is never offered as a free one.
    expect(free).not.toContainEqual({ x: run[1].x, y: run[1].y, z: 1 });
  });

  it('calls a unit low on ammo a supply target', () => {
    const { map, ai } = bare();
    const os = map.getPlayer(0)!;
    const run = landRun(map, 2);
    const truck = map.addUnit('APC', os, run[0].x, run[0].y);
    const thirsty = map.addUnit('ARTILLERY', os, run[1].x, run[1].y);

    const full: MoveTargetField[] = [];
    ai.appendSupplyTargets(truck, [truck, thirsty], full);
    expect(full).toEqual([]);

    thirsty.ammo1 = 1;
    expect(thirsty.getMaxAmmo1()).toBeGreaterThan(2);
    const low: MoveTargetField[] = [];
    ai.appendSupplyTargets(truck, [truck, thirsty], low);
    expect(low).toEqual([{ x: thirsty.getX(), y: thirsty.getY(), z: 1 }]);
  });

  it('does not call a unit at exactly zero ammo a supply target', () => {
    const { map, ai } = bare();
    const os = map.getPlayer(0)!;
    const run = landRun(map, 2);
    const truck = map.addUnit('APC', os, run[0].x, run[0].y);
    const dry = map.addUnit('ARTILLERY', os, run[1].x, run[1].y);
    dry.ammo1 = 0;

    // Upstream gates the low-ammo test on hasAmmo1(), which is false at zero,
    // so the unit that most needs resupply is the one appendSupplyTargets
    // skips. Transcribed, not corrected -- needsRefuel has no such gate, so a
    // dry unit still goes looking for a depot itself.
    const targets: MoveTargetField[] = [];
    ai.appendSupplyTargets(truck, [truck, dry], targets);
    expect(targets).toEqual([]);
    expect(ai.needsRefuel(dry)).toBe(true);
  });

  it('will not settle a unit on its own reachable factory', () => {
    const { map, ai } = bare();
    const os = map.getPlayer(0)!;
    const factory = buildingsOf(map, 0).find(b => b.isProductionBuilding());
    expect(factory).toBeDefined();
    const infantry = map.addUnit('INFANTRY', os, factory!.getX(), factory!.getY());
    const range = computeMovementRange(map, infantry);

    // Blocking your own factory is how the piperunner stalemate happened.
    expect(ai.isMoveableTile(factory!, range)).toBe(false);
    expect(ai.isMoveableTile(null, range)).toBe(true);
  });

  it('wants a refuel when fuel runs low', () => {
    const { map, ai } = bare();
    const os = map.getPlayer(0)!;
    const at = landTile(map);
    const plane = map.addUnit('FIGHTER', os, at.x, at.y);
    expect(ai.needsRefuel(plane)).toBe(false);
    plane.fuel = Math.floor(plane.getMaxFuel() * NORMAL_AI_DEFAULTS.fuelResupply);
    expect(ai.needsRefuel(plane)).toBe(true);
  });
});
