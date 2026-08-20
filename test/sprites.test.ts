import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap, resolveTerrainSprites, resolveBuildingSprites, resolveUnitSprites } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { buildSpriteIndex, asSpriteIndex } from '../src/cw/sprites.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { assetFileName } from '../src/cw/assetname.ts';
import { unitIds } from '../src/game/bootstrap.node.ts';

const { registry } = bootstrap();
const spriteIndex = buildSpriteIndex();
const lookup = asSpriteIndex(spriteIndex);

function mapFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) mapFiles(full, acc);
    else if (entry.name.endsWith('.map')) acc.push(full);
  }
  return acc;
}

// A spread across categories keeps the suite quick but representative.
const sample = mapFiles(path.join(cwRoot(), 'maps')).filter((_, i) => i % 11 === 0);

describe('every buildable unit has artwork', () => {
  /**
   * A scene only carries its starting units, so shipping just what scenes
   * reference left anything produced during a game invisible — a built RECON
   * had no sprite at all. The asset build now resolves the whole roster against
   * every army, and this guards that.
   */
  it('resolves at least one shipped sprite for every unit and army', () => {
    const shippedPath = path.resolve('data/sprites/index.json');
    if (!fs.existsSync(shippedPath)) {
      // Requires `npm run build:data`; skip rather than fail a fresh checkout.
      return;
    }
    const shipped = new Set(Object.keys(JSON.parse(fs.readFileSync(shippedPath, 'utf8'))));
    const map = loadIntoGameMap(
      readMap(fs.readFileSync(path.join(cwRoot(), 'maps/2_player/60-ZWEITER KRIEG.map'))),
      registry, lookup);
    const player = map.getPlayer(0)!;

    const invisible: string[] = [];
    for (const army of ['OS', 'BM', 'GE', 'YC', 'BH']) {
      player.setArmy(army);
      for (const unitID of unitIds(registry)) {
        const unit = map.addUnit(unitID, player, 0, 0);
        resolveUnitSprites(map, registry);
        if (!unit.sprites.some(sprite => shipped.has(sprite.id))) {
          invisible.push(`${unitID}/${army}`);
        }
        map.removeUnit(unit);
      }
    }
    expect(invisible).toEqual([]);
  });

  it('re-resolves sprites rather than appending on repeat calls', () => {
    const map = loadIntoGameMap(
      readMap(fs.readFileSync(path.join(cwRoot(), 'maps/2_player/60-ZWEITER KRIEG.map'))),
      registry, lookup);
    const unit = map.addUnit('INFANTRY', map.getPlayer(0)!, 3, 8);
    resolveUnitSprites(map, registry);
    const first = unit.sprites.length;
    resolveUnitSprites(map, registry);
    expect(unit.sprites.length).toBe(first);
  });
});

describe('sprite resolution through the Commander Wars scripts', () => {
  it('reads frame grids from res.xml', () => {
    expect(spriteIndex.get('sea+mask')).toMatchObject({ cols: 8, rows: 1 });
    expect(spriteIndex.get('infantry+os+walk+mask')).toMatchObject({ cols: 4, rows: 4 });
    expect(spriteIndex.get('plains+17')).toMatchObject({ cols: 1, rows: 1 });
  });

  it('gives every tile at least one sprite, almost all of which exist', () => {
    let tiles = 0, empty = 0, requests = 0, missing = 0;
    for (const file of sample) {
      const map = loadIntoGameMap(readMap(fs.readFileSync(file)), registry, lookup);
      resolveTerrainSprites(map, registry);
      for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
          const terrain = map.getTerrain(x, y);
          const all = [...(terrain.baseTerrain?.sprites ?? []), ...terrain.sprites];
          tiles++;
          if (all.length === 0) empty++;
          for (const sprite of all) {
            requests++;
            if (!spriteIndex.has(sprite.id)) missing++;
          }
        }
      }
    }
    expect(tiles).toBeGreaterThan(10_000);
    expect(empty).toBe(0);
    // The few unavailable ids are biome variants with no artwork; Commander
    // Wars logs and skips them too.
    expect(missing / requests).toBeLessThan(0.005);
  });

  it('assigns a biome palette to terrain and a player table to unit masks', () => {
    const file = path.join(cwRoot(), 'maps/2_player/60-ZWEITER KRIEG.map');
    const map = loadIntoGameMap(readMap(fs.readFileSync(file)), registry, lookup);
    resolveTerrainSprites(map, registry);
    resolveUnitSprites(map, registry);
    resolveBuildingSprites(map, registry);

    const terrain = map.getTerrain(0, 0);
    expect(terrain.sprites.length).toBeGreaterThan(0);
    expect(terrain.sprites[0].palette).toMatch(/^palette_/);

    const unit = map.units[0];
    expect(unit.sprites.some(s => s.id.endsWith('+mask'))).toBe(true);
  });

  it('produces URL-safe asset names that round-trip to real files', () => {
    expect(assetFileName('sea+N+mask')).toBe('sea~2bN~2bmask');
    expect(assetFileName('plains+17')).toBe('plains~2b17');
    expect(assetFileName('factory')).toBe('factory');
    // No character that a static file server would reinterpret.
    for (const id of ['sea+mask', 'street+style1+E+S', 'palette_clear+awds']) {
      expect(assetFileName(id)).toMatch(/^[A-Za-z0-9._~-]+$/);
    }
  });
});
