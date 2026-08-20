import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { threatenedTiles } from '../src/game/threat.ts';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { cwRoot } from '../src/cw/resources.node.ts';

const { registry, createMap } = bootstrap();

function mapWith(unitID: string, x: number, y: number) {
  const map = createMap(11, 11, 'PLAINS');
  map.addPlayer('os');
  map.addPlayer('bm');
  const unit = map.addUnit(unitID, map.getPlayer(0)!, x, y);
  return { map, unit };
}

const has = (tiles: Array<{ x: number; y: number }>, x: number, y: number) =>
  tiles.some(tile => tile.x === x && tile.y === y);

describe('threatenedTiles', () => {
  it('covers everywhere a direct unit could move and then shoot', () => {
    // An infantry moves 3 and strikes at range 1, so it threatens four tiles
    // out along an axis: three of movement plus one of reach.
    const { map, unit } = mapWith('INFANTRY', 5, 5);
    const tiles = threatenedTiles(map, unit);

    expect(unit.canMoveAndFire()).toBe(true);
    expect(has(tiles, 5, 1)).toBe(true);         // 3 moved + 1 reach
    expect(has(tiles, 5, 0)).toBe(false);        // one tile too far
    expect(has(tiles, 8, 5)).toBe(true);
  });

  it('marks which tiles need no movement first', () => {
    const { map, unit } = mapWith('INFANTRY', 5, 5);
    const tiles = threatenedTiles(map, unit);
    const immediate = tiles.filter(tile => tile.fromHere);

    // Adjacent only: that is all it reaches without moving.
    expect(immediate).toHaveLength(4);
    expect(immediate.every(tile => Math.abs(tile.x - 5) + Math.abs(tile.y - 5) === 1)).toBe(true);
  });

  it('pins an indirect unit to the ring around where it stands', () => {
    // Artillery cannot move and fire, so its reach never grows by moving —
    // treating range as movement-plus-weapon would badly overstate it.
    const { map, unit } = mapWith('ARTILLERY', 5, 5);
    const tiles = threatenedTiles(map, unit);

    expect(unit.canMoveAndFire()).toBe(false);
    expect(tiles.every(tile => tile.fromHere)).toBe(true);
    const distances = new Set(tiles.map(t => Math.abs(t.x - 5) + Math.abs(t.y - 5)));
    expect([...distances].sort()).toEqual([2, 3]);   // min range 2, max 3
  });

  it('excludes the minimum-range blind spot an indirect cannot cover', () => {
    const { map, unit } = mapWith('ARTILLERY', 5, 5);
    const tiles = threatenedTiles(map, unit);
    expect(has(tiles, 5, 5)).toBe(false);
    expect(has(tiles, 5, 4)).toBe(false);            // adjacent: inside min range
    expect(has(tiles, 5, 3)).toBe(true);
  });

  it('lets terrain cut the reach down', () => {
    // On a real board an infantry cannot walk across water, so its danger zone
    // is smaller than the diamond that movement plus range would allow. Using
    // raw distance instead of the movement range would overstate every unit
    // hemmed in by terrain.
    const source = readMap(fs.readFileSync(path.join(cwRoot(), 'maps/pre_deployed/8-Bridge Isles.map')));
    const map = loadIntoGameMap(source, registry);
    const infantry = map.units.find(u => u.getUnitID() === 'INFANTRY')!;
    const span = infantry.getMovementpoints() + infantry.getMaxRange();

    const tiles = threatenedTiles(map, infantry);
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      const distance = Math.abs(tile.x - infantry.x) + Math.abs(tile.y - infantry.y);
      expect(distance).toBeLessThanOrEqual(span);
    }

    // The unobstructed diamond of that radius, for comparison.
    let diamond = 0;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (Math.abs(x - infantry.x) + Math.abs(y - infantry.y) <= span) diamond++;
      }
    }
    expect(tiles.length).toBeLessThan(diamond);
  });

  it('stays on the board', () => {
    const { map, unit } = mapWith('INFANTRY', 0, 0);
    const tiles = threatenedTiles(map, unit);
    expect(tiles.every(t => t.x >= 0 && t.y >= 0 && t.x < map.width && t.y < map.height)).toBe(true);
  });

  it('gives an unarmed unit nothing to show', () => {
    // An APC carries no weapon, but its script still declares range 1 like
    // every other unit — going by range alone would paint a transport as a
    // threat to everything around it.
    const { map, unit } = mapWith('APC', 5, 5);
    expect(unit.getMaxRange()).toBe(1);
    expect(unit.hasWeapons()).toBe(false);
    expect(threatenedTiles(map, unit)).toEqual([]);
  });

  it('drops a unit that has run out of ammunition', () => {
    const { map, unit } = mapWith('ARTILLERY', 5, 5);
    expect(threatenedTiles(map, unit).length).toBeGreaterThan(0);
    unit.setAmmo1(0);
    expect(threatenedTiles(map, unit)).toEqual([]);
  });
});
