import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { TargetedUnitPathFindingSystem } from '../src/ai/cw/targetedpfs.ts';
import { computeMovementRange, key } from '../src/game/pathfinding.ts';
import type { GameMap } from '../src/host/index.ts';

const { registry } = bootstrap();
const LAND = 'maps/2_player/60-ZWEITER KRIEG.map';

function load(): GameMap {
  return loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), LAND))), registry);
}

/** An empty tile the given unit type can stand on, nearest to (ox, oy). */
function freeTile(map: GameMap, ox: number, oy: number): { x: number; y: number } {
  let best: { x: number; y: number } | null = null, bestDistance = Infinity;
  for (let x = 0; x < map.getMapWidth(); x++) {
    for (let y = 0; y < map.getMapHeight(); y++) {
      if (map.getUnitAt(x, y)) continue;
      const distance = Math.abs(x - ox) + Math.abs(y - oy);
      if (distance < bestDistance) { bestDistance = distance; best = { x, y }; }
    }
  }
  return best!;
}

describe('TargetedUnitPathFindingSystem', () => {
  it('moves toward a distant target, as far as this turn allows', () => {
    const map = load();
    const os = map.getPlayer(0)!;
    const start = freeTile(map, 2, 7);
    const unit = map.addUnit('INFANTRY', os, start.x, start.y);
    // Somewhere genuinely far away, on the same landmass.
    const target = { x: map.getMapWidth() - 2, y: start.y, z: 1 };

    const pfs = new TargetedUnitPathFindingSystem(map, unit, [target]);
    const points = unit.getMovementpoints();
    const step = pfs.getReachableTargetField(points);

    expect(step.x).toBeGreaterThanOrEqual(0);
    // It must be somewhere the unit can actually reach this turn...
    const range = computeMovementRange(map, unit);
    expect(range.tiles.has(key(step.x, step.y))).toBe(true);
    // ...and it must make progress rather than sitting still.
    const before = Math.abs(start.x - target.x) + Math.abs(start.y - target.y);
    const after = Math.abs(step.x - target.x) + Math.abs(step.y - target.y);
    expect(after).toBeLessThan(before);
  });

  it('stops on the target itself when it is already in reach', () => {
    const map = load();
    const os = map.getPlayer(0)!;
    const start = freeTile(map, 2, 7);
    const unit = map.addUnit('INFANTRY', os, start.x, start.y);
    const range = computeMovementRange(map, unit);
    // A reachable tile that is not where we already stand.
    const reachable = [...range.tiles.values()]
      .find(tile => tile.canStop && tile.cost > 0 && tile.cost <= unit.getMovementpoints())!;
    expect(reachable).toBeDefined();

    const pfs = new TargetedUnitPathFindingSystem(
      map, unit, [{ x: reachable.x, y: reachable.y, z: 1 }]);
    const step = pfs.getReachableTargetField(unit.getMovementpoints());
    expect(step).toEqual({ x: reachable.x, y: reachable.y });
  });

  it('prefers the nearer of two equally weighted targets', () => {
    const map = load();
    const os = map.getPlayer(0)!;
    const start = freeTile(map, 2, 7);
    const unit = map.addUnit('INFANTRY', os, start.x, start.y);

    const near = { x: start.x, y: Math.min(start.y + 2, map.getMapHeight() - 1), z: 1 };
    const far = { x: map.getMapWidth() - 2, y: start.y, z: 1 };
    const pfs = new TargetedUnitPathFindingSystem(map, unit, [far, near]);
    // The sort is by weighted distance, so the near one leads regardless of the
    // order it was handed in.
    expect(pfs.getTargets()[0]).toMatchObject({ x: near.x, y: near.y });
  });

  it('lets a weight push the AI toward the further target', () => {
    const map = load();
    const os = map.getPlayer(0)!;
    const start = freeTile(map, 2, 7);
    const unit = map.addUnit('INFANTRY', os, start.x, start.y);

    const near = { x: start.x, y: Math.min(start.y + 3, map.getMapHeight() - 1), z: 4 };
    const far = { x: Math.min(start.x + 5, map.getMapWidth() - 1), y: start.y, z: 1 };
    const pfs = new TargetedUnitPathFindingSystem(map, unit, [near, far]);
    // Weight 4 makes the three-tile target feel twelve away, so the five-tile
    // one at weight 1 sorts first.
    expect(pfs.getTargets()[0]).toMatchObject({ x: far.x, y: far.y });
  });

  it('reports nowhere to go when no target is reachable', () => {
    const map = load();
    const os = map.getPlayer(0)!;
    const start = freeTile(map, 2, 7);
    const unit = map.addUnit('INFANTRY', os, start.x, start.y);
    // Off the board entirely: no node can ever match it.
    const pfs = new TargetedUnitPathFindingSystem(
      map, unit, [{ x: map.getMapWidth() + 5, y: map.getMapHeight() + 5, z: 1 }]);
    expect(pfs.getReachableTargetField(unit.getMovementpoints())).toEqual({ x: -1, y: -1 });
  });

  it('keeps only the nearest maxTargets', () => {
    const map = load();
    const os = map.getPlayer(0)!;
    const start = freeTile(map, 2, 7);
    const unit = map.addUnit('INFANTRY', os, start.x, start.y);
    const targets = [];
    for (let x = 0; x < map.getMapWidth(); x++) targets.push({ x, y: start.y, z: 1 });
    expect(targets.length).toBeGreaterThan(3);

    const pfs = new TargetedUnitPathFindingSystem(map, unit, targets, { maxTargets: 3 });
    expect(pfs.getTargets().length).toBe(3);
    // The survivors are the three closest to the unit.
    const distances = pfs.getTargets().map(t => Math.abs(t.x - start.x) + Math.abs(t.y - start.y));
    expect([...distances].sort((a, b) => a - b)).toEqual(distances.slice().sort((a, b) => a - b));
    expect(Math.max(...distances)).toBeLessThanOrEqual(3);
  });
});
