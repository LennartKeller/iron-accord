import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { IslandMap } from '../src/ai/cw/islandmap.ts';
import { InfluenceFrontMap } from '../src/ai/cw/influencefrontmap.ts';
import { computeMovementRange } from '../src/game/pathfinding.ts';
import type { GameMap } from '../src/host/index.ts';

const { registry } = bootstrap();
const LAND = 'maps/2_player/60-ZWEITER KRIEG.map';

function load(): GameMap {
  return loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), LAND))), registry);
}

/** The island maps NormalAi would have built: one per movement type it can field. */
function islandsFor(map: GameMap): IslandMap[] {
  const owner = map.getPlayer(0)!;
  const seen = new Set<string>();
  const islands: IslandMap[] = [];
  for (const unitId of ['INFANTRY', 'LIGHT_TANK', 'FIGHTER', 'LANDER']) {
    const type = map.movementTypeOfId(unitId);
    if (seen.has(type)) continue;
    seen.add(type);
    islands.push(new IslandMap(map, unitId, owner));
  }
  return islands;
}

function built(map: GameMap): InfluenceFrontMap {
  const influence = new InfluenceFrontMap(map, islandsFor(map));
  influence.setOwner(map.getPlayer(0)!);
  influence.addBuildingInfluence();
  influence.updateOwners();
  influence.calculateGlobalData();
  return influence;
}

/** Where each player's HQ sits. */
function hqs(map: GameMap): Array<{ x: number; y: number; owner: number }> {
  const found: Array<{ x: number; y: number; owner: number }> = [];
  for (let x = 0; x < map.getMapWidth(); x++) {
    for (let y = 0; y < map.getMapHeight(); y++) {
      const building = map.getTerrain(x, y).getBuilding();
      const owner = building?.getOwner();
      if (building?.getBuildingID() === 'HQ' && owner) {
        found.push({ x, y, owner: owner.getPlayerID() });
      }
    }
  }
  return found;
}

describe('InfluenceFrontMap', () => {
  it('gives each side the ground around its own factories', () => {
    const map = load();
    const influence = built(map);
    const [first, second] = hqs(map);
    expect(first.owner).not.toBe(second.owner);

    // Seen from player 0, its own half is friendly and the far half is not.
    const home = influence.getInfluenceInfo(first.x, first.y);
    const away = influence.getInfluenceInfo(second.x, second.y);
    expect(home.getOwnInfluence()).toBeGreaterThan(home.getEnemyInfluence());
    expect(away.getEnemyInfluence()).toBeGreaterThan(away.getOwnInfluence());
  });

  it('names the nearer player as the tile owner', () => {
    const map = load();
    const influence = built(map);
    const [first, second] = hqs(map);
    expect(influence.getInfluenceInfo(first.x, first.y).owners).toEqual([first.owner]);
    expect(influence.getInfluenceInfo(second.x, second.y).owners).toEqual([second.owner]);
  });

  it('decays with distance from the factory', () => {
    const map = load();
    const influence = built(map);
    const [first] = hqs(map);
    const owner = map.getPlayer(first.owner)!;
    const at = (x: number, y: number) =>
      influence.getInfluenceInfo(x, y).getPlayerInfluence(owner.getPlayerID());

    // Walk away along a row that stays on the board and compare the ends.
    const near = at(first.x, first.y);
    let far = near;
    for (let x = 0; x < map.getMapWidth(); x++) {
      const value = at(x, first.y);
      if (value < far) far = value;
    }
    expect(far).toBeLessThan(near);
  });

  it('resets to a blank board', () => {
    const map = load();
    const influence = built(map);
    const [first] = hqs(map);
    expect(influence.getInfluenceInfo(first.x, first.y).getOwnInfluence()).toBeGreaterThan(0);

    influence.clear();
    const info = influence.getInfluenceInfo(first.x, first.y);
    expect(info.getOwnInfluence()).toBe(0);
    expect(info.getEnemyInfluence()).toBe(0);
    expect(info.owners).toEqual([]);
    expect(influence.getTotalHighestInfluence()).toBe(0);
  });

  it('projects an armed unit but not an empty transport', () => {
    const map = load();
    const os = map.getPlayer(0)!;
    const islands = islandsFor(map);
    const [first] = hqs(map);

    const measure = (unitId: string) => {
      const influence = new InfluenceFrontMap(map, islands);
      influence.setOwner(os);
      const unit = map.addUnit(unitId, os, first.x, first.y);
      const range = computeMovementRange(map, unit);
      influence.addUnitInfluence(unit, range, unit.getMovementpoints());
      influence.updateOwners();
      const value = influence.getInfluenceInfo(first.x, first.y).getPlayerInfluence(0);
      map.removeUnit(unit);
      return value;
    };

    // An APC carries no weapon, so with an empty hold it threatens nothing.
    expect(measure('LIGHT_TANK')).toBeGreaterThan(0);
    expect(measure('APC')).toBe(0);
  });

  it('thins a unit"s influence with travel distance', () => {
    const map = load();
    const os = map.getPlayer(0)!;
    const [first] = hqs(map);
    const influence = new InfluenceFrontMap(map, islandsFor(map));
    influence.setOwner(os);

    const unit = map.addUnit('LIGHT_TANK', os, first.x, first.y);
    const points = unit.getMovementpoints();
    // Explore three turns out, as the AI does, so there are tiles beyond one
    // turn's reach for the per-turn divider to actually thin.
    const range = computeMovementRange(map, unit, { budget: points * 3 });
    influence.addUnitInfluence(unit, range, points);

    const here = influence.getInfluenceInfo(first.x, first.y).getPlayerInfluence(0);
    let farthest = here;
    for (const tile of range.tiles.values()) {
      if (tile.cost <= points) continue;
      const value = influence.getInfluenceInfo(tile.x, tile.y).getPlayerInfluence(0);
      if (value < farthest) farthest = value;
    }
    expect(farthest).toBeLessThan(here);
  });
});
