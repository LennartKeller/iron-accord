import type { Game } from '../../game/game.ts';
import type { ActionDescriptor } from '../actions.ts';
import type { BuildingHost, Player, Unit } from '../../host/index.ts';
import { BUILD_GROUPS, type BuildGroup } from './groups.ts';

/** ai/productionSystem: one group, with its live target share. */
interface Distribution {
  unitIds: string[];
  chance: number[];
  totalChance: number;
  /** Target share of the army. */
  distribution: number;
  /** Ceiling on this group as a fraction of the army. */
  maxUnitDistribution: number;
  buildMode: number;
}

interface RankedDistribution {
  /** This group's present share of the army. */
  currentValue: number;
  distribution: Distribution;
}

/** ai/productionSystem: a batch the AI wants built regardless of the mix. */
interface ForcedProduction { unitIds: string[] }

/**
 * ai/productionSystem/simpleproductionsystem.cpp, ported.
 *
 * The idea is a target composition rather than a shopping list: each group
 * (infantry, light tanks, air, naval...) has a share of the army it should
 * occupy, and every turn the AI buys from whichever group is furthest *below*
 * its share. That is what stops it spending an entire game on one unit type,
 * and it is the mechanism the piperunner stalemate was missing.
 *
 * The group tables come from `groups.ts`, generated from upstream's own
 * `__coreai.js`. The configuration path that would normally apply them lives in
 * that same file and cannot run -- see README.md -- so the no-CO reduction of it
 * is applied here directly: without COs every CO modifier is 1 and the
 * direct/indirect ratio modifier is 1, leaving the group's own distribution
 * scaled only by the ground/air/naval balance.
 */
export class ProductionSystem {
  private readonly buildDistribution = new Map<string, Distribution>();
  private activeDistribution = new Map<string, Distribution>();
  /** Units to buy before anything else, upstream's addInitialProduction. */
  private initialProduction: Array<{ unitIds: string[]; count: number }> = [];
  private forcedProduction: ForcedProduction[] = [];
  private initialised = false;

  constructor(private readonly random: () => number) {}

  /**
   * ai/coreai.js: COREAI.initializeSimpleProductionSystem, reduced to the no-CO
   * case, plus the ground/air/naval balance from getGroundModifier.
   *
   * Whether air and naval groups apply is decided by what our factories can
   * actually build rather than by the map's filter flags: the flags only exist
   * on newer map versions, and "can I build a ship" is the question the
   * modifier is really asking.
   */
  initialize(player: Player, buildings: readonly BuildingHost[]): void {
    this.buildDistribution.clear();
    this.initialProduction = [{ unitIds: ['INFANTRY'], count: 6 }];
    this.forcedProduction = [];

    const buildable = new Set<string>();
    for (const building of buildings) {
      if (!building.isProductionBuilding()) continue;
      for (const unitId of building.getConstructionList()) buildable.add(unitId);
    }
    const groupBuildable = (group: BuildGroup) => group.unitIds.some(id => buildable.has(id));

    const naval = groupBuildable(BUILD_GROUPS.lightNavalGroup ?? BUILD_GROUPS.infantryGroup)
      || groupBuildable(BUILD_GROUPS.mediumNavalGroup ?? BUILD_GROUPS.infantryGroup);
    const air = groupBuildable(BUILD_GROUPS.lightAirGroup ?? BUILD_GROUPS.infantryGroup)
      || groupBuildable(BUILD_GROUPS.heavyAirGroup ?? BUILD_GROUPS.infantryGroup);
    // getGroundModifier: ground shrinks in proportion to how many other
    // theatres are in play, so a naval map does not drown in tanks.
    let groundModifier = 1;
    if (naval) groundModifier *= 0.5;
    if (air) groundModifier *= 0.5;

    for (const group of Object.values(BUILD_GROUPS)) {
      const isNaval = /NAVAL/.test(group.name);
      const isAir = /AIR/.test(group.name);
      if (isNaval && !naval) continue;
      if (isAir && !air) continue;
      const isGround = !isNaval && !isAir;
      this.addItemToBuildDistribution(
        group, group.distribution * (isGround ? groundModifier : 1));
    }
    this.initialised = true;
  }

  get ready(): boolean { return this.initialised; }

  /** ai/productionSystem: SimpleProductionSystem::addItemToBuildDistribution. */
  private addItemToBuildDistribution(group: BuildGroup, distribution: number): void {
    if (group.unitIds.length !== group.chance.length) return;
    this.buildDistribution.set(group.name, {
      unitIds: [...group.unitIds],
      chance: [...group.chance],
      totalChance: group.chance.reduce((sum, value) => sum + value, 0),
      distribution,
      maxUnitDistribution: group.maxUnitDistribution,
      buildMode: group.buildMode,
    });
  }

  /** ai/productionSystem: addForcedProduction -- buy one of these next. */
  addForcedProduction(unitIds: readonly string[]): void {
    this.forcedProduction.push({ unitIds: [...unitIds] });
  }

  /**
   * ai/productionSystem: updateActiveProductionSystem -- drop every unit our
   * factories cannot actually build, so a group is not chosen for a unit that
   * exists only on paper.
   */
  updateActive(buildings: readonly BuildingHost[]): void {
    const buildable = new Set<string>();
    for (const building of buildings) {
      if (!building.isProductionBuilding()) continue;
      for (const unitId of building.getConstructionList()) buildable.add(unitId);
    }
    this.activeDistribution = new Map();
    for (const [name, item] of this.buildDistribution) {
      const kept: string[] = [], chances: number[] = [];
      for (let i = 0; i < item.unitIds.length; i++) {
        if (!buildable.has(item.unitIds[i])) continue;
        kept.push(item.unitIds[i]);
        chances.push(item.chance[i]);
      }
      this.activeDistribution.set(name, {
        ...item,
        unitIds: kept,
        chance: chances,
        totalChance: chances.reduce((sum, value) => sum + value, 0),
      });
    }
  }

  /**
   * ai/productionSystem: getBuildDistribution -- groups ordered by how far
   * below their target share they are, so the biggest gap is filled first.
   *
   * The comparator's first two branches float a group we own *nothing* from to
   * the top, provided it is not a basic one: having no answer at all in a
   * category is treated as more urgent than being merely under-weight in it.
   */
  private getBuildDistribution(
    player: Player, units: readonly Unit[],
    minBuildMode: number, maxBuildMode: number, minBaseCost: number, maxBaseCost: number,
  ): RankedDistribution[] {
    const unitCounts = new Map<string, number>();
    for (const unit of units) {
      const unitId = unit.getUnitID();
      for (const [name, item] of this.activeDistribution) {
        if (item.unitIds.includes(unitId)) {
          unitCounts.set(name, (unitCounts.get(name) ?? 0) + 1);
        }
      }
    }

    const total = units.length;
    let totalDistribution = 0;
    const ranked: RankedDistribution[] = [];
    for (const [name, item] of this.activeDistribution) {
      const share = total > 0 ? (unitCounts.get(name) ?? 0) / total : 0;
      if (item.buildMode < minBuildMode || item.buildMode > maxBuildMode) continue;
      if (item.unitIds.length === 0) continue;
      if (share > item.maxUnitDistribution) continue;
      totalDistribution += item.distribution;
      ranked.push({ currentValue: unitCounts.has(name) ? share : 0, distribution: item });
    }

    ranked.sort((lhs, rhs) => {
      if (lhs.currentValue <= 0 && lhs.distribution.buildMode > 1 && rhs.currentValue > 0) return -1;
      if (lhs.currentValue > 0 && rhs.currentValue <= 0) return 1;
      const lhsGap = lhs.distribution.distribution / totalDistribution - lhs.currentValue;
      const rhsGap = rhs.distribution.distribution / totalDistribution - rhs.currentValue;
      return rhsGap - lhsGap;
    });

    // Price filter last, so an unaffordable unit does not hide its whole group.
    for (const item of ranked) {
      const unitIds: string[] = [], chance: number[] = [];
      for (let i = 0; i < item.distribution.unitIds.length; i++) {
        const cost = player.getCosts(item.distribution.unitIds[i]);
        if (cost < minBaseCost || cost > maxBaseCost) continue;
        unitIds.push(item.distribution.unitIds[i]);
        chance.push(item.distribution.chance[i]);
      }
      item.distribution = {
        ...item.distribution,
        unitIds, chance,
        totalChance: chance.reduce((sum, value) => sum + value, 0),
      };
    }
    return ranked;
  }

  /**
   * ai/productionSystem: buildNextUnit -- what to buy now, or null.
   *
   * Order is upstream's: the opening infantry batch, then anything forced, then
   * the group furthest below its share, rolling within that group by chance.
   */
  buildNextUnit(
    game: Game, player: Player, buildings: readonly BuildingHost[], units: readonly Unit[],
    canBuild: (at: { x: number; y: number }, unitId: string) => boolean,
    minBuildMode = 0, maxBuildMode = 100, minBaseCost = 0, maxBaseCost = -1,
  ): ActionDescriptor | null {
    if (!this.initialised) return null;
    const budget = maxBaseCost < 0 ? player.getFunds() : maxBaseCost;

    for (let i = 0; i < this.initialProduction.length; i++) {
      const item = this.initialProduction[i];
      for (const unitId of item.unitIds) {
        const action = this.buildUnit(buildings, unitId, canBuild);
        if (action === null) continue;
        item.count--;
        if (item.count <= 0) this.initialProduction.splice(i, 1);
        return action;
      }
    }

    for (let i = 0; i < this.forcedProduction.length; i++) {
      for (const unitId of this.forcedProduction[i].unitIds) {
        const action = this.buildUnit(buildings, unitId, canBuild);
        if (action !== null) { this.forcedProduction.splice(i, 1); return action; }
      }
    }

    const ranked = this.getBuildDistribution(
      player, units, minBuildMode, maxBuildMode, minBaseCost, budget);
    for (const item of ranked) {
      const { unitIds, chance, totalChance } = item.distribution;
      if (unitIds.length === 0) continue;
      if (unitIds.length === 1) {
        const action = this.buildUnit(buildings, unitIds[0], canBuild);
        if (action !== null) return action;
        continue;
      }
      // Upstream rolls the group's chance table several times over before
      // giving up on it, so an unaffordable favourite does not veto the group.
      for (let attempt = 0; attempt < unitIds.length * 3; attempt++) {
        const roll = Math.floor(this.random() * (totalChance + 1));
        let accumulated = 0;
        for (let i = 0; i < unitIds.length; i++) {
          if (roll < accumulated + chance[i]) {
            const action = this.buildUnit(buildings, unitIds[i], canBuild);
            if (action !== null) return action;
            break;
          }
          accumulated += chance[i];
        }
      }
    }
    void game;
    return null;
  }

  /** ai/productionSystem: buildUnit -- the first factory that will take it. */
  private buildUnit(
    buildings: readonly BuildingHost[], unitId: string,
    canBuild: (at: { x: number; y: number }, unitId: string) => boolean,
  ): ActionDescriptor | null {
    for (const building of buildings) {
      if (!building.isProductionBuilding()) continue;
      const at = { x: building.getX(), y: building.getY() };
      if (!canBuild(at, unitId)) continue;
      return { kind: 'build', at, unitId };
    }
    return null;
  }
}
