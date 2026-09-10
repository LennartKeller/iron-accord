import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { IslandMap } from '../src/ai/cw/islandmap.ts';

const { createMap } = bootstrap();

describe('IslandMap matches upstream directional sweeps', () => {
  it('relabels earlier reachable regions when a later hovercraft seed can enter them', () => {
    const map = createMap(5, 5, 'SEA');
    const player = map.addPlayer('os');
    const terrain = { P: 'PLAINS', S: 'SEA', B: 'BEACH' };
    const rows = ['PSSSB', 'SSSSS', 'SSBPS', 'PPSSS', 'BBSBS'];
    for (let y = 0; y < rows.length; y++) {
      for (let x = 0; x < rows[y].length; x++) {
        map.setTerrainID(x, y, terrain[rows[y][x] as keyof typeof terrain]);
      }
    }
    // ai/islandmap.cpp:59-67 starts a fresh unbounded sweep at each unassigned
    // passable seed and overwrites every tile it reaches. The sea sweep cannot
    // enter the isolated beach at (4,0), but its later beach sweep can enter sea.
    const islands = new IslandMap(map, 'HOVERCRAFT', player);
    const labels = Array.from({ length: 5 }, (_, y) =>
      Array.from({ length: 5 }, (_, x) => islands.getIsland(x, y)));
    expect(labels).toEqual([
      [0, 2, 2, 2, 2],
      [2, 2, 2, 2, 2],
      [2, 2, 2, 2, 2],
      [2, 2, 2, 2, 2],
      [2, 2, 2, 2, 2],
    ]);
    expect(islands.sameIsland(4, 0, 3, 0)).toBe(true);
    expect(islands.getIslandSize(1)).toBe(0);
    expect(islands.getIslandSize(2)).toBe(24);
  });

  it('keeps symmetric land components separated and numbered by column-major seeds', () => {
    const map = createMap(5, 2, 'PLAINS');
    const player = map.addPlayer('os');
    for (let y = 0; y < map.height; y++) map.setTerrainID(2, y, 'SEA');
    const islands = new IslandMap(map, 'INFANTRY', player);
    expect(Array.from({ length: 5 }, (_, x) => islands.getIsland(x, 0)))
      .toEqual([0, 0, -1, 1, 1]);
    expect(islands.getIslandSize(0)).toBe(4);
    expect(islands.getIslandSize(1)).toBe(4);
    expect(islands.sameIsland(1, 0, 3, 0)).toBe(false);
  });
});
