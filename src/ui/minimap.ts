import type { Scene } from '../maps/scene.ts';

/**
 * A map drawn one flat colour per tile: the overview in the corner of a big
 * board, and the thumbnails in the map browser. Both want the same answer to
 * "what does this map look like from far away", so they share it.
 */

/** Colour families for the terrain ids Commander Wars uses, matched by substring. */
const TERRAIN_COLOURS: Array<[RegExp, string]> = [
  [/SEA|REAF|REEF|FOG|LAKE/, '#2f7fd6'],
  [/RIVER|WATERFALL/, '#5aa7e8'],
  [/BEACH|DESERT(?!_FOREST)/, '#e3c878'],
  [/FOREST|JUNGLE/, '#2f8f45'],
  [/MOUNTAIN|ROCK|METEOR/, '#9a7b52'],
  [/STREET|BRIDGE|PATH|ROAD/, '#b9b9b0'],
  [/PIPE|WELD|WALL|PLASMA/, '#8a5cc2'],
  [/SNOW/, '#e8eef3'],
  [/WASTE|RUIN/, '#a59a6a'],
];
const PLAIN = '#8fca55';
const NEUTRAL_BUILDING = '#d8dee4';

const cache = new Map<string, string>();
export function terrainColour(id: string): string {
  let colour = cache.get(id);
  if (!colour) {
    const upper = id.toUpperCase();
    colour = TERRAIN_COLOURS.find(([pattern]) => pattern.test(upper))?.[1] ?? PLAIN;
    cache.set(id, colour);
  }
  return colour;
}

export interface OverviewMarks {
  /** Buildings as they stand now; defaults to the scene's own. */
  buildings?: Array<{ x: number; y: number; owner: number }>;
  /** Units to mark. Pass only what the viewer may see. */
  units?: Array<{ x: number; y: number; owner: number }>;
}

/**
 * Draws `scene` into the top-left of `ctx`, `cell` pixels per tile. Buildings
 * take their owner's colour, because who holds what is the first thing an
 * overview is read for.
 */
export function drawOverview(
  ctx: CanvasRenderingContext2D, scene: Scene, cell: number, marks: OverviewMarks = {},
): void {
  for (let y = 0; y < scene.height; y++) {
    const row = scene.terrain[y];
    for (let x = 0; x < scene.width; x++) {
      ctx.fillStyle = terrainColour(scene.terrainIds[row[x]] ?? '');
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  const seat = (owner: number) => scene.players[owner]?.color ?? NEUTRAL_BUILDING;
  for (const building of marks.buildings ?? scene.buildings) {
    ctx.fillStyle = building.owner >= 0 ? seat(building.owner) : NEUTRAL_BUILDING;
    ctx.fillRect(building.x * cell, building.y * cell, cell, cell);
  }
  for (const unit of marks.units ?? scene.units) {
    // A dark rim so a unit reads as a unit on a building of its own colour.
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(unit.x * cell, unit.y * cell, cell, cell);
    ctx.fillStyle = seat(unit.owner);
    const inset = Math.max(0.5, cell / 5);
    ctx.fillRect(unit.x * cell + inset, unit.y * cell + inset, cell - 2 * inset, cell - 2 * inset);
  }
}

/** The largest whole-ish cell size that fits a scene into a box. */
export function overviewCell(scene: Scene, maxWidth: number, maxHeight: number): number {
  return Math.max(1, Math.min(maxWidth / scene.width, maxHeight / scene.height));
}
