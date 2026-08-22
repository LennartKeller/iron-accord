import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
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

// bootstrap() loads every Commander Wars script, so share one registry across
// the live-map tests instead of paying for it per test.
let sharedRegistry: ReturnType<typeof bootstrap>['registry'] | null = null;

function loadLive(relativePath: string) {
  sharedRegistry ??= bootstrap().registry;
  return loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), relativePath))), sharedRegistry);
}

function unitAt(map: ReturnType<typeof loadLive>, x: number, y: number) {
  const unit = map.units.find(u => u.getX() === x && u.getY() === y);
  if (!unit) throw new Error(`no unit at (${x},${y})`);
  return unit;
}

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

  it('loads stored fuel but keeps script defaults for the -1 sentinel', () => {
    // hurricaneInTheHarbor stores fuel 99 on one PIPERUNNER while its
    // WATERMINEs store the -1 "untouched" sentinel, which must keep the
    // script-init default rather than being applied literally.
    sharedRegistry ??= bootstrap().registry;
    const file = path.join(cwRoot(), 'maps/commander_wars.camp/hurricaneInTheHarbor.map');
    const parsed = readMap(fs.readFileSync(file));
    const live = loadIntoGameMap(parsed, sharedRegistry);

    const lowFuel = unitAt(live, 9, 13);
    expect(lowFuel.getUnitID()).toBe('PIPERUNNER');
    expect(lowFuel.getFuel()).toBe(99);

    let sentinels = 0;
    for (const row of parsed.tiles) {
      for (const tile of row) {
        if (!tile.unit || tile.unit.fuel >= 0) continue;
        sentinels++;
        const unit = unitAt(live, tile.x, tile.y);
        expect(unit.getFuel()).toBe(unit.getMaxFuel());
      }
    }
    expect(sentinels).toBeGreaterThan(0);
  });

  it('loads a transport\'s cargo from the map file', () => {
    // Sacrificial Lamb pre-deploys four loaded LANDERs; losing the cargo
    // makes the scenario unwinnable.
    const live = loadLive('maps/advance_wars_day_of_ruin_campaign.camp/Sacrificial Lamb.map');
    const lander = unitAt(live, 3, 8);
    expect(lander.getUnitID()).toBe('LANDER');
    expect(lander.loaded.map(u => u.getUnitID())).toEqual(['ANTITANKCANNON', 'MECH']);
    // Cargo carries its own stored state...
    expect(lander.loaded[0].getHp()).toBe(10);
    expect(lander.loaded[0].getFuel()).toBe(50);
    expect(lander.loaded[0].getOwner()).toBe(lander.getOwner());
    // ...and is not on the board while carried: neither in the map roster nor
    // the owner's, exactly like a unit loaded through Unit.loadUnit.
    for (const cargo of lander.loaded) {
      expect(live.units).not.toContain(cargo);
      expect(cargo.getOwner().units).not.toContain(cargo);
    }
  });

  it('applies drained ammo and repairs the swapped-ammo quirk', () => {
    const live = loadLive('maps/advance_wars_1_campaign.camp/Air Ace.map');
    // The author drained this APC's flare ammo to zero.
    const apc = unitAt(live, 0, 9);
    expect(apc.getUnitID()).toBe('APC');
    expect(apc.getMaxAmmo1()).toBeGreaterThan(0);
    expect(apc.getAmmo1()).toBe(0);
    // This MECH was saved with its weapon slots swapped (ammo1=10, ammo2=3);
    // game/unit.cpp detects and swaps them back, and so do we.
    const mech = unitAt(live, 0, 8);
    expect(mech.getUnitID()).toBe('MECH');
    expect(mech.getAmmo1()).toBe(mech.getMaxAmmo1());
    expect(mech.getAmmo2()).toBe(mech.getMaxAmmo2());
  });

  it('applies stored hidden, hasMoved, capturePoints and rank', () => {
    // No bundled map stores these fields with non-default values (the only
    // hidden units are WATERMINEs, whose script init hides them anyway), so
    // override the parsed data before loading to prove the loader path.
    sharedRegistry ??= bootstrap().registry;
    const file = path.join(cwRoot(), 'maps/2_player/60-ZWEITER KRIEG.map');
    const parsed = readMap(fs.readFileSync(file));
    const stored = parsed.tiles[8][17].unit!;
    stored.hidden = true;
    stored.hasMoved = true;
    stored.capturePoints = 7;
    stored.rank = 2;
    const live = loadIntoGameMap(parsed, sharedRegistry);
    const unit = unitAt(live, 17, 8);
    expect(unit.getHidden()).toBe(true);
    expect(unit.getHasMoved()).toBe(true);
    expect(unit.getCapturePoints()).toBe(7);
    expect(unit.getUnitRank()).toBe(2);
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
