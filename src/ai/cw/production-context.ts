import { isKnownBuilding, visibleUnitAt } from './visibility.ts';
import type { Game } from '../../game/game.ts';
import { GameEnums, type BuildingHost, type Unit, type Player, type GameMap } from '../../host/index.ts';
import type { CoreAI } from './coreai.ts';
import { hasTargets } from './movement.ts';

/** The small QmlVector surface used by the vendored production policy. */
export class ProductionUnitList {
  readonly items: Unit[];
  constructor(units: readonly Unit[]) { this.items = [...units]; }
  size(): number { return this.items.length; }
  at(index: number): Unit | undefined { return this.items[index]; }
  getVector(): Unit[] { return this.items; }

  /** coreengine/qmlvector.cpp:138; both proximity comparisons are strict. */
  pruneEnemies(
    ownUnits: ProductionUnitList, ownBuildings: ProductionBuildingList,
    buildingDistance: number, distanceMultiplier: number,
  ): void {
    const kept = this.items.filter(unit => {
      const movement = unit.getBaseMovementPoints();
      const distance = (x: number, y: number) => Math.abs(unit.x - x) + Math.abs(unit.y - y);
      return ownUnits.items.some(own =>
        distance(own.x, own.y) < distanceMultiplier * (movement + own.getBaseMovementPoints()))
        || ownBuildings.items.some(building =>
          distance(building.getX(), building.getY()) < distanceMultiplier * (movement + buildingDistance));
    });
    this.items.splice(0, this.items.length, ...kept);
  }
}

export class ProductionBuildingList {
  readonly items: BuildingHost[];
  constructor(buildings: readonly BuildingHost[], private observer?: { map: GameMap; player: Player }) {
    this.items = observer ? buildings.filter(building => isKnownBuilding(building, observer.player)) : [...buildings];
  }
  size(): number { return this.items.length; }
  at(index: number): BuildingHost | undefined { return this.items[index]; }
  getVector(): BuildingHost[] { return this.items; }
  getBuildingCount(id: string): number {
    return this.items.filter(building => building.getBuildingID() === id).length;
  }
  /** coreengine/qmlvector.cpp:217: occupancy, rather than affordability. */
  getBuildingGroupCount(ids: readonly string[], onlyEmpty: boolean): number {
    return this.items.filter(building => ids.includes(building.getBuildingID())
      && (!onlyEmpty || (this.observer
        ? visibleUnitAt(this.observer.map, this.observer.player, building.getX(), building.getY()) === null
        : building.getTerrain()?.getUnit() === null))).length;
  }
}

/** Adapts the existing host without altering Player or the map's script API. */
export function createProductionContext(
  game: Game, core: CoreAI, owned: readonly BuildingHost[],
  enemyUnits: readonly Unit[], enemyBuildings: readonly BuildingHost[],
) {
  const player = core.player;
  const units = new ProductionUnitList(player.units);
  const buildings = new ProductionBuildingList(owned, { map: game.map, player });
  const enemies = new ProductionUnitList(enemyUnits.filter(unit => !unit.isStealthed(player)));
  const hostileBuildings = new ProductionBuildingList(enemyBuildings, { map: game.map, player });
  const map = {
    getCurrentDay: () => game.day,
    getMapWidth: () => game.map.getMapWidth(),
    getMapHeight: () => game.map.getMapHeight(),
    getGameRules: () => game.map.getGameRules(),
    // Map filter flags are not retained by this host; do not infer them from factories.
    hasMapFlags: (_flags: number) => false,
  };
  const policyPlayer = {
    getCO: (index: number) => player.getCO(index),
    getFunds: () => player.getFunds(),
    getCoGroupModifier: (_ids: readonly string[], _system: unknown) => 1,
    // player.cpp:1717 calls getSpEnemyUnits(), despite the method's name.
    // Preserve that policy quirk, but honor this engine's visible-information boundary.
    getAlliedUnits: () => new ProductionUnitList(game.map.units
      .filter(unit => player.isEnemyUnit(unit) && !unit.isStealthed(player))
      .sort((a, b) => a.y - b.y || a.x - b.x)),
  };
  const matches = (unit: Unit, ids: readonly string[], minHp: unknown, minFuel: number) =>
    unit.getHp() >= Number(minHp) && unit.getFuel() >= minFuel
      && (ids.length === 0 || ids.includes(unit.getUnitID()));
  const ai = {
    getPlayer: () => policyPlayer,
    getMap: () => map,
    getAiCoBuildRatioModifier: () => 1,
    getAiCoUnitMultiplier: (_co: unknown, _unit: unknown) => 0,
    // BaseGameInputIF::getUnitBuildValue: base 1 + CO modifier (zero here).
    getUnitBuildValue: (_id: string) => 1,

    /** coreai.cpp:2778 includes one level of cargo, even if its carrier fails the filter. */
    getUnitCount(list: ProductionUnitList, ids: readonly string[], minHp: unknown = 0, minFuel = 0): number {
      let count = 0;
      for (const unit of list.items) {
        if (unit.isStealthed(player)) continue;
        if (matches(unit, ids, minHp, minFuel)) count++;
        // Enemy cargo is private even when its carrier is visible.
        if (!player.isAlly(unit.getOwner())) continue;
        for (const cargo of unit.getLoadedUnits()) if (matches(cargo, ids, minHp, minFuel)) count++;
      }
      return count;
    },
    /** coreai.cpp:2803 intentionally filters only the units on the board. */
    getFilteredUnits(list: ProductionUnitList, ids: readonly string[], minHp: unknown = 0, minFuel = 0): ProductionUnitList {
      return new ProductionUnitList(list.items.filter(unit => !unit.isStealthed(player) && matches(unit, ids, minHp, minFuel)));
    },
    /** coreai.cpp:2839 uses IslandMap::sameIsland, which rejects two unknown tiles. */
    getBuildingCountsOnEnemyIslands(list: ProductionUnitList, targets: ProductionBuildingList): number {
      return targets.items.filter(building => !list.items.some(unit => {
        const island = core.islandMaps[core.getIslandIndex(unit)];
        return island.sameIsland(unit.x, unit.y, building.getX(), building.getY());
      })).length;
    },
    /** coreai.cpp:1181; unarmed units do not count as idle combat units. */
    getIdleUnitCount(
      list: ProductionUnitList, ids: readonly string[],
      targets: ProductionUnitList, targetBuildings: ProductionBuildingList,
    ): number {
      return list.items.filter(unit => {
        if (ids.length > 0 && !ids.includes(unit.getUnitID())) return false;
        const index = core.getIslandIndex(unit);
        const island = core.getIsland(unit);
        return (unit.hasAmmo1() || unit.hasAmmo2()) && !hasTargets(core, 0, unit, false,
          targets.items, targetBuildings.items, index, island, true, true, true);
      }).length;
    },
    /** coreai.cpp:1201 requires ground combat units and production on both sides. */
    shareIslandWithEnemy(
      list: ProductionUnitList, ownBuildings: ProductionBuildingList, targetBuildings: ProductionBuildingList,
    ): boolean {
      const excluded: number[] = [GameEnums.UnitType_Infantry, GameEnums.UnitType_Hovercraft,
        GameEnums.UnitType_Air, GameEnums.UnitType_Naval];
      return list.items.some(unit => {
        if (excluded.includes(unit.getUnitType())) return false;
        core.getIslandIndex(unit);
        return ownBuildings.items.some(building => building.isProductionBuilding()
          && core.onSameIslandAs(unit, building))
          && targetBuildings.items.some(building => building.isProductionBuilding()
            && core.onSameIslandAs(unit, building));
      });
    },
  };
  return { ai, map, buildings, units, enemyUnits: enemies, enemyBuildings: hostileBuildings };
}

export type ProductionContext = ReturnType<typeof createProductionContext>;
