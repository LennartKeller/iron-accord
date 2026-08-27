import type { GameMap, Unit } from '../../host/index.ts';

/**
 * One place worth going, and how much the AI wants to go there.
 *
 * `z` is a multiplier on distance: above 1 makes the target feel further away
 * than it is, so a unit prefers a nearer cheap objective over a far rich one.
 * Upstream stores these as QVector3D, hence the name.
 */
export interface WeightedTarget { x: number; y: number; z: number }

export interface TargetedPfsOptions {
  /** Only the nearest-by-weighted-distance targets are searched for. */
  maxTargets?: number;
  /** Prune nodes past the movement budget. Upstream default is true. */
  abortOnCostExceed?: boolean;
  /**
   * ai/coreai.cpp: m_MoveCostMap -- extra cost on tiles covered by a hostile
   * cannon building, so routes bend around them. Indexed y * width + x, and
   * all zeroes on maps without such buildings.
   */
  moveCostMap?: Int32Array | null;
}

/** Penalty for routing through an occupied tile beyond this turn's reach. */
const BLOCK_COSTS = 3;

interface Node {
  x: number; y: number; index: number;
  totalCost: number; currentCosts: number;
  prevIndex: number; distance: number;
}

/**
 * ai/targetedunitpathfindingsystem.cpp: A* toward whichever of several targets
 * is cheapest to reach, then "how far along that route can I get today".
 *
 * This is how NormalAi moves anything that is not already next to something to
 * do -- `moveUnit` and `moveToUnloadArea` both funnel through it -- so it is the
 * difference between an army that advances and one that mills around at home.
 *
 * Kept separate from `computeMovementRange` deliberately: that one is a plain
 * Dijkstra on the hot self-play path, and this one needs a goal heuristic,
 * per-node pruning and two extra cost terms.
 */
export class TargetedUnitPathFindingSystem {
  private readonly width: number;
  private readonly height: number;
  private readonly targets: WeightedTarget[];
  private readonly moveCostMap: Int32Array | null;
  private readonly abortOnCostExceed: boolean;
  /** Search budget, after the fuel clamp; see the constructor. */
  private readonly movepoints: number;
  /** What the unit can actually spend in one turn. */
  private readonly unitMovepoints: number;

  private readonly costs: Int32Array;
  private readonly closed: Uint8Array;
  private readonly cameFrom: Int32Array;
  private finishNode = -1;
  private finishNodes: Array<{ x: number; y: number; movementCost: number; multiplier: number }> = [];
  private finishInfo = { bestCost: -1, target: -1, remainingCost: -1 };

  constructor(
    private readonly map: GameMap,
    private readonly unit: Unit,
    targets: WeightedTarget[],
    options: TargetedPfsOptions = {},
  ) {
    this.width = map.getMapWidth();
    this.height = map.getMapHeight();
    this.moveCostMap = options.moveCostMap ?? null;
    this.abortOnCostExceed = options.abortOnCostExceed ?? true;

    const maxTargets = options.maxTargets ?? 20;
    const startX = unit.getX(), startY = unit.getY();
    // A weight of zero would collapse the distance term, so upstream floors it.
    const weighted = targets.map(t => ({ x: t.x, y: t.y, z: t.z <= 0 ? 1 : t.z }));
    // Upstream sorts with std::sort, which is unstable; a stable sort is used
    // here so equally-attractive targets keep the caller's order rather than an
    // arbitrary one, which is the difference between a reproducible match and a
    // near-reproducible one.
    weighted.sort((a, b) =>
      (Math.abs(startX - a.x) + Math.abs(startY - a.y)) * a.z
      - (Math.abs(startX - b.x) + Math.abs(startY - b.y)) * b.z);
    this.targets = weighted.slice(0, maxTargets);

    this.unitMovepoints = unit.getMovementpoints({ x: startX, y: startY });
    // game/unitpathfindingsystem.cpp: setMovepoints(getFuel() * 2). The setter
    // then walks the budget down while it would cost more fuel than the unit
    // has, and the fuel cost of N moves is N once the CO modifier is zero -- so
    // the doubling is undone in full and the real budget is just the fuel.
    const fuel = unit.getFuel();
    this.movepoints = fuel >= 0 ? Math.max(0, Math.min(fuel * 2, fuel)) : fuel * 2;

    const size = this.width * this.height;
    this.costs = new Int32Array(size).fill(-1);
    this.closed = new Uint8Array(size);
    this.cameFrom = new Int32Array(size).fill(-1);
    this.explore();
  }

  getTargets(): readonly WeightedTarget[] { return this.targets; }

  private indexOf(x: number, y: number): number { return y * this.width + x; }

  /**
   * ai/coreai.cpp: CoreAI::index -- which target sits on this tile, or -1.
   */
  private targetAt(x: number, y: number): number {
    for (let i = 0; i < this.targets.length; i++) {
      if (Math.trunc(this.targets[i].x) === x && Math.trunc(this.targets[i].y) === y) return i;
    }
    return -1;
  }

  /**
   * game/unitpathfindingsystem.cpp: UnitPathFindingSystem::getCosts -- the plain
   * per-step cost, with enemies impassable. This is also what costs a finished
   * path, which is why it is separate from the targeted override below.
   */
  private stepCost(x: number, y: number, curX: number, curY: number): number {
    if (!this.map.onMap(x, y)) return -1;
    if (x === curX && y === curY) return this.unit.getMovementCosts(x, y, x, y);
    const occupant = this.map.getTerrain(x, y).getUnit();
    if (occupant !== null && occupant.getHp() > 0) {
      if (this.unit.getOwner().isEnemyUnit(occupant)
        && !occupant.isStealthed(this.unit.getOwner())
        && !this.unit.getIgnoreUnitCollision()) {
        return -1;
      }
    }
    return this.unit.getMovementCosts(x, y, curX, curY);
  }

  /**
   * ai/targetedunitpathfindingsystem.cpp: the override -- plain cost, plus a
   * nudge away from tiles that are occupied *and* beyond today's reach (whoever
   * is standing there will likely still be in the way), plus any cannon danger.
   */
  private nodeCost(x: number, y: number, curX: number, curY: number, currentCost: number): number {
    let costs = this.stepCost(x, y, curX, curY);
    if (costs < 0) return -1;
    if (currentCost > this.unitMovepoints && this.map.getTerrain(x, y).getUnit() !== null) {
      costs += BLOCK_COSTS;
    }
    if (this.moveCostMap !== null) costs += this.moveCostMap[this.indexOf(x, y)];
    return costs < 0 ? 0 : costs;
  }

  /**
   * ai/targetedunitpathfindingsystem.cpp: the A* heuristic -- weighted manhattan
   * distance to the nearest target. Returning -1 prunes the node, which is how
   * the movement budget is enforced.
   */
  private remainingCost(x: number, y: number, currentCost: number): number {
    if (this.abortOnCostExceed && currentCost > this.movepoints) return -1;
    let minCost = -1;
    const baseMovement = this.unit.getBaseMovementPoints();
    for (const target of this.targets) {
      const distance = Math.abs(Math.trunc(target.x) - x) + Math.abs(Math.trunc(target.y) - y);
      const cost = Math.trunc(distance * target.z + Math.trunc(baseMovement * (target.z - 1)));
      if (cost < minCost || minCost < 0) minCost = cost;
    }
    return minCost;
  }

  /**
   * ai/targetedunitpathfindingsystem.cpp: TargetedUnitPathFindingSystem::finished.
   *
   * Records every target the search touches, and stops once the cheapest one
   * cannot be beaten. Note the C++ hands this the A* *total* rather than the
   * movement cost, so `movementCost` below is cost-so-far plus heuristic.
   */
  private finished(x: number, y: number, movementCosts: number): boolean {
    const index = this.targetAt(x, y);
    if (index >= 0) {
      if (this.finishInfo.target < 0
        || movementCosts < this.finishInfo.bestCost + this.finishInfo.remainingCost) {
        this.finishInfo.remainingCost = Math.trunc(this.targets[index].z - this.targets[0].z);
        this.finishInfo.bestCost = movementCosts;
        this.finishInfo.target = index;
      }
      this.finishNodes.push({ x, y, movementCost: movementCosts, multiplier: this.targets[index].z });
    }
    const occupant = this.map.getTerrain(x, y).getUnit();
    if (occupant === null || this.unit.getIgnoreUnitCollision()
      || occupant.getOwner() === this.unit.getOwner()) {
      return this.finishInfo.target >= 0
        && movementCosts > this.finishInfo.bestCost + this.finishInfo.remainingCost;
    }
    return false;
  }

  /** Of every target reached, the one with the cheapest weighted cost. */
  private setFinishNode(): void {
    if (this.finishNodes.length === 0) return;
    let minCosts = Number.MAX_SAFE_INTEGER, best = -1;
    for (const node of this.finishNodes) {
      const costs = Math.trunc(node.movementCost * node.multiplier);
      if (costs < minCosts) { minCosts = costs; best = this.indexOf(node.x, node.y); }
    }
    this.finishNode = best;
  }

  /**
   * coreengine/pathfindingsystem.cpp: PathFindingSystem::explore.
   *
   * The open list is kept sorted by (totalCost, currentCosts, distance) and
   * inserted at the upper bound, so among equally good nodes the one queued
   * first is expanded first. That ordering decides which of several equal routes
   * the AI takes, so it is reproduced rather than approximated.
   */
  private explore(): void {
    const start = this.indexOf(this.unit.getX(), this.unit.getY());
    if (start < 0 || start >= this.costs.length) return;
    const open: Node[] = [{
      x: this.unit.getX(), y: this.unit.getY(), index: start,
      totalCost: 0, currentCosts: 0, prevIndex: -1, distance: 0,
    }];

    while (open.length > 0) {
      const current = open.shift()!;
      if (this.closed[current.index]) continue;
      this.closed[current.index] = 1;
      this.costs[current.index] = current.currentCosts;
      this.cameFrom[current.index] = current.prevIndex;

      if (this.finished(current.x, current.y, current.totalCost)) {
        this.setFinishNode();
        return;
      }

      // East, west, south, north -- upstream's order, which feeds the
      // insertion order that breaks ties above.
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as Array<[number, number]>) {
        const nx = current.x + dx, ny = current.y + dy;
        if (nx < 0 || ny < 0 || nx >= this.width || ny >= this.height) continue;
        const index = this.indexOf(nx, ny);
        if (this.closed[index]) continue;

        const stepCosts = this.nodeCost(nx, ny, current.x, current.y, current.currentCosts);
        if (stepCosts < 0) continue;
        const newCosts = stepCosts + current.currentCosts;
        const remaining = this.remainingCost(nx, ny, newCosts);
        if (remaining < 0) continue;

        const node: Node = {
          x: nx, y: ny, index,
          totalCost: newCosts + remaining,
          currentCosts: newCosts,
          prevIndex: current.index,
          distance: Math.abs(nx - this.unit.getX()) + Math.abs(ny - this.unit.getY()),
        };
        open.splice(upperBound(open, node), 0, node);
      }
    }
    this.setFinishNode();
  }

  /** The route to the chosen target, target first and the unit's tile last. */
  private pathToFinish(): Array<{ x: number; y: number }> {
    if (this.finishNode < 0) return [];
    const path: Array<{ x: number; y: number }> = [];
    let cursor = this.finishNode;
    while (cursor >= 0) {
      const y = (cursor / this.width) | 0;
      path.push({ x: cursor - y * this.width, y });
      cursor = this.cameFrom[cursor];
    }
    return path;
  }

  /** Cost of walking `path`, which runs target-first back to the unit. */
  private pathCost(path: Array<{ x: number; y: number }>): number {
    let total = 0;
    for (let i = path.length - 2; i >= 0; i--) {
      total += this.stepCost(path[i].x, path[i].y, path[i + 1].x, path[i + 1].y);
    }
    return total;
  }

  /**
   * ai/targetedunitpathfindingsystem.cpp: getReachableTargetField -- the tile to
   * actually move to now, being as far along the chosen route as this turn's
   * movement allows. Returns (-1, -1) when there is nowhere to go.
   *
   * The second loop condition transcribes an upstream quirk: `curX`/`curY` are
   * set to the finish node and then never updated, so the zero-cost test always
   * asks about entering the *target* from the current second element rather than
   * about the step being trimmed. Kept as-is; it only ever triggers on a
   * zero-cost step, which no shipped movement table produces.
   */
  getReachableTargetField(movepoints: number): { x: number; y: number } {
    if (this.finishNode < 0) return { x: -1, y: -1 };
    const path = this.pathToFinish();
    if (path.length === 0) return { x: -1, y: -1 };
    const startX = this.unit.getX(), startY = this.unit.getY();
    const finishY = (this.finishNode / this.width) | 0;
    const finishX = this.finishNode - finishY * this.width;

    let cost = this.pathCost(path);
    while (path.length > 0) {
      const atStart = finishX === startX && finishY === startY;
      const overBudget = !atStart && cost > movepoints;
      const zeroStep = path.length > 1
        && this.stepCost(finishX, finishY, path[1].x, path[1].y) === 0;
      if (!overBudget && !zeroStep) break;
      path.shift();
      if (path.length === 0) break;
      cost = this.pathCost(path);
    }
    return path.length > 0 ? path[0] : { x: -1, y: -1 };
  }
}

/** std::upper_bound over the (totalCost, currentCosts, distance) ordering. */
function upperBound(list: Node[], node: Node): number {
  let low = 0, high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (less(node, list[mid])) high = mid; else low = mid + 1;
  }
  return low;
}

function less(a: Node, b: Node): boolean {
  if (a.totalCost !== b.totalCost) return a.totalCost < b.totalCost;
  if (a.currentCosts !== b.currentCosts) return a.currentCosts < b.currentCosts;
  return a.distance < b.distance;
}
