import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { GameMap, type QPoint } from '../src/host/index.ts';

const { registry } = bootstrap();

/** Points as "x,y" strings so set comparisons read clearly in failures. */
function keys(points: { size(): number; at(i: number): QPoint }): string[] {
  const out: string[] = [];
  for (let i = 0; i < points.size(); i++) out.push(`${points.at(i).x},${points.at(i).y}`);
  return out;
}

describe('TerrainFindingSystem', () => {
  // 5x4 board: a plasma "L" plus a diagonal straggler and a far-off tile.
  //   P P . . .
  //   . P . P .   <- (3,1) touches (2,1)? no: only diagonally adjacent to (1,1)
  //   . P . . P
  //   . . . . .
  function plasmaBoard(): GameMap {
    const map = new GameMap(5, 4, 'PLAINS', registry);
    for (const [x, y] of [[0, 0], [1, 0], [1, 1], [1, 2], [3, 1], [4, 2]]) {
      map.setTerrainID(x, y, 'PLASMA');
    }
    return map;
  }

  it('collects exactly the 4-connected component of matching tiles', () => {
    const map = plasmaBoard();
    const points = map.getTerrain(1, 1).createTerrainFindingSystem().getAllQmlVectorPoints();
    // (3,1) and (4,2) touch the component only diagonally or not at all —
    // the C++ search expands over direct neighbours only (pathfindingsystem.cpp).
    expect(keys(points).sort()).toEqual(['0,0', '1,0', '1,1', '1,2'].sort());
  });

  it('emits points x-major, y-minor, like the C++ getAllQmlVectorPoints', () => {
    const map = plasmaBoard();
    const points = map.getTerrain(1, 1).createTerrainFindingSystem().getAllQmlVectorPoints();
    expect(keys(points)).toEqual(['0,0', '1,0', '1,1', '1,2']);
  });

  it('always includes the start tile, even with no matching neighbour', () => {
    const map = new GameMap(3, 3, 'PLAINS', registry);
    map.setTerrainID(1, 1, 'METEOR');
    const points = map.getTerrain(1, 1).createTerrainFindingSystem().getAllQmlVectorPoints();
    expect(keys(points)).toEqual(['1,1']);
  });

  it('stops at the map border without wrapping', () => {
    const map = new GameMap(2, 2, 'PLASMA', registry);
    const points = map.getTerrain(0, 0).createTerrainFindingSystem().getAllQmlVectorPoints();
    expect(keys(points)).toEqual(['0,0', '0,1', '1,0', '1,1']);
  });

  it('exposes the lifetime hook the C++ API requires callers to use', () => {
    const map = plasmaBoard();
    const pfs = map.getTerrain(1, 1).createTerrainFindingSystem();
    expect(() => pfs.killTerrainFindingSystem()).not.toThrow();
  });
});

describe('METEOR.onDestroyed on a real map', () => {
  function loadReal(name: string): GameMap {
    const source = readMap(fs.readFileSync(path.join(cwRoot(), name)));
    return loadIntoGameMap(source, registry);
  }

  function tilesWithID(map: GameMap, id: string): QPoint[] {
    const found: QPoint[] = [];
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (map.getTerrain(x, y).getTerrainID() === id) found.push({ x, y });
      }
    }
    return found;
  }

  it('melts every plasma web on D-Island once both meteors die', () => {
    const map = loadReal('maps/2_player/D-Island.map');
    expect(tilesWithID(map, 'METEOR').length).toBe(2);
    expect(tilesWithID(map, 'PLASMA').length).toBeGreaterThan(0);

    // Call straight through the registry: unlike terrain.onDestroyed and the
    // animation queue, nothing here swallows a throw, so the 84-occurrence
    // "createTerrainFindingSystem is not a function" failure fails this test.
    for (const meteor of tilesWithID(map, 'METEOR')) {
      registry.METEOR.onDestroyed(map.getTerrain(meteor.x, meteor.y), map);
    }

    expect(tilesWithID(map, 'METEOR')).toEqual([]);
    expect(tilesWithID(map, 'PLASMA')).toEqual([]);
  });

  it('handles Equal Island, whose meteors have no plasma web at all', () => {
    const map = loadReal('maps/2_player/Equal Island.map');
    const meteors = tilesWithID(map, 'METEOR');
    expect(meteors.length).toBe(2);
    expect(tilesWithID(map, 'PLASMA')).toEqual([]);

    for (const meteor of meteors) {
      registry.METEOR.onDestroyed(map.getTerrain(meteor.x, meteor.y), map);
    }
    expect(tilesWithID(map, 'METEOR')).toEqual([]);
  });
});
