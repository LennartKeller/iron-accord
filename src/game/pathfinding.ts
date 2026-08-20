import type { GameMap, Unit } from '../host/index.ts';

/**
 * Movement range and routing for a single unit.
 *
 * Ported from game/unitpathfindingsystem.cpp. The cost of entering a tile comes
 * from the unit's movement-table script (a negative cost means impassable), the
 * budget is the unit's movement points (already capped by fuel in
 * Unit::getMovementpoints), and enemies block movement entirely.
 */

export interface ReachableTile {
  x: number;
  y: number;
  /** Total movement points spent getting here. */
  cost: number;
  /** True when the unit may finish its move here — the tile must be empty. */
  canStop: boolean;
  /**
   * True when the tile is a legal *action* target, which includes tiles held by
   * an allied unit: that is how loading onto a transport and joining a damaged
   * unit work. Plain moves still require `canStop`.
   */
  canAct: boolean;
}

export interface MovementRange {
  /** Keyed by `${x},${y}`. Includes the unit's own tile at cost 0. */
  tiles: Map<string, ReachableTile>;
  /** Predecessor per tile, for path reconstruction. */
  from: Map<string, string>;
}

export const key = (x: number, y: number): string => `${x},${y}`;

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], [1, 0], [0, 1], [-1, 0],
];

/**
 * Dijkstra over movement costs.
 *
 * Two rules matter and differ: a unit may *pass through* allied units but not
 * finish its move on an occupied tile, while an enemy unit blocks the tile
 * outright (unitpathfindingsystem.cpp returns cost -1 for it).
 */
export function computeMovementRange(map: GameMap, unit: Unit): MovementRange {
  const budget = unit.getMovementpoints();
  const tiles = new Map<string, ReachableTile>();
  const from = new Map<string, string>();

  const start = key(unit.x, unit.y);
  tiles.set(start, { x: unit.x, y: unit.y, cost: 0, canStop: true, canAct: true });

  // Small ranges make a sorted frontier cheaper than a real heap here.
  const frontier: Array<{ x: number; y: number; cost: number }> = [{ x: unit.x, y: unit.y, cost: 0 }];

  while (frontier.length > 0) {
    frontier.sort((a, b) => a.cost - b.cost);
    const current = frontier.shift()!;
    const currentKey = key(current.x, current.y);
    if (current.cost > (tiles.get(currentKey)?.cost ?? Infinity)) continue;

    for (const [dx, dy] of NEIGHBOURS) {
      const x = current.x + dx;
      const y = current.y + dy;
      if (!map.onMap(x, y)) continue;

      const occupant = map.getUnitAt(x, y);
      if (occupant && occupant !== unit) {
        // Enemies block; allies may be passed through but not stopped on.
        // An enemy the mover cannot see does NOT block — otherwise the movement
        // overlay silently reveals exactly where every hidden unit is standing.
        const blocks = unit.getOwner().isEnemyUnit(occupant)
          && !occupant.isStealthed(unit.getOwner())
          && !unit.getIgnoreUnitCollision();
        if (blocks) continue;
      }

      const step = unit.getMovementCosts(x, y, current.x, current.y);
      if (step < 0) continue; // impassable for this movement type

      const cost = current.cost + step;
      if (cost > budget) continue;

      const tileKey = key(x, y);
      const existing = tiles.get(tileKey);
      if (existing && existing.cost <= cost) continue;

      const free = occupant === null || occupant === unit;
      tiles.set(tileKey, { x, y, cost, canStop: free, canAct: true });
      from.set(tileKey, currentKey);
      frontier.push({ x, y, cost });
    }
  }

  return { tiles, from };
}

/** Tiles the unit may actually finish its move on. */
export function stoppableTiles(range: MovementRange): ReachableTile[] {
  return [...range.tiles.values()].filter(tile => tile.canStop);
}

/** Tiles the unit can target with an action, including allied-occupied ones. */
export function actionableTiles(range: MovementRange): ReachableTile[] {
  return [...range.tiles.values()].filter(tile => tile.canAct);
}

/** Reconstructs the route to a destination, starting at the unit's own tile. */
export function pathTo(range: MovementRange, x: number, y: number): ReachableTile[] {
  const target = range.tiles.get(key(x, y));
  if (!target) return [];

  const path: ReachableTile[] = [];
  let cursor: string | undefined = key(x, y);
  while (cursor) {
    const tile = range.tiles.get(cursor);
    if (!tile) break;
    path.push(tile);
    cursor = range.from.get(cursor);
  }
  return path.reverse();
}
