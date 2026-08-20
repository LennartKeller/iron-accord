/**
 * Converts Commander Wars' binary .map files into JSON for the web client.
 *
 * Running this offline means the browser never needs a QDataStream parser and
 * never ships the Qt-format quirks; it loads plain JSON.
 *
 *   node tools/convert-maps.ts [--out data/maps] [--pretty]
 */
import fs from 'node:fs';
import path from 'node:path';
import { readMap, type CommanderWarsMap } from '../src/maps/mapreader.ts';
import { cwRoot } from '../src/cw/resources.node.ts';

interface ConvertedMap {
  id: string;
  name: string;
  author: string;
  description: string;
  width: number;
  height: number;
  playerCount: number;
  category: string;
  players: Array<{ army: string; team: number; controlType: number; funds: number }>;
  /** Row-major terrain ids, height rows of width entries. */
  terrain: string[][];
  buildings: Array<{ x: number; y: number; id: string; owner: number }>;
  units: Array<{ x: number; y: number; id: string; owner: number; hp: number }>;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function convert(source: CommanderWarsMap, id: string, category: string): ConvertedMap {
  const terrain: string[][] = [];
  const buildings: ConvertedMap['buildings'] = [];
  const units: ConvertedMap['units'] = [];

  for (const row of source.tiles) {
    const terrainRow: string[] = [];
    for (const tile of row) {
      terrainRow.push(tile.terrainID);
      if (tile.building) {
        buildings.push({ x: tile.x, y: tile.y, id: tile.building.buildingID, owner: tile.building.playerID });
      }
      if (tile.unit) {
        units.push({ x: tile.x, y: tile.y, id: tile.unit.unitID, owner: tile.unit.playerID, hp: tile.unit.hp });
      }
    }
    terrain.push(terrainRow);
  }

  return {
    id,
    name: source.header.mapName,
    author: source.header.mapAuthor,
    description: source.header.mapDescription,
    width: source.header.width,
    height: source.header.height,
    playerCount: source.header.playerCount,
    category,
    players: source.players.map(p => ({
      army: p.army, team: p.team, controlType: p.controlType, funds: p.funds,
    })),
    terrain,
    buildings,
    units,
  };
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith('.map')) acc.push(full);
  }
  return acc;
}

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = path.resolve(outIndex >= 0 ? args[outIndex + 1] : 'data/maps');
const pretty = args.includes('--pretty');

const mapsRoot = path.join(cwRoot(), 'maps');
const files = walk(mapsRoot);
fs.mkdirSync(outDir, { recursive: true });

const index: Array<Pick<ConvertedMap, 'id' | 'name' | 'author' | 'width' | 'height' | 'playerCount' | 'category'>> = [];
const failures: string[] = [];
const usedIds = new Set<string>();

for (const file of files) {
  const relative = path.relative(mapsRoot, file);
  const category = path.dirname(relative).split(path.sep)[0] ?? 'misc';
  try {
    const source = readMap(fs.readFileSync(file));
    let id = slugify(`${category}-${source.header.mapName || path.basename(file, '.map')}`);
    let suffix = 2;
    while (usedIds.has(id)) id = `${id}-${suffix++}`;
    usedIds.add(id);

    const converted = convert(source, id, category);
    fs.writeFileSync(
      path.join(outDir, `${id}.json`),
      JSON.stringify(converted, null, pretty ? 2 : 0),
    );
    index.push({
      id, name: converted.name, author: converted.author, width: converted.width,
      height: converted.height, playerCount: converted.playerCount, category,
    });
  } catch (err) {
    failures.push(`${relative}: ${(err as Error).message}`);
  }
}

index.sort((a, b) => a.id.localeCompare(b.id));
fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, pretty ? 2 : 0));

const bytes = fs.readdirSync(outDir).reduce((sum, f) => sum + fs.statSync(path.join(outDir, f)).size, 0);
console.log(`converted ${index.length}/${files.length} maps -> ${path.relative(process.cwd(), outDir)}`);
console.log(`total size: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
if (failures.length) {
  console.log(`failures: ${failures.length}`);
  failures.slice(0, 10).forEach(f => console.log('   ' + f));
  process.exit(1);
}
