import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { IslandMap, UNKNOWN_ISLAND } from '../src/ai/cw/islandmap.ts';
import type { GameMap } from '../src/host/index.ts';

const { registry } = bootstrap();

function load(file: string): GameMap {
  return loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), file))), registry);
}

/** A land map, and one with real water to separate. */
const LAND = 'maps/2_player/60-ZWEITER KRIEG.map';
const NAVAL = 'maps/2_player/Bean Island.map';

describe('IslandMap', () => {
  it('gives infantry one island per connected landmass', () => {
    const map = load(LAND);
    const islands = new IslandMap(map, 'INFANTRY', map.getPlayer(0)!);
    expect(islands.getMovementType()).toBe('MOVE_FEET');

    // Every tile is either unreachable or carries a component id, and the ids
    // are dense from zero.
    const seen = new Set<number>();
    for (let x = 0; x < map.getMapWidth(); x++) {
      for (let y = 0; y < map.getMapHeight(); y++) {
        const island = islands.getIsland(x, y);
        if (island !== UNKNOWN_ISLAND) seen.add(island);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBe(seen.size - 1);
    // Sizes partition the reachable tiles.
    const total = [...seen].reduce((sum, island) => sum + islands.getIslandSize(island), 0);
    expect(total).toBeGreaterThan(0);
  });

  it('puts both HQs on the same island for infantry on a land map', () => {
    const map = load(LAND);
    const islands = new IslandMap(map, 'INFANTRY', map.getPlayer(0)!);
    const hqs: Array<{ x: number; y: number }> = [];
    for (let x = 0; x < map.getMapWidth(); x++) {
      for (let y = 0; y < map.getMapHeight(); y++) {
        const building = map.getTerrain(x, y).getBuilding();
        if (building?.getBuildingID() === 'HQ') hqs.push({ x, y });
      }
    }
    expect(hqs.length).toBeGreaterThanOrEqual(2);
    // A land map is walkable end to end; that is what makes it a land map.
    expect(islands.sameIsland(hqs[0].x, hqs[0].y, hqs[1].x, hqs[1].y)).toBe(true);
  });

  it('separates what infantry and ships can reach', () => {
    const map = load(NAVAL);
    const feet = new IslandMap(map, 'INFANTRY', map.getPlayer(0)!);
    const ship = new IslandMap(map, 'LANDER', map.getPlayer(0)!);
    expect(ship.getMovementType()).not.toBe(feet.getMovementType());

    // The two cover different tiles: water is passable to exactly one of them.
    let onlyFeet = 0, onlyShip = 0;
    for (let x = 0; x < map.getMapWidth(); x++) {
      for (let y = 0; y < map.getMapHeight(); y++) {
        const byFeet = feet.getIsland(x, y) !== UNKNOWN_ISLAND;
        const byShip = ship.getIsland(x, y) !== UNKNOWN_ISLAND;
        if (byFeet && !byShip) onlyFeet++;
        if (byShip && !byFeet) onlyShip++;
      }
    }
    expect(onlyFeet).toBeGreaterThan(0);
    expect(onlyShip).toBeGreaterThan(0);
  });

  it('treats two unreachable tiles as different islands', () => {
    const map = load(NAVAL);
    const ship = new IslandMap(map, 'LANDER', map.getPlayer(0)!);
    const land: Array<{ x: number; y: number }> = [];
    for (let x = 0; x < map.getMapWidth() && land.length < 2; x++) {
      for (let y = 0; y < map.getMapHeight() && land.length < 2; y++) {
        if (ship.getIsland(x, y) === UNKNOWN_ISLAND) land.push({ x, y });
      }
    }
    expect(land.length).toBe(2);
    // -1 == -1 must not read as "same island", or every ship would think it
    // could already reach every inland town.
    expect(ship.sameIsland(land[0].x, land[0].y, land[1].x, land[1].y)).toBe(false);
  });

  it('does not consume unit uids', () => {
    const map = load(LAND);
    const before = map.getUnitUidCounter();
    new IslandMap(map, 'INFANTRY', map.getPlayer(0)!);
    // A probe that issues a uid the real game never issued desynchronises every
    // later action, which is what once made planner games unreplayable.
    expect(map.getUnitUidCounter()).toBe(before);
  });

  it('counts what each side has parked on an island', () => {
    const map = load(LAND);
    const os = map.getPlayer(0)!, bm = map.getPlayer(1)!;
    const islands = new IslandMap(map, 'INFANTRY', os);
    const island = islands.getIsland(3, 8);
    expect(island).not.toBe(UNKNOWN_ISLAND);
    // The map ships with units already placed, so measure what adding one moves.
    const before = islands.getValueOnIsland(island);

    const mine = map.addUnit('INFANTRY', os, 3, 8);
    const theirs = map.addUnit('INFANTRY', bm, 4, 8);
    const after = islands.getValueOnIsland(island);
    expect(after.own - before.own).toBe(mine.getCoUnitValue());
    expect(after.enemy - before.enemy).toBe(theirs.getCoUnitValue());
  });
});
