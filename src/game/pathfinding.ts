import type { GameMap, Unit } from '../host/index.ts';
import { BucketQueue, assertIntegerCost } from './bucketqueue.ts';

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
  /**
   * The search's own arrays, kept so `pathTo` need not walk string keys.
   *
   * `from` and `tiles` stay because callers outside this file read them, but
   * reconstructing a route through them costs a string and two hash lookups per
   * step, and the AI reconstructs routes constantly.
   */
  raw: { cost: Int32Array; cameFrom: Int32Array; width: number };
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
/**
 * The two knobs on game/unitpathfindingsystem.h the AI turns.
 *
 * Both default to what a real move does, so an omitted options object is the
 * plain "where can this unit go this turn" question every existing caller asks.
 */
export interface MovementOptions {
  /**
   * Overrides the unit's own movement points.
   *
   * The AI explores several turns of travel at once to judge how far away a
   * target is, which is UnitPathFindingSystem::setMovepoints with a multiplier.
   */
  budget?: number;
  /**
   * game/unitpathfindingsystem.h: CollisionIgnore. Note the C++ sense -- `off`
   * means ignoring is off, so enemies block, which is the normal rule.
   *
   * `onlyNotMoved` blocks only on enemies that have yet to move: one that has
   * already acted is not going to be standing there when we arrive.
   */
  ignoreEnemies?: 'off' | 'onlyNotMoved' | 'all';
}

export function computeMovementRange(
  map: GameMap, unit: Unit, options: MovementOptions = {},
): MovementRange {
  const budget = options.budget ?? unit.getMovementpoints();
  const ignoreEnemies = options.ignoreEnemies ?? 'off';
  const width = map.width;

  // Flat arrays during the search; the string-keyed Maps are built once at the
  // end. Keying tiles by `${x},${y}` while relaxing meant a fresh string and a
  // hash lookup per edge, which with the frontier sort made this one of the
  // hottest paths in self-play.
  const cost = new Int32Array(width * map.height).fill(-1);
  const cameFrom = new Int32Array(width * map.height).fill(-1);
  const canStop = new Uint8Array(width * map.height);
  // First-insertion order, which the Maps below must preserve: their iteration
  // order reaches action enumeration, so changing it changes which move an
  // agent picks between equal options — and every recorded replay with it.
  const reached: number[] = [];

  const startIndex = unit.y * width + unit.x;
  cost[startIndex] = 0;
  canStop[startIndex] = 1;
  reached.push(startIndex);

  const frontier = new BucketQueue();
  frontier.push(startIndex, 0);

  while (frontier.size > 0) {
    const index = frontier.pop();
    const cy = (index / width) | 0;
    const cx = index - cy * width;
    const currentCost = cost[index];

    for (const [dx, dy] of NEIGHBOURS) {
      const x = cx + dx;
      const y = cy + dy;
      if (!map.onMap(x, y)) continue;

      const occupant = map.getUnitAt(x, y);
      if (occupant && occupant !== unit) {
        // Enemies block; allies may be passed through but not stopped on.
        // An enemy the mover cannot see does NOT block — otherwise the movement
        // overlay silently reveals exactly where every hidden unit is standing.
        const blocks = unit.getOwner().isEnemyUnit(occupant)
          && !occupant.isStealthed(unit.getOwner())
          && !unit.getIgnoreUnitCollision()
          && (ignoreEnemies === 'off'
            || (ignoreEnemies === 'onlyNotMoved' && !occupant.getHasMoved()));
        if (blocks) continue;
      }

      const step = unit.getMovementCosts(x, y, cx, cy);
      if (step < 0) continue; // impassable for this movement type
      assertIntegerCost(step, x, y);

      const next = currentCost + step;
      if (next > budget) continue;

      const at = y * width + x;
      const existing = cost[at];
      if (existing >= 0 && existing <= next) continue;

      if (existing < 0) reached.push(at);
      cost[at] = next;
      cameFrom[at] = index;
      canStop[at] = occupant === null || occupant === unit ? 1 : 0;
      frontier.push(at, next);
    }
  }

  const tiles = new Map<string, ReachableTile>();
  const from = new Map<string, string>();
  for (const index of reached) {
    const y = (index / width) | 0;
    const x = index - y * width;
    tiles.set(key(x, y), { x, y, cost: cost[index], canStop: canStop[index] === 1, canAct: true });
    const previous = cameFrom[index];
    if (previous >= 0) {
      const py = (previous / width) | 0;
      from.set(key(x, y), key(previous - py * width, py));
    }
  }

  return { tiles, from, raw: { cost, cameFrom, width } };
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
  const { cost, cameFrom, width } = range.raw;
  let cursor = y * width + x;
  if (cursor < 0 || cursor >= cost.length || cost[cursor] < 0) return [];

  // Walks the predecessor array and reads each tile out of `tiles` once, rather
  // than rebuilding a `${x},${y}` key for every step of every route.
  const path: ReachableTile[] = [];
  while (cursor >= 0) {
    const cy = (cursor / width) | 0;
    const tile = range.tiles.get(key(cursor - cy * width, cy));
    if (!tile) break;
    path.push(tile);
    cursor = cameFrom[cursor];
  }
  return path.reverse();
}
