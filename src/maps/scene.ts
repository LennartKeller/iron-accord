/**
 * The render-ready form of a map: sprite ids resolved, ready to draw.
 * Produced offline by tools/build-data.ts, consumed by the renderer.
 *
 * Sprite ids and terrain ids repeat heavily across a grid, so both are stored
 * once in a per-scene palette and referenced by index. On the full map set that
 * is the difference between ~24 MB and ~2 MB of JSON.
 */

/**
 * Index into Scene.spriteIds, plus an index into Scene.tables naming the colour
 * table that recolours it (-1 for none). One mechanism covers both terrain biome
 * palettes and player colour tables — see SpriteStore.
 */
export type SceneSpriteRef = [spriteIndex: number, tableIndex: number];

export interface SceneBuilding {
  x: number;
  y: number;
  id: string;
  owner: number;
  sprites: SceneSpriteRef[];
}

export interface SceneUnit {
  x: number;
  y: number;
  id: string;
  owner: number;
  hp: number;
  sprites: SceneSpriteRef[];
}

export interface ScenePlayer {
  army: string;
  team: number;
  /** Starting funds the map author set; 0 for almost every bundled map. */
  funds: number;
  /** "#rrggbb" derived from the map's stored ARGB player colour. */
  color: string;
  /** Colour-table asset name, e.g. "orange_star". */
  colorTable: string;
}

export interface Scene {
  id: string;
  name: string;
  author: string;
  description: string;
  width: number;
  height: number;
  category: string;
  players: ScenePlayer[];

  /** Palette: every sprite id this scene draws. */
  spriteIds: string[];
  /** Palette: every terrain id on this scene's grid. */
  terrainIds: string[];
  /** Palette: every colour table asset this scene recolours through. */
  tables: string[];

  /** Row-major indices into terrainIds, height rows of width entries. */
  terrain: number[][];
  /**
   * Row-major sprite layers per tile, drawn in order.
   * Flattened as width*height entries, each an array of refs.
   */
  tileSprites: SceneSpriteRef[][];

  buildings: SceneBuilding[];
  units: SceneUnit[];
}

export const TILE_SIZE = 16;

/** Convenience accessor: the sprite layers for one tile. */
export function tileSpritesAt(scene: Scene, x: number, y: number): SceneSpriteRef[] {
  return scene.tileSprites[y * scene.width + x] ?? [];
}

export function terrainAt(scene: Scene, x: number, y: number): string {
  return scene.terrainIds[scene.terrain[y][x]];
}
