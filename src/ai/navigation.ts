import type { GameMap, Unit } from '../host/index.ts';

export const UNREACHABLE = Number.POSITIVE_INFINITY;

/**
 * Movement cost from every tile to the nearest goal, for one unit's movement
 * type.
 *
 * Straight-line distance is the wrong measure for an objective: on an island
 * map a town across the water is four tiles away and infinitely far at the same
 * time. An agent steering by Manhattan distance walks its infantry to the
 * shore and leaves them there, which is exactly the stalemate that shows up on
 * naval maps. This answers "how far is that for *this* unit", with UNREACHABLE
 * where no route exists — and being told a route does not exist is what makes
 * looking for a boat the obvious alternative.
 *
 * A reverse Dijkstra: relaxing tile `t` through neighbour `n` costs whatever
 * this unit pays to enter `n` from `t`, so the field is built by expanding
 * outwards from the goals.
 */
export function distanceField(
  map: GameMap, unit: Unit, goals: Array<{ x: number; y: number }>,
): Float64Array {
  const field = new Float64Array(map.width * map.height).fill(UNREACHABLE);
  if (goals.length === 0) return field;

  const frontier: Array<{ x: number; y: number; cost: number }> = [];
  for (const goal of goals) {
    if (!map.onMap(goal.x, goal.y)) continue;
    field[goal.y * map.width + goal.x] = 0;
    frontier.push({ x: goal.x, y: goal.y, cost: 0 });
  }

  const NEIGHBOURS = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
  while (frontier.length > 0) {
    frontier.sort((a, b) => a.cost - b.cost);
    const current = frontier.shift()!;
    if (current.cost > field[current.y * map.width + current.x]) continue;

    for (const [dx, dy] of NEIGHBOURS) {
      const x = current.x + dx;
      const y = current.y + dy;
      if (!map.onMap(x, y)) continue;
      // Cost this unit pays stepping from (x,y) into the tile we came from.
      const step = unit.getMovementCosts(current.x, current.y, x, y);
      if (step < 0) continue;                       // impassable for this type
      const cost = current.cost + step;
      const index = y * map.width + x;
      if (cost >= field[index]) continue;
      field[index] = cost;
      frontier.push({ x, y, cost });
    }
  }
  return field;
}

/** Reads a field safely; off-map is unreachable. */
export function fieldAt(map: GameMap, field: Float64Array, x: number, y: number): number {
  return map.onMap(x, y) ? field[y * map.width + x] : UNREACHABLE;
}

/**
 * Caches one field per movement type per turn.
 *
 * Every foot unit shares a field, every tank shares another; recomputing per
 * unit would dominate the turn.
 */
export class Navigator {
  private readonly fields = new Map<string, Float64Array>();

  // Written out rather than declared as parameter properties: these files are
  // loaded by plain `node` in the self-play workers, whose type stripping
  // erases annotations but cannot generate the assignments they imply.
  private readonly map: GameMap;
  private readonly goals: Array<{ x: number; y: number }>;

  constructor(map: GameMap, goals: Array<{ x: number; y: number }>) {
    this.map = map;
    this.goals = goals;
  }

  /** Distance-to-goal field for whatever moves like this unit. */
  for(unit: Unit): Float64Array {
    const type = unit.getMovementType();
    let field = this.fields.get(type);
    if (!field) {
      field = distanceField(this.map, unit, this.goals);
      this.fields.set(type, field);
    }
    return field;
  }

  distance(unit: Unit, x: number, y: number): number {
    return fieldAt(this.map, this.for(unit), x, y);
  }

  /** Can this unit get to any goal at all, from where it stands? */
  canReachGoal(unit: Unit): boolean {
    return this.distance(unit, unit.x, unit.y) !== UNREACHABLE;
  }
}
