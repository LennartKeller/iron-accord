/**
 * Builds everything the web client needs from the Commander Wars submodule:
 *
 *   data/scenes/<id>.json   render-ready maps with sprite ids resolved
 *   data/scenes/index.json  map picker listing
 *   data/sprites/<id>.png   only the sprites those maps actually use
 *   data/sprites/index.json sprite manifest
 *   data/colortables/*.png  player recolouring tables
 *
 * Sprite ids come from running Commander Wars' own terrain, building and unit
 * scripts, so autotiling matches the desktop client without reimplementing it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import {
  loadIntoGameMap, resolveTerrainSprites, resolveBuildingSprites, resolveUnitSprites,
} from '../src/maps/loadmap.ts';
import { unitIds as listUnitIds } from '../src/game/bootstrap.node.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { buildSpriteIndex, asSpriteIndex } from '../src/cw/sprites.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { colorTableFor, toHex, KNOWN_TABLES } from '../src/cw/colortables.ts';
import { assetFileName } from '../src/cw/assetname.ts';
import { collectScripts } from '../src/cw/resources.node.ts';
import { repairShorthand } from '../src/scripts/repair.ts';
import { NodeEvaluator } from '../src/scripts/evaluator-node.ts';
import type { Scene, SceneSpriteRef } from '../src/maps/scene.ts';
import type { Terrain } from '../src/host/index.ts';

const outRoot = path.resolve('data');
const scenesDir = path.join(outRoot, 'scenes');
const spritesDir = path.join(outRoot, 'sprites');
const tablesDir = path.join(outRoot, 'colortables');
for (const dir of [scenesDir, spritesDir, tablesDir]) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

const { registry } = bootstrap();
const spriteIndex = buildSpriteIndex();
const spriteLookup = asSpriteIndex(spriteIndex);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith('.map')) acc.push(full);
  }
  return acc;
}

const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const usedSprites = new Set<string>();
const missingSprites = new Map<string, number>();

/** Per-scene palettes, rebuilt for each map. */
class Palette {
  private readonly ids: string[] = [];
  private readonly lookup = new Map<string, number>();
  intern(id: string): number {
    const existing = this.lookup.get(id);
    if (existing !== undefined) return existing;
    const index = this.ids.length;
    this.ids.push(id);
    this.lookup.set(id, index);
    return index;
  }
  values(): string[] { return this.ids; }
}

let spritePalette = new Palette();
let terrainPalette = new Palette();
let tablePalette = new Palette();
let playerTables: string[] = [];

const usedTables = new Set<string>();

/**
 * Keeps only sprites we can draw, and works out which colour table recolours
 * each layer.
 *
 * game/terrain.cpp applies the terrain's biome palette to its sprites, while
 * unit and building "+mask" layers go through the owning player's colour table.
 */
function toSceneSprites(
  requests: Array<{ id: string; palette?: string }>,
  owner: number,
): SceneSpriteRef[] {
  const out: SceneSpriteRef[] = [];
  for (const request of requests) {
    if (!spriteIndex.has(request.id)) {
      missingSprites.set(request.id, (missingSprites.get(request.id) ?? 0) + 1);
      continue;
    }
    usedSprites.add(request.id);

    let table = '';
    if (owner >= 0 && request.id.endsWith('+mask')) table = playerTables[owner] ?? '';
    else if (request.palette && spriteIndex.has(request.palette)) table = request.palette;

    if (table) usedTables.add(table);
    out.push([spritePalette.intern(request.id), table ? tablePalette.intern(table) : -1]);
  }
  return out;
}

function collectRequests(terrain: Terrain): Array<{ id: string; palette: string }> {
  return [...(terrain.baseTerrain ? collectRequests(terrain.baseTerrain) : []), ...terrain.sprites];
}

const files = walk(path.join(cwRoot(), 'maps'));
const index: Array<Record<string, unknown>> = [];
const usedIds = new Set<string>();
let failures = 0;

for (const file of files) {
  const relative = path.relative(path.join(cwRoot(), 'maps'), file);
  const category = path.dirname(relative).split(path.sep)[0] ?? 'misc';
  try {
    const source = readMap(fs.readFileSync(file));
    const map = loadIntoGameMap(source, registry, spriteLookup);
    resolveTerrainSprites(map, registry);
    resolveBuildingSprites(map, registry);
    resolveUnitSprites(map, registry);

    let id = slug(`${category}-${source.header.mapName || path.basename(file, '.map')}`);
    let suffix = 2;
    while (usedIds.has(id)) id = `${id}-${suffix++}`;
    usedIds.add(id);

    spritePalette = new Palette();
    terrainPalette = new Palette();
    tablePalette = new Palette();
    playerTables = source.players.map(p => colorTableFor(p.color));

    const terrainGrid: number[][] = [];
    const tileSprites: SceneSpriteRef[][] = [];
    for (let y = 0; y < map.height; y++) {
      const row: number[] = [];
      for (let x = 0; x < map.width; x++) {
        const terrain = map.getTerrain(x, y);
        row.push(terrainPalette.intern(terrain.terrainID));
        tileSprites.push(toSceneSprites(collectRequests(terrain), -1));
      }
      terrainGrid.push(row);
    }

    const buildings: Scene['buildings'] = [];
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const building = map.getTerrain(x, y).getBuilding();
        if (!building) continue;
        const owner = building.getOwnerID();
        buildings.push({
          x, y, id: building.getBuildingID(), owner,
          sprites: toSceneSprites(building.sprites, owner),
        });
      }
    }

    const units: Scene['units'] = map.units.map(unit => ({
      x: unit.x, y: unit.y, id: unit.getUnitID(), owner: unit.getOwner().getPlayerID(),
      hp: unit.getHp(), sprites: toSceneSprites(unit.sprites, unit.getOwner().getPlayerID()),
    }));

    const scene: Scene = {
      id,
      name: source.header.mapName || path.basename(file, '.map'),
      author: source.header.mapAuthor,
      description: source.header.mapDescription,
      width: map.width,
      height: map.height,
      category,
      // Teams come from the loaded map, not the file: loadIntoGameMap applies the
      // same index-default that Commander Wars applies when a game starts.
      players: source.players.map((p, i) => ({
        army: p.army,
        team: map.getPlayer(i)?.team ?? i,
        funds: Math.max(0, p.funds),
        color: toHex(p.color),
        colorTable: colorTableFor(p.color),
      })),
      spriteIds: spritePalette.values(),
      terrainIds: terrainPalette.values(),
      tables: tablePalette.values(),
      terrain: terrainGrid,
      tileSprites,
      buildings, units,
    };

    fs.writeFileSync(path.join(scenesDir, `${id}.json`), JSON.stringify(scene));
    index.push({
      id, name: scene.name, author: scene.author, width: scene.width,
      height: scene.height, playerCount: scene.players.length, category,
    });
  } catch (err) {
    failures++;
    console.error(`FAILED ${relative}: ${(err as Error).message}`);
  }
}

index.sort((a, b) => String(a.id).localeCompare(String(b.id)));
fs.writeFileSync(path.join(scenesDir, 'index.json'), JSON.stringify(index));

// --- sprites for units and buildings that are not on any map yet ----------
//
// Scenes only carry their *starting* units, so shipping just what they
// reference leaves anything built during a game with no artwork. Any unit can
// be produced by any army, and any building can change hands, so resolve the
// whole roster against every army and ship what actually exists.
{
  const rosterMap = loadIntoGameMap(readMap(fs.readFileSync(files[0])), registry, spriteLookup);
  const player = rosterMap.getPlayer(0);
  const armies = ['OS', 'BM', 'GE', 'YC', 'BH', 'BG', 'MA', 'AC', 'BD', 'DM', 'GS', 'PF', 'TI'];
  let added = 0;

  if (player) {
    for (const army of armies) {
      player.setArmy(army);

      for (const unitID of listUnitIds(registry)) {
        const unit = rosterMap.addUnit(unitID, player, 0, 0);
        resolveUnitSprites(rosterMap, registry);
        for (const sprite of unit.sprites) {
          if (spriteIndex.has(sprite.id) && !usedSprites.has(sprite.id)) {
            usedSprites.add(sprite.id);
            added++;
          }
        }
        rosterMap.removeUnit(unit);
      }

      // Buildings change owner on capture, so their owned variants matter too.
      for (let y = 0; y < rosterMap.height; y++) {
        for (let x = 0; x < rosterMap.width; x++) {
          const building = rosterMap.getTerrain(x, y).getBuilding();
          if (!building) continue;
          building.setOwner(player);
        }
      }
      resolveBuildingSprites(rosterMap, registry);
      for (let y = 0; y < rosterMap.height; y++) {
        for (let x = 0; x < rosterMap.width; x++) {
          const building = rosterMap.getTerrain(x, y).getBuilding();
          if (!building) continue;
          for (const sprite of building.sprites) {
            if (spriteIndex.has(sprite.id) && !usedSprites.has(sprite.id)) {
              usedSprites.add(sprite.id);
              added++;
            }
          }
        }
      }
    }
  }
  console.log(`roster sprites added beyond what the maps reference: ${added}`);
}

// --- status badge icons ---------------------------------------------------
// These are never requested by a loadSprites() call — the engine draws them
// itself — so they have to be listed explicitly.
{
  const badgeIcons = [
    '1', '2', '3', '4', '5', '6', '7', '8', '9',
    'fuel', 'ammo', 'ammo1', 'capture', 'transport', 'hp+hidden', 'dive',
  ];
  let added = 0;
  for (const id of badgeIcons) {
    if (spriteIndex.has(id) && !usedSprites.has(id)) { usedSprites.add(id); added++; }
  }
  console.log(`status badge icons added: ${added}`);
}

// --- copy only the sprites those scenes reference -------------------------
let spriteBytes = 0;
/** sprite id -> [cols, rows] frame grid. */
const manifest: Record<string, [number, number]> = {};
for (const id of [...usedSprites].sort()) {
  const entry = spriteIndex.get(id)!;
  const source = entry.file;
  const target = path.join(spritesDir, `${assetFileName(id)}.png`);
  fs.copyFileSync(source, target);
  spriteBytes += fs.statSync(target).size;
  manifest[id] = [entry.cols, entry.rows];
}
fs.writeFileSync(path.join(spritesDir, 'index.json'), JSON.stringify(manifest));

// --- colour tables: player tables and terrain biome palettes ---------------
let tableBytes = 0;
let tableCount = 0;
for (const name of [...new Set([...usedTables, ...KNOWN_TABLES])].sort()) {
  // Player colour tables live outside the res.xml manifests, so fall back to
  // their well-known directory.
  const source = spriteIndex.get(name)?.file
    ?? path.join(cwRoot(), 'resources/images/colortables', `${name}.png`);
  if (!fs.existsSync(source)) { console.error(`missing colour table: ${name}`); continue; }
  const target = path.join(tablesDir, `${assetFileName(name)}.png`);
  fs.copyFileSync(source, target);
  tableBytes += fs.statSync(target).size;
  tableCount++;
}

// --- the Commander Wars scripts, for the browser ---------------------------
// Shipped pre-repaired (the six CoverInitializedName files) and in load order,
// so the client evaluates them without needing a parser of its own.
const scriptBundle = { order: [] as string[], sources: {} as Record<string, string> };
for (const script of collectScripts()) {
  const { source } = repairShorthand(script.source, script.path, NodeEvaluator.parse);
  scriptBundle.order.push(script.path);
  scriptBundle.sources[script.path] = source;
}
const scriptsFile = path.join(outRoot, 'scripts.json');
fs.writeFileSync(scriptsFile, JSON.stringify(scriptBundle));
const scriptBytes = fs.statSync(scriptsFile).size;

fs.writeFileSync(
  path.join(tablesDir, 'index.json'),
  JSON.stringify(fs.readdirSync(tablesDir).filter(f => f.endsWith('.png')).map(f => f.replace(/\.png$/, ''))),
);

const sceneBytes = fs.readdirSync(scenesDir).reduce((n, f) => n + fs.statSync(path.join(scenesDir, f)).size, 0);
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;
console.log(`scenes      : ${index.length}/${files.length}  ${mb(sceneBytes)}`);
console.log(`sprites     : ${usedSprites.size} files  ${mb(spriteBytes)}`);
console.log(`colortables : ${tableCount} files  ${mb(tableBytes)}`);
console.log(`scripts     : ${scriptBundle.order.length} files  ${mb(scriptBytes)}`);
console.log(`total       : ${mb(sceneBytes + spriteBytes + tableBytes + scriptBytes)}`);
if (missingSprites.size) {
  const total = [...missingSprites.values()].reduce((a, b) => a + b, 0);
  console.log(`unavailable sprite ids: ${missingSprites.size} distinct, ${total} references (dropped)`);
}
if (failures) process.exitCode = 1;
