import { GameMap, Terrain, BuildingHost } from '../host/index.ts';
import type { ScriptRegistry } from '../scripts/types.ts';
import type { Scene } from '../maps/scene.ts';
import { FOG_MODES, type GameConfig } from '../game/config.ts';

/**
 * Builds a live host GameMap from a render-ready Scene.
 *
 * The client never sees the binary `.map`; the offline build already resolved
 * terrain, buildings, players and starting units, so this rehydrates those into
 * real host objects that the Commander Wars scripts can run against.
 *
 * Nested base terrain is intentionally not rebuilt — it only ever mattered for
 * sprite resolution, which is baked into the scene.
 */
export function gameMapFromScene(
  scene: Scene,
  registry: ScriptRegistry,
  config?: GameConfig,
): GameMap {
  const map = new GameMap(scene.width, scene.height, scene.terrainIds[0] ?? 'PLAINS', registry);

  if (config) {
    map.getGameRules().setFogMode(FOG_MODES[config.fog]);
    map.getGameRules().unitLimit = config.unitLimit;
  }

  scene.players.forEach((player, index) => {
    const seat = config?.seats[index];
    const created = map.addPlayer(seat?.army ?? player.army);
    created.team = seat?.team ?? player.team;
    created.color = player.color;
    // The map's authored funds are the baseline; config overrides them only when
    // the player actually set something.
    created.funds = config ? config.startingFunds : (player.funds ?? 0);
    created.fundsModifier = config?.fundsModifier ?? 1;
  });

  for (let y = 0; y < scene.height; y++) {
    for (let x = 0; x < scene.width; x++) {
      const terrainID = scene.terrainIds[scene.terrain[y][x]];
      const terrain = new Terrain(map, x, y, terrainID);
      try { registry[terrainID]?.init?.(terrain, map); } catch { /* optional */ }
      map.setTerrain(x, y, terrain);
    }
  }

  for (const building of scene.buildings) {
    const owner = building.owner >= 0 ? map.getPlayer(building.owner) ?? null : null;
    const host = new BuildingHost(map, building.id, owner);
    const terrain = map.getTerrain(building.x, building.y);
    host.setTerrain(terrain);
    terrain.building = host;
    host.init();
  }

  for (const unit of scene.units) {
    const owner = map.getPlayer(unit.owner);
    if (!owner) continue;
    const spawned = map.addUnit(unit.id, owner, unit.x, unit.y);
    spawned.setHp(unit.hp);
  }

  return map;
}
