import { apparentCanProduceAt } from './visibility.ts';
import type { Game } from '../../game/game.ts';
import type { ActionDescriptor } from '../actions.ts';
import { Unit, type BuildingHost, type Player } from '../../host/index.ts';
import { ScriptVariables } from '../../host/variables.ts';
import { computeMovementRange } from '../../game/pathfinding.ts';
import type { CoreAI } from './coreai.ts';
import { PRODUCTION_POLICY } from './production-policy.ts';
import { createProductionContext } from './production-context.ts';
import type { BuildGroup } from './groups.ts';

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
interface ForcedProduction { unitIds: string[]; targetUids?: number[]; x?: number; y?: number }

/**
 * C++ SimpleProductionSystem algorithms behind the actual pinned JS policy.
 * Policy decisions run through production-policy.ts; these adapters provide
 * queues, distributions, island suitability and threat-aware build execution.
 */
export class ProductionSystem {
  private readonly buildDistribution = new Map<string, Distribution>();
  private activeDistribution = new Map<string, Distribution>();
  /** Units to buy before anything else, upstream's addInitialProduction. */
  private initialProduction: Array<{ unitIds: string[]; count: number }> = [];
  private forcedProduction: ForcedProduction[] = [];
  private initialised = false;
  private readonly variables = new ScriptVariables();
  private preparedForTurn = '';
  private producedCount = 0;
  private maxDamageCheckRange = 10;
  private maxSingleDamage = 70;

  private readonly random: () => number;

  constructor(random: () => number) { this.random = random; }

  /** Run the actual pinned JS initialization with the no-CO host adapter. */
  initialize(player: Player, _buildings: readonly BuildingHost[]): void {
    if (this.initialised) return;
    this.initializePolicy(player, true);
  }

  private initializePolicy(player: Player, opening: boolean): void {
    const ai = {
      getPlayer: () => ({ getCO: () => null, getCoGroupModifier: () => 1 }),
      getAiCoBuildRatioModifier: () => 1,
      getUnitBuildValue: () => 1,
    };
    PRODUCTION_POLICY.initializeSimpleProductionSystem(this.scriptSystem(player), ai, player.map, [1, 1, 1, 1], opening);
    this.initialised = true;
  }

  /** Common C++ production-system methods exposed to the generated JS policy. */
  private scriptSystem(player: Player) {
    return {
      getVariables: () => this.variables,
      getDummyUnit: (id: string) => ({ getBaseMinRange: () => this.dummy(player, id).minRange }),
      addInitialProduction: (unitIds: string[], count: number) => this.initialProduction.push({ unitIds: [...unitIds], count }),
      resetBuildDistribution: () => this.buildDistribution.clear(),
      resetForcedProduction: () => { this.forcedProduction = []; },
      addItemToBuildDistribution: (name: string, unitIds: string[], chance: number[], distribution: number,
        buildMode: number, guardCondition: string, maxUnitDistribution: number) => this.addItemToBuildDistribution({
          name, unitIds, chance: chance.map(Math.trunc), distribution, buildMode, guardCondition, maxUnitDistribution,
        }, distribution),
      addForcedProduction: (unitIds: string[], x = -1, y = -1) =>
        this.forcedProduction.push({ unitIds: [...unitIds], x, y }),
      addForcedProductionCloseToTargets: (unitIds: string[], targets: { items: Unit[] }) =>
        this.forcedProduction.push({ unitIds: [...unitIds], targetUids: targets.items.map(unit => unit.uid) }),
      setMaxDamageCheckRange: (range: number) => { this.maxDamageCheckRange = range; },
      setMaxSingleDamage: (damage: number) => { this.maxSingleDamage = damage; },
      getCurrentTurnProducedUnitsCounter: () => this.producedCount,
    };
  }

  private dummy(player: Player, id: string): Unit {
    const counter = player.map.getUnitUidCounter();
    try { return new Unit(player.map, id, player, 0, 0); }
    finally { player.map.setUnitUidCounter(counter); }
  }

  /** The special-factory menu callback, before the ordinary unit/production ladder. */
  chooseMenuItem(
    game: Game, core: CoreAI, unitIds: readonly string[], enabled: readonly boolean[],
    buildings: readonly BuildingHost[],
  ): number {
    this.initialize(core.player, buildings);
    const context = createProductionContext(game, core, buildings, [], []);
    const system = {
      getInit: () => this.ready,
      getEnabled: () => true,
      getProductionFromList: (ids: string[], units: { items: Unit[] }, owned: { items: BuildingHost[] },
        minMode: number, maxMode: number, enableList: boolean[]) =>
        this.getProductionFromList(core.player, ids, units.items, owned.items, minMode, maxMode, enableList),
    };
    const result = PRODUCTION_POLICY.getFactoryMenuItem({ getSimpleProductionSystem: () => system }, null,
      [...unitIds], [], [...enabled], context.units, context.buildings, core.player, context.map);
    return typeof result === 'number' && Number.isInteger(result) ? result : -1;
  }

  /** ai/productionSystem/simpleproductionsystem.cpp:788, including its negative cost ceiling. */
  private getProductionFromList(
    player: Player, unitIds: readonly string[], units: readonly Unit[], buildings: readonly BuildingHost[],
    minMode: number, maxMode: number, enabled: readonly boolean[],
  ): number {
    if (this.activeDistribution.size === 0) this.updateActive(buildings);
    // Pinned upstream passes -1 directly, unlike buildNextUnit's funds fallback.
    // This excludes nonnegative prices and returns -1 for ordinary rosters;
    // CoreAI's building-menu driver then uses its enabled-item fallback.
    const ranked = this.getBuildDistribution(player, units, minMode, maxMode, 0, -1);
    let index = -1;
    const allowed = () => index >= 0 && (enabled.length === 0 || enabled[index]);
    for (const { distribution } of ranked) {
      if (distribution.unitIds.length === 1) {
        index = unitIds.indexOf(distribution.unitIds[0]);
      } else {
        for (let attempt = 0; attempt < distribution.unitIds.length * 3; attempt++) {
          const roll = Math.floor(this.random() * (distribution.totalChance + 1));
          let chance = 0;
          for (let i = 0; i < distribution.unitIds.length; i++) {
            if (roll < chance + distribution.chance[i]) index = unitIds.indexOf(distribution.unitIds[i]);
            else chance += distribution.chance[i];
            if (allowed()) break;
          }
          if (allowed()) break;
        }
      }
      if (allowed()) break;
    }
    return index;
  }

  /** Full normal policy, including reactive queues and staged funds/danger budgets. */
  chooseAction(
    game: Game, core: CoreAI, buildings: readonly BuildingHost[], enemyUnits: readonly Unit[],
    enemyBuildings: readonly BuildingHost[], canBuild?: (at: { x: number; y: number }, unitId: string) => boolean,
  ): ActionDescriptor | null {
    const player = core.player;
    this.initialize(player, buildings);
    const context = createProductionContext(game, core, [...buildings], [...enemyUnits], [...enemyBuildings]);
    context.enemyUnits.pruneEnemies(context.units, context.buildings,
      core.config.ownBuildingPruneRange, core.config.enemyPruneRange);
    const visibleEnemies = context.enemyUnits.items;
    const nearest = (building: BuildingHost) => Math.min(...visibleEnemies.map(unit =>
      Math.abs(building.getX() - unit.x) + Math.abs(building.getY() - unit.y)));
    buildings = [...buildings].sort((a, b) => nearest(a) - nearest(b));
    context.buildings.items.splice(0, context.buildings.items.length, ...buildings);
    const system = this.scriptSystem(player);
    const turn = `${game.day}:${player.getPlayerID()}`;
    if (this.preparedForTurn !== turn) {
      this.producedCount = 0;
      PRODUCTION_POLICY.onNewBuildQueue(system, context.ai, context.buildings, context.units,
        context.enemyUnits, context.enemyBuildings, context.map, [1, 1, 1, 1]);
      this.preparedForTurn = turn;
    }
    this.updateActive(buildings);
    const islandSizes = new Map<string, number>();
    const islandSize = (id: string, building: BuildingHost): number => {
      const key = `${id}@${building.getX()},${building.getY()}`;
      let size = islandSizes.get(key);
      if (size === undefined) {
        const dummy = this.dummy(player, id);
        const island = core.islandMaps[core.getIslandIndex(dummy)];
        const index = island.getIsland(building.getX(), building.getY());
        size = index < 0 ? 0 : island.getIslandSize(index);
        islandSizes.set(key, size);
      }
      return size;
    };
    const averages = new Map<BuildingHost, number>();
    for (const building of buildings) {
      if (!building.isProductionBuilding()) continue;
      const ids = building.getConstructionList();
      averages.set(building, ids.length ? ids.reduce((sum, id) => sum + islandSize(id, building), 0) / ids.length : 0);
    }
    const reach = new Map<Unit, Array<{ x: number; y: number }>>();
    const reasonable = (at: { x: number; y: number }, id: string): boolean => {
      const target = this.dummy(player, id);
      for (const enemy of visibleEnemies) {
        const position = { x: enemy.x, y: enemy.y };
        if (Math.abs(at.x - enemy.x) + Math.abs(at.y - enemy.y) > this.maxDamageCheckRange
          || !(enemy.hasAmmo1() || enemy.hasAmmo2())) continue;
        const damage = Math.max(...[enemy.weapon1ID, enemy.weapon2ID].map(weapon =>
          Number(game.registry[weapon]?.getBaseDamage?.(target) ?? 0)));
        if (damage < this.maxSingleDamage) continue;
        let positions = reach.get(enemy);
        if (!positions) {
          positions = enemy.canMoveAndFire(position)
            ? [...computeMovementRange(game.map, enemy, { visibilityPlayer: player }).tiles.values()] : [position];
          reach.set(enemy, positions);
        }
        if (positions.some(point => {
          const distance = Math.abs(point.x - at.x) + Math.abs(point.y - at.y);
          return distance >= enemy.getMinRange(position) && distance <= enemy.getMaxRange(position);
        })) return false;
      }
      return true;
    };
    let chosen: ActionDescriptor | null = null;
    const scripted = { ...system,
      buildNextUnit: (_buildings: unknown, _units: unknown, minMode: number, maxMode: number,
        minIsland: number, minCost: number, maxCost: number, alwaysBuild = false): boolean => {
        chosen = this.buildNextUnit(game, player, buildings, player.units, (at, id) => {
          if (!apparentCanProduceAt(game, at.x, at.y)) return false;
          const building = game.map.getTerrain(at.x, at.y).getBuilding();
          if (!building || !game.buildOptions(building).some(option => option.id === id && option.affordable)) return false;
          if (canBuild && !canBuild(at, id)) return false;
          if ((averages.get(building) ?? 0) * minIsland > islandSize(id, building)) return false;
          return alwaysBuild || reasonable(at, id);
        }, minMode, maxMode, minCost, maxCost);
        if (chosen) this.producedCount++;
        return chosen !== null;
      },
    };
    PRODUCTION_POLICY.buildUnitSimpleProductionSystem(scripted, context.ai, context.buildings,
      context.units, context.enemyUnits, context.enemyBuildings, context.map);
    return chosen;
  }

  get ready(): boolean { return this.initialised; }

  /** Persist policy history as well as queues so a resumed turn retains its budget. */
  saveState(): unknown {
    return this.initialised ? structuredClone({
      initialProduction: this.initialProduction, forcedProduction: this.forcedProduction,
      buildDistribution: [...this.buildDistribution],
      variables: this.variables.toJSON(), preparedForTurn: this.preparedForTurn,
      producedCount: this.producedCount, maxDamageCheckRange: this.maxDamageCheckRange, maxSingleDamage: this.maxSingleDamage,
    }) : null;
  }

  loadState(value: unknown, _player: Player, _buildings: readonly BuildingHost[]): void {
    if (!value || typeof value !== 'object') return;
    const state = value as { initialProduction?: unknown; forcedProduction?: unknown; buildDistribution?: unknown;
      variables?: Record<string, unknown>; preparedForTurn?: string; producedCount?: number;
      maxDamageCheckRange?: number; maxSingleDamage?: number };
    const ids = (value: unknown): value is string[] => Array.isArray(value)
      && value.length < 1000 && value.every(id => typeof id === 'string');
    if (!Array.isArray(state.initialProduction) || !Array.isArray(state.forcedProduction)
      || state.initialProduction.length > 1000 || state.forcedProduction.length > 1000
      || !state.initialProduction.every(item => item && ids(item.unitIds)
        && Number.isSafeInteger(item.count) && item.count >= 0)
      || !state.forcedProduction.every(item => item && ids(item.unitIds))) return;
    // The active subset is derived from current factories by updateActive, but
    // saved weights remain in effect until the policy refreshes its topology.
    if (!Array.isArray(state.buildDistribution) || state.buildDistribution.length > 1000
      || !state.buildDistribution.every(entry => {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') return false;
        const item = entry[1];
        return item && ids(item.unitIds) && Array.isArray(item.chance)
          && item.chance.length === item.unitIds.length
          && item.chance.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0)
          && ['totalChance', 'distribution', 'maxUnitDistribution', 'buildMode'].every(key =>
            typeof item[key] === 'number' && Number.isFinite(item[key]) && item[key] >= 0)
          && item.totalChance === item.chance.reduce((sum: number, n: number) => sum + n, 0);
      }) || new Set(state.buildDistribution.map(entry => entry[0])).size !== state.buildDistribution.length) return;
    if (state.variables !== undefined && (!state.variables || typeof state.variables !== 'object' || Array.isArray(state.variables)
      || !Object.values(state.variables).every(value => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)))) return;
    if (state.preparedForTurn !== undefined && typeof state.preparedForTurn !== 'string') return;
    for (const field of ['producedCount', 'maxDamageCheckRange', 'maxSingleDamage'] as const) {
      const value = state[field];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) return;
    }
    if (!state.forcedProduction.every(item =>
      (item.targetUids === undefined || (Array.isArray(item.targetUids) && item.targetUids.every((id: unknown) => Number.isSafeInteger(id))))
      && (item.x === undefined || Number.isSafeInteger(item.x)) && (item.y === undefined || Number.isSafeInteger(item.y)))) return;
    this.variables.fromJSON(state.variables ?? {});
    this.preparedForTurn = state.preparedForTurn ?? '';
    this.producedCount = state.producedCount ?? 0;
    this.maxDamageCheckRange = state.maxDamageCheckRange ?? 10;
    this.maxSingleDamage = state.maxSingleDamage ?? 70;
    this.buildDistribution.clear();
    for (const [name, item] of structuredClone(state.buildDistribution)) this.buildDistribution.set(name, item);
    this.activeDistribution.clear();
    this.initialised = true;
    this.initialProduction = structuredClone(state.initialProduction);
    this.forcedProduction = structuredClone(state.forcedProduction);
    // Saves from the earlier table-only adapter lack policy variables. Upgrade
    // their base weights once, retaining every unfilled opening/forced purchase.
    if (state.variables === undefined && state.preparedForTurn === undefined) {
      this.buildDistribution.clear();
      this.initializePolicy(_player, false);
    }
  }

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
    for (const [name, item] of [...this.buildDistribution].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
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
      const item = this.forcedProduction[i];
      let ordered = [...buildings];
      if (item.x !== undefined && item.y !== undefined && game.map.onMap(item.x, item.y)) {
        const target = game.map.getTerrain(item.x, item.y).getBuilding();
        if (target?.getOwner() === player) ordered = [target];
      } else if (item.targetUids) {
        const targets = item.targetUids.map(uid => game.map.getUnitByUid(uid)).filter((unit): unit is Unit => unit !== null && !unit.isStealthed(player));
        const distance = (building: BuildingHost) => Math.min(...targets.map(unit =>
          Math.abs(building.getX() - unit.x) + Math.abs(building.getY() - unit.y)));
        ordered.sort((a, b) => distance(a) - distance(b));
      }
      for (const unitId of item.unitIds) {
        const action = this.buildUnit(ordered, unitId, canBuild);
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
