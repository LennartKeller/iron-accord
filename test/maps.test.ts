import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';

function mapFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) mapFiles(full, acc);
    else if (entry.name.endsWith('.map')) acc.push(full);
  }
  return acc;
}

const files = mapFiles(path.join(cwRoot(), 'maps'));

describe('Commander Wars map reader', () => {
  it('finds the bundled maps', () => {
    expect(files.length).toBe(570);
  });

  it('parses every bundled map', () => {
    const failures: string[] = [];
    for (const file of files) {
      try { readMap(fs.readFileSync(file)); }
      catch (err) { failures.push(`${path.basename(file)}: ${(err as Error).message}`); }
    }
    expect(failures).toEqual([]);
  });

  it('produces a fully populated grid for every map', () => {
    for (const file of files) {
      const map = readMap(fs.readFileSync(file));
      expect(map.tiles).toHaveLength(map.header.height);
      for (const row of map.tiles) expect(row).toHaveLength(map.header.width);
      expect(map.players).toHaveLength(map.header.playerCount);
    }
  });

  /**
   * The strongest correctness signal available without running the C++: a
   * desynced stream yields garbage ids. Every id in every map resolving to a
   * real script means the field layout is right.
   */
  it('yields only ids that exist as Commander Wars scripts', () => {
    const { registry } = bootstrap();
    const known = new Set(Object.keys(registry).filter(k => /^[A-Z_][A-Z0-9_]*$/.test(k)));
    const unknown = new Set<string>();

    for (const file of files) {
      const map = readMap(fs.readFileSync(file));
      for (const row of map.tiles) {
        for (const tile of row) {
          if (!known.has(tile.terrainID)) unknown.add(`terrain:${tile.terrainID}`);
          if (tile.baseTerrain && !known.has(tile.baseTerrain.terrainID)) {
            unknown.add(`terrain:${tile.baseTerrain.terrainID}`);
          }
          if (tile.building && !known.has(tile.building.buildingID)) {
            unknown.add(`building:${tile.building.buildingID}`);
          }
          if (tile.unit) {
            if (!known.has(tile.unit.unitID)) unknown.add(`unit:${tile.unit.unitID}`);
            for (const carried of tile.unit.transported) {
              if (!known.has(carried.unitID)) unknown.add(`unit:${carried.unitID}`);
            }
          }
        }
      }
    }
    expect([...unknown]).toEqual([]);
  });

  it('reads a known map exactly', () => {
    const file = path.join(cwRoot(), 'maps/2_player/60-ZWEITER KRIEG.map');
    const map = readMap(fs.readFileSync(file));
    expect(map.header.mapName).toBe('60-Zweiter Krieg');
    expect(map.header.mapAuthor).toBe('Fairy');
    expect(map.header.width).toBe(19);
    expect(map.header.height).toBe(12);
    expect(map.header.playerCount).toBe(2);
    expect(map.players[0].army).toBe('OS');
    expect(map.tiles[0][0].terrainID).toBeTruthy();
  });
});
