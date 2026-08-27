import { Unit, type GameMap, type Player } from '../../host/index.ts';

/** ai/islandmap.h: IslandMap::UNKNOWN -- a tile this movement type cannot enter. */
export const UNKNOWN_ISLAND = -1;

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], [1, 0], [0, 1], [-1, 0],
];

/**
 * ai/islandmap.cpp: connected components of the board for one movement type.
 *
 * This is what lets the AI tell "that town is far away" from "that town is on
 * another landmass and I need a boat". Units are ignored entirely -- an island
 * is about terrain, not about who is standing on it.
 *
 * Upstream runs an unbounded pathfinding sweep from every unvisited passable
 * tile; a flood fill is the same computation without the queue, and keeping
 * upstream's column-major seed order matters because the component *numbering*
 * is what `getIslandSize` and the production system's island bonuses key on.
 *
 * The edge test is deliberately directional, matching upstream: a tile joins
 * the island being filled if the probe can step into it *from* the tile already
 * in that island. Where movement costs are asymmetric the labelling then
 * depends on seed order, exactly as the C++ sweep does.
 */
export class IslandMap {
  private readonly islands: Int32Array;
  private readonly width: number;
  private readonly height: number;
  private readonly movementType: string;
  private readonly owner: Player;
  private readonly map: GameMap;

  constructor(map: GameMap, unitID: string, owner: Player, movementType = '') {
    this.map = map;
    this.owner = owner;
    this.width = map.getMapWidth();
    this.height = map.getMapHeight();
    this.islands = new Int32Array(this.width * this.height).fill(UNKNOWN_ISLAND);

    // A probe unit, purely to ask the movement table questions. `new Unit`
    // deliberately does not put it on the board or in the owner's roster, but it
    // does consume a uid -- and a uid the real game never issued desynchronises
    // every later action, which is precisely the leak that once made planner
    // games unreplayable. So the counter is rewound.
    const uidBefore = map.getUnitUidCounter();
    const probe = new Unit(map, unitID, owner, 0, 0);
    probe.setIgnoreUnitCollision(true);
    this.movementType = movementType !== '' ? movementType : probe.getMovementType();

    let currentIsland = 0;
    const queue: number[] = [];
    for (let x = 0; x < this.width; x++) {
      for (let y = 0; y < this.height; y++) {
        const seed = y * this.width + x;
        if (this.islands[seed] !== UNKNOWN_ISLAND) continue;
        if (!probe.canMoveOver(x, y)) continue;

        this.islands[seed] = currentIsland;
        queue.length = 0;
        queue.push(seed);
        for (let head = 0; head < queue.length; head++) {
          const index = queue[head];
          const cy = (index / this.width) | 0;
          const cx = index - cy * this.width;
          for (const [dx, dy] of NEIGHBOURS) {
            const nx = cx + dx, ny = cy + dy;
            if (!map.onMap(nx, ny)) continue;
            const at = ny * this.width + nx;
            if (this.islands[at] !== UNKNOWN_ISLAND) continue;
            if (probe.getMovementCosts(nx, ny, cx, cy) < 0) continue;
            this.islands[at] = currentIsland;
            queue.push(at);
          }
        }
        currentIsland++;
      }
    }
    map.setUnitUidCounter(uidBefore);
  }

  /** ai/islandmap.h: IslandMap::getIsland -- -1 where this unit cannot go. */
  getIsland(x: number, y: number): number {
    if (!this.map.onMap(x, y)) return UNKNOWN_ISLAND;
    return this.islands[y * this.width + x];
  }

  /**
   * ai/islandmap.h: IslandMap::sameIsland.
   *
   * Two unreachable tiles are not "the same island": the C++ requires the first
   * to be a real island before comparing, so -1 == -1 is false.
   */
  sameIsland(x1: number, y1: number, x2: number, y2: number): boolean {
    const first = this.getIsland(x1, y1);
    return first > UNKNOWN_ISLAND && first === this.getIsland(x2, y2);
  }

  getIslandSize(island: number): number {
    let count = 0;
    for (let i = 0; i < this.islands.length; i++) if (this.islands[i] === island) count++;
    return count;
  }

  getMovementType(): string { return this.movementType; }

  /**
   * ai/islandmap.cpp: IslandMap::getValueOnIsland -- what each side has parked
   * on one landmass, in funds. Drives whether a transport run is worth making.
   */
  getValueOnIsland(island: number): { own: number; enemy: number } {
    let own = 0, enemy = 0;
    for (let x = 0; x < this.width; x++) {
      for (let y = 0; y < this.height; y++) {
        if (this.islands[y * this.width + x] !== island) continue;
        const unit = this.map.getTerrain(x, y).getUnit();
        if (unit === null) continue;
        if (unit.getOwner() === this.owner) own += unit.getCoUnitValue();
        else if (this.owner.isEnemyUnit(unit)) enemy += unit.getCoUnitValue();
      }
    }
    return { own, enemy };
  }
}
