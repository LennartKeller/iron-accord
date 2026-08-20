import type { CommanderWarsMap, MapTile } from './mapreader.ts';
import type { ScriptRegistry } from '../scripts/types.ts';
import { GameMap, Terrain, BuildingHost, type SpriteIndex } from '../host/index.ts';

/**
 * Turns a parsed .map into a live host GameMap so the Commander Wars terrain
 * scripts can run against it — which is how we get authentic autotiled sprite
 * ids without reimplementing the autotiling rules.
 */
/**
 * Index into TERRAIN.paletteTable (resources/scripts/general/terrain.js).
 *
 * game/gamerules.h defaults m_mapPalette to 0 ("Default"), which falls back to
 * each terrain's own getDefaultPalette(). That combination renders sea purple,
 * so real maps evidently set a style in their GameRules block — which lives in
 * the part of the .map we do not parse yet. "Clear AW DS" is Commander Wars'
 * standard look and is what we assume until GameRules parsing lands.
 */
export const DEFAULT_MAP_PALETTE_GROUP = 9;

export function loadIntoGameMap(
  source: CommanderWarsMap,
  registry: ScriptRegistry,
  spriteIndex: SpriteIndex | null = null,
  mapPaletteGroup: number = DEFAULT_MAP_PALETTE_GROUP,
): GameMap {
  const map = new GameMap(source.header.width, source.header.height, 'PLAINS', registry);
  map.spriteIndex = spriteIndex;

  // game/gamemap.cpp:2996 and objects/playerselection.cpp:428 both do
  // `getPlayer(i)->setTeam(i)` when a game starts, because Player::m_team
  // defaults to 0 and most maps never write it. Without this every player reads
  // as an ally of every other (Player::checkAlliance compares teams only), so
  // enemies stop blocking movement and nothing can be attacked.
  const storedTeams = source.players.map(p => p.team);
  const teamsAreMeaningful = new Set(storedTeams).size > 1;

  source.players.forEach((sourcePlayer, index) => {
    const player = map.addPlayer(sourcePlayer.army);
    player.team = teamsAreMeaningful ? sourcePlayer.team : index;
    player.funds = sourcePlayer.funds;
    player.isDefeated = sourcePlayer.isDefeated;
  });

  const buildTerrain = (tile: MapTile, x: number, y: number): Terrain => {
    const terrain = new Terrain(map, x, y, tile.terrainID);
    terrain.palette = tile.palette;
    terrain.hp = tile.hp;
    if (tile.baseTerrain) terrain.baseTerrain = buildTerrain(tile.baseTerrain, x, y);
    // Terrain::init() is where a script assigns its default biome palette when
    // the map did not store one; without it, mask sprites have nothing to
    // recolour through and render as raw palette indices.
    try { registry[tile.terrainID]?.init?.(terrain, map); } catch { /* optional */ }
    applyPaletteGroup(terrain, registry, mapPaletteGroup);
    return terrain;
  };

  for (let y = 0; y < source.header.height; y++) {
    for (let x = 0; x < source.header.width; x++) {
      const tile = source.tiles[y][x];
      const terrain = buildTerrain(tile, x, y);

      if (tile.building) {
        const owner = tile.building.playerID >= 0 ? map.getPlayer(tile.building.playerID) ?? null : null;
        const building = new BuildingHost(map, tile.building.buildingID, owner);
        building.setTerrain(terrain);
        terrain.building = building;
        // Building::init is where a script sets starting HP, visibility and
        // firing cooldown; the stored values then override it where present.
        building.init();
        if (tile.building.hp > 0) building.hp = tile.building.hp;
        building.fireCount = tile.building.fireCount;
      }
      map.setTerrain(x, y, terrain);
    }
  }

  for (let y = 0; y < source.header.height; y++) {
    for (let x = 0; x < source.header.width; x++) {
      const tile = source.tiles[y][x];
      if (!tile.unit) continue;
      const owner = map.getPlayer(tile.unit.playerID);
      if (!owner) continue;
      const unit = map.addUnit(tile.unit.unitID, owner, x, y);
      unit.setHp(tile.unit.hp);
    }
  }

  return map;
}

/**
 * Runs each terrain script's loadBaseSprite/loadOverlaySprite so every tile
 * records the sprite ids the desktop client would draw.
 *
 * game/terrain.cpp calls these with exactly two arguments (the terrain and the
 * map), so we do the same — several scripts declare a third parameter that is
 * always undefined in the real engine too.
 */
export function resolveTerrainSprites(map: GameMap, registry: ScriptRegistry): void {
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      resolveTile(map.getTerrain(x, y), registry, map);
    }
  }
}

/**
 * game/terrain.cpp: Terrain::setTerrainPaletteGroup — picks the biome palette
 * for this terrain from TERRAIN.paletteTable, falling back to the terrain's own
 * default when the table entry is blank.
 */
function applyPaletteGroup(terrain: Terrain, registry: ScriptRegistry, group: number): void {
  if (terrain.baseTerrain) applyPaletteGroup(terrain.baseTerrain, registry, group);
  const script = registry[terrain.terrainID];
  const terrainGroup = Number(script?.getTerrainGroup?.() ?? 0);
  let palette = '';
  try { palette = registry.TERRAIN?.getPaletteId?.(group, terrainGroup) ?? ''; } catch { /* optional */ }
  if (!palette) {
    try { palette = script?.getDefaultPalette?.() ?? ''; } catch { /* optional */ }
  }
  if (palette) terrain.palette = palette;
}

/**
 * Runs each building script's loadSprites(building, neutral, map).
 *
 * Safe to call again after a capture: a building's sprites depend on its owner,
 * so they are cleared and re-resolved rather than appended to.
 */
export function resolveBuildingSprites(map: GameMap, registry: ScriptRegistry): void {
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const building = map.getTerrain(x, y).getBuilding();
      if (!building) continue;
      building.sprites.length = 0;
      const script = registry[building.getBuildingID()];
      const neutral = building.getOwnerID() < 0;
      try { script?.loadSprites?.(building, neutral, map); } catch { /* needs an API we lack */ }
    }
  }
}

/**
 * Runs each unit script's loadSprites(unit, map).
 *
 * Safe to call again: sprites depend on the owning player's army, so they are
 * cleared and re-resolved rather than appended to.
 */
export function resolveUnitSprites(map: GameMap, registry: ScriptRegistry): void {
  for (const unit of map.units) {
    unit.sprites.length = 0;
    const script = registry[unit.getUnitID()];
    try { script?.loadSprites?.(unit, map); } catch { /* needs an API we lack */ }
  }
}

function resolveTile(terrain: Terrain, registry: ScriptRegistry, map: GameMap): void {
  if (terrain.baseTerrain) resolveTile(terrain.baseTerrain, registry, map);
  const script = registry[terrain.terrainID];
  if (!script) return;
  try { script.loadBaseSprite?.(terrain, map); } catch { /* script needs an API we lack */ }
  try { script.loadOverlaySprite?.(terrain, map); } catch { /* ditto */ }
}
