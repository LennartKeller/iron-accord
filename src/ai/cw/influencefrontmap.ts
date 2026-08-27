import type { GameMap, Player, Unit } from '../../host/index.ts';
import type { MovementRange } from '../../game/pathfinding.ts';
import type { IslandMap } from './islandmap.ts';

/**
 * ai/influencefrontmap.cpp: InfluenceInfo -- one tile's balance of power.
 *
 * Influence is per player, but read per *team*: getPlayerInfluence sums a
 * player's allies, so two allied factories reinforce the same tile.
 */
export class InfluenceInfo {
  /** Raw influence contributed by each player, indexed by player id. */
  readonly playerValues: number[];
  private ownInfluence = 0;
  private enemyInfluence = 0;
  private highestInfluence = 0;
  /** Player ids tied for the most influence here; empty when the tile is dead. */
  owners: number[] = [];

  private readonly map: GameMap;

  constructor(map: GameMap) {
    this.map = map;
    this.playerValues = new Array(map.getPlayerCount()).fill(0);
  }

  reset(): void {
    this.playerValues.fill(0);
    this.highestInfluence = 0;
    this.owners = [];
    this.ownInfluence = 0;
    this.enemyInfluence = 0;
  }

  increaseInfluence(player: number, value: number): void {
    // The C++ parameter is qint32, so a fractional contribution truncates
    // before it lands -- which is how distant tiles end up at exactly zero.
    this.playerValues[player] += Math.trunc(value);
  }

  /** Influence of `playerId` and everyone allied with them. */
  getPlayerInfluence(playerId: number): number {
    const owner = this.map.getPlayer(playerId);
    if (!owner) return 0;
    let influence = 0;
    for (let player = 0; player < this.playerValues.length; player++) {
      if (owner.isPlayerIdAlly(player)) influence += this.playerValues[player];
    }
    return influence;
  }

  /**
   * ai/influencefrontmap.cpp: InfluenceInfo::updateOwner -- resolves the tile
   * from the point of view of one player.
   */
  updateOwner(owner: Player): void {
    this.owners = [];
    this.enemyInfluence = 0;
    this.ownInfluence = 0;
    let highest = 0;
    for (let player = 0; player < this.playerValues.length; player++) {
      const influence = this.getPlayerInfluence(player);
      if (owner.isPlayerIdEnemy(player) && influence > this.enemyInfluence) {
        this.enemyInfluence = influence;
      } else if (owner.isPlayerIdAlly(player) && influence > this.ownInfluence) {
        this.ownInfluence = influence;
      }
      if (influence > highest) {
        highest = influence;
        this.owners = [player];
      } else if (influence > 0 && influence === highest) {
        this.owners.push(player);
      }
    }
    this.highestInfluence = highest;
  }

  getOwnInfluence(): number { return this.ownInfluence; }
  getEnemyInfluence(): number { return this.enemyInfluence; }
  getHighestInfluence(): number { return this.highestInfluence; }
}

/** How far a factory projects at full strength, before distance decay. */
const FULL_INFLUENCE_RANGE = 6;

/**
 * ai/influencefrontmap.cpp: whose ground is whose.
 *
 * Two sources feed it. Factories project their income across the island they
 * can actually deliver units to, decaying past six tiles; units project their
 * value across everywhere they could reach, decaying per turn of travel. The
 * result tells the AI whether a square is its territory or the enemy's, which
 * it charges as a risk premium when deciding where to stand.
 *
 * Upstream also derives front lines from this -- contiguous runs of contested
 * tiles, grouped by which movement types can cross them. That machinery
 * (findFrontLineTiles, createFrontLine, searchFrontLine, and the frontMovetype
 * and frontOwners fields) exists only to draw a debug overlay: nothing in
 * NormalAi or the production system reads it back. It is not ported.
 */
export class InfluenceFrontMap {
  private readonly info: InfluenceInfo[];
  private readonly width: number;
  private readonly height: number;
  private owner: Player | null = null;
  private totalHighestInfluence = 0;
  /** Cache of unit id -> index into `islands`, as the C++ builds per call. */
  private readonly unitIdToIsland = new Map<string, number>();

  private readonly map: GameMap;
  private readonly islands: IslandMap[];

  constructor(map: GameMap, islands: IslandMap[]) {
    this.map = map;
    this.islands = islands;
    this.width = map.getMapWidth();
    this.height = map.getMapHeight();
    this.info = new Array(this.width * this.height);
    for (let i = 0; i < this.info.length; i++) this.info[i] = new InfluenceInfo(map);
  }

  getInfluenceInfo(x: number, y: number): InfluenceInfo {
    return this.info[y * this.width + x];
  }

  getOwner(): Player | null { return this.owner; }
  setOwner(owner: Player): void { this.owner = owner; }
  getTotalHighestInfluence(): number { return this.totalHighestInfluence; }

  /** ai/influencefrontmap.cpp: InfluenceFrontMap::reset. */
  reset(): void {
    for (const info of this.info) info.reset();
    this.totalHighestInfluence = 0;
  }

  /**
   * ai/influencefrontmap.cpp: InfluenceFrontMap::clear.
   *
   * The C++ also drops and rebuilds the tile array; reusing it is the same end
   * state, since reset() zeroes every field.
   */
  clear(): void {
    this.unitIdToIsland.clear();
    this.reset();
  }

  /** The island map matching a unit id's movement type, or -1. */
  private getIslandFromUnitId(unitId: string): number {
    const cached = this.unitIdToIsland.get(unitId);
    if (cached !== undefined) return cached;
    const moveType = this.map.movementTypeOfId(unitId);
    let island = -1;
    for (let i = 0; i < this.islands.length; i++) {
      if (this.islands[i].getMovementType() === moveType) { island = i; break; }
    }
    this.unitIdToIsland.set(unitId, island);
    return island;
  }

  /**
   * ai/influencefrontmap.cpp: InfluenceFrontMap::addBuildingInfluence.
   *
   * A factory's whole income is split across the unit types it can build, and
   * each share is projected only onto the island that unit type could reach --
   * so a land factory next to the sea claims no water, and a port claims no
   * inland town. That is what keeps the two sides' territory from overlapping
   * everywhere on a mixed map.
   */
  addBuildingInfluence(): void {
    const income: number[] = [];
    for (let i = 0; i < this.map.getPlayerCount(); i++) {
      income.push(this.map.getPlayer(i)!.calcIncome());
    }

    const factories: Array<{ x: number; y: number; owner: number; buildList: string[] }> = [];
    for (let x = 0; x < this.width; x++) {
      for (let y = 0; y < this.height; y++) {
        const building = this.map.getTerrain(x, y).getBuilding();
        const buildingOwner = building?.getOwner();
        if (!building || !buildingOwner) continue;
        if (!building.getActionList().includes('ACTION_BUILD_UNITS')) continue;
        factories.push({
          x, y,
          owner: buildingOwner.getPlayerID(),
          buildList: building.getConstructionList(),
        });
      }
    }

    for (let x = 0; x < this.width; x++) {
      for (let y = 0; y < this.height; y++) {
        const info = this.info[y * this.width + x];
        for (const factory of factories) {
          const buildSize = factory.buildList.length;
          if (buildSize === 0) continue;
          const singleInfluence = income[factory.owner] / buildSize;
          for (const unitId of factory.buildList) {
            const island = this.getIslandFromUnitId(unitId);
            if (island < 0) continue;
            if (!this.islands[island].sameIsland(x, y, factory.x, factory.y)) continue;
            const distance = Math.abs(x - factory.x) + Math.abs(y - factory.y);
            if (distance > FULL_INFLUENCE_RANGE) {
              const dayDivider = distance / FULL_INFLUENCE_RANGE + 1;
              info.increaseInfluence(factory.owner, singleInfluence / dayDivider);
            } else {
              info.increaseInfluence(factory.owner, singleInfluence);
            }
          }
        }
      }
    }
  }

  /**
   * ai/influencefrontmap.cpp: InfluenceFrontMap::addUnitInfluence.
   *
   * `range` is explored over several turns of movement, so `movePoints` (one
   * turn's worth) converts a travel cost into a number of turns and thins the
   * unit's presence accordingly. Unarmed empty transports project nothing --
   * they threaten nobody.
   */
  addUnitInfluence(unit: Unit, range: MovementRange, movePoints: number): void {
    if (!unit.hasWeapons() && unit.getLoadedUnitCount() === 0) return;
    const value = unit.getCoUnitValue();
    const owner = unit.getOwner().getPlayerID();
    for (const tile of range.tiles.values()) {
      let divider = 1;
      if (movePoints > 0 && tile.cost > 0 && tile.cost > movePoints) {
        divider = tile.cost / movePoints + 1;
      }
      this.info[tile.y * this.width + tile.x].increaseInfluence(owner, value / divider);
    }
  }

  /** ai/influencefrontmap.cpp: InfluenceFrontMap::updateOwners. */
  updateOwners(): void {
    if (this.owner === null) return;
    for (const info of this.info) info.updateOwner(this.owner);
  }

  /**
   * ai/influencefrontmap.cpp: InfluenceFrontMap::calculateGlobalData, minus the
   * front-line derivation, which only ever fed the debug overlay.
   */
  calculateGlobalData(): void {
    for (const info of this.info) {
      const highest = info.getHighestInfluence();
      if (highest > this.totalHighestInfluence) this.totalHighestInfluence = highest;
    }
  }
}
