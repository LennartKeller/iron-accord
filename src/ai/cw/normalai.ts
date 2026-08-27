import type { Agent } from '../agent.ts';
import type { ActionDescriptor } from '../actions.ts';
import type { GameEnvironment } from '../environment.ts';
import type { Game } from '../../game/game.ts';
import type { BuildingHost, Player, Unit } from '../../host/index.ts';
import { computeMovementRange, key } from '../../game/pathfinding.ts';
import { CoreAI } from './coreai.ts';
import { ProductionSystem } from './production.ts';
import { CwAction, isRefuelUnit } from './actions.ts';
import { NORMAL_AI_DEFAULTS, type NormalAiConfig } from './config.ts';
import { InfluenceFrontMap } from './influencefrontmap.ts';
import { TargetedUnitPathFindingSystem } from './targetedpfs.ts';
import { createUnitData, sortUnitsFarFromEnemyFirst, type MoveUnitData } from './unitdata.ts';
import { getAttackTargets, getBestTarget, type MoveTargetField, type TargetScoringOptions } from './targets.ts';
import { getBestAttackTarget, type ScoringContext } from './scoring.ts';
import {
  appendTerrainBuildingAttackTargets, getClosestReachableMovePath, getMoveTargetField,
  hasTargets, moveToSafety, type Point,
} from './movement.ts';
import {
  appendCaptureTransporterTargets, appendLoadingTargets, appendNearestUnloadTargets,
  appendTransporterTargets, appendUnloadTargetsForAttacking, appendUnloadTargetsForCapturing,
} from './transport.ts';

/**
 * ai/coreai.h: CoreAI::AISteps -- the rungs of the turn, in order.
 *
 * The ladder is re-entered on every call, and a rung only runs while `aiStep`
 * has not passed it, so a turn walks steadily downward rather than reconsidering
 * everything each time.
 */
const AISteps = {
  moveUnits: 0,
  moveToTargets: 1,
  moveIndirectsToTargets: 2,
  loadUnits: 3,
  moveTransporters: 4,
  moveSupportUnits: 5,
  moveAway: 6,
  buildUnits: 7,
} as const;
// A plain object rather than an enum: the self-play workers run under node's
// strip-only TypeScript, which cannot compile enums, and this file is on their
// import path.
type AISteps = typeof AISteps[keyof typeof AISteps];

/**
 * ai/coreai.js: COREAI.highPrioBuildings.
 *
 * Hard-coded rather than read from the script, because the script cannot be
 * read: `resources/aidata/normal/__coreai.js` has a syntax error on line 3
 * (`highPrioBuildings = [...]` inside an object literal) at upstream HEAD, so
 * the whole COREAI object fails to parse and every reference to it throws. See
 * README.md -- this is upstream's shipped state, not a local problem.
 */
const HIGH_PRIO_BUILDINGS = ['FACTORY'];

/** ai/capturebuildingselector.h: one (unit, building) pairing under consideration. */
interface CaptureInfo { x: number; y: number; unitIdx: number; farAway: boolean }

export interface NormalAiOptions {
  config?: Partial<NormalAiConfig>;
  name?: string;
  /** Seeds the tie-breaking, so a match reproduces. */
  seed?: number;
}

/**
 * Commander Wars' NormalAi, ported.
 *
 * The C++ performs one action per `process()` call and is re-entered until the
 * turn ends, which is exactly the shape of `Agent.selectAction`, so the ladder
 * maps across directly: each call walks the rungs and returns the first action
 * any of them produces.
 *
 * This is the land ladder. Transport rungs (loadUnits, moveTransporters,
 * moveToUnloadArea) and the full production system are not wired in yet; their
 * substrate is ported and tested, but the rungs themselves are pending.
 */
export class NormalAi implements Agent {
  readonly name: string;
  private readonly config: NormalAiConfig;
  private core: CoreAI | null = null;
  private influence: InfluenceFrontMap | null = null;
  private ownUnits: MoveUnitData[] = [];
  private enemyUnits: MoveUnitData[] = [];
  private aiStep: number = AISteps.moveUnits;
  private aiFunctionStep = 0;
  private secondMoveRound = false;
  private rngState: number;
  /** Far-away capture targets already claimed this turn. */
  private usedFarAwayBuildings: Point[] = [];
  /**
   * Built once per game, not per turn: upstream's m_productionSystem is a
   * member of the AI, initialised at game start. Rebuilding it each turn resets
   * the opening infantry batch, and the AI then buys six more infantry every
   * single turn and never reaches the rest of the distribution.
   */
  private readonly production: ProductionSystem;
  /** Whether a unit id can leave a given factory; see canBuildHere. */
  private readonly mobility = new Map<string, boolean>();

  constructor(options: NormalAiOptions = {}) {
    this.config = { ...NORMAL_AI_DEFAULTS, ...options.config };
    this.name = options.name ?? 'normalai';
    this.rngState = (options.seed ?? 1) >>> 0 || 1;
    this.production = new ProductionSystem(() => this.random());
  }

  /** xorshift32, so tie-breaks reproduce from a seed. */
  private random(): number {
    this.rngState ^= this.rngState << 13; this.rngState >>>= 0;
    this.rngState ^= this.rngState >> 17;
    this.rngState ^= this.rngState << 5; this.rngState >>>= 0;
    return this.rngState / 0x100000000;
  }

  private randomIndex(count: number): number {
    return count <= 1 ? 0 : Math.floor(this.random() * count) % count;
  }

  beginTurn(env: GameEnvironment): void {
    const game = env.game;
    const player = game.currentPlayer;
    this.core = new CoreAI(game, player, this.config);
    this.influence = new InfluenceFrontMap(game.map, this.core.islandMaps);
    this.ownUnits = [];
    this.enemyUnits = [];
    this.aiStep = AISteps.moveUnits;
    this.aiFunctionStep = 0;
    this.secondMoveRound = false;
    this.usedFarAwayBuildings = [];

    // ai/normalai.cpp: process() sets the silo flag once per turn, before any
    // decision reads it.
    const silo = player.getSiloRockettarget(2, 3, 1, 0, null, count => this.randomIndex(count));
    this.core.missileTarget = silo.damage >= this.config.minSiloDamage;
  }

  private targetOptions(): TargetScoringOptions {
    return {
      ownUnitValue: this.config.ownUnitValue,
      buildingValue: this.config.buildingValue,
      minTerrainDamage: this.config.minTerrainDamage,
      minHpDamage: this.config.minHpDamage,
      enableNeutralTerrainAttack: this.core!.enableNeutralTerrainAttack,
    };
  }

  private context(): ScoringContext {
    return {
      ai: this.core!,
      ownUnits: this.ownUnits,
      enemyUnits: this.enemyUnits,
      influence: this.influence!,
      targetOptions: this.targetOptions(),
    };
  }

  // --- board snapshots --------------------------------------------------

  private ownBuildings(game: Game, player: Player): BuildingHost[] {
    return this.buildingsWhere(game, building => building.getOwner() === player);
  }

  private enemyBuildings(game: Game, player: Player): BuildingHost[] {
    return this.buildingsWhere(game, building => building.isEnemyBuilding(player));
  }

  private buildingsWhere(game: Game, keep: (b: BuildingHost) => boolean): BuildingHost[] {
    const found: BuildingHost[] = [];
    for (let y = 0; y < game.map.getMapHeight(); y++) {
      for (let x = 0; x < game.map.getMapWidth(); x++) {
        const building = game.map.getTerrain(x, y).getBuilding();
        if (building !== null && keep(building)) found.push(building);
      }
    }
    return found;
  }

  private enemyUnitList(player: Player): Unit[] {
    const units: Unit[] = [];
    for (let i = 0; i < player.map.getPlayerCount(); i++) {
      const other = player.map.getPlayer(i);
      if (!other || !player.isEnemy(other)) continue;
      units.push(...other.units);
    }
    return units;
  }

  /**
   * ai/normalai.cpp: NormalAi::updateAllUnitData -- rebuild the per-unit caches
   * for this decision. The C++ keeps them across a turn and patches them; here
   * they are rebuilt, which is slower but cannot go stale after an action lands.
   */
  private refresh(game: Game, player: Player): void {
    const core = this.core!;
    const own = player.units.filter(unit => unit.getHp() > 0);
    const enemies = this.enemyUnitList(player).filter(unit => unit.getHp() > 0);
    core.rebuildIsland(own);
    core.rebuildIsland(enemies);

    const previousSteps = new Map<number, number>();
    for (const data of this.ownUnits) previousSteps.set(data.unit.uid, data.nextAiStep);

    this.enemyUnits = enemies.map(unit =>
      createUnitData(unit, true, this.config.influenceUnitRange, [], this.aiFunctionStep, false));
    this.ownUnits = own.map(unit => {
      const data = createUnitData(
        unit, false, this.config.influenceUnitRange, this.enemyUnits, this.aiFunctionStep, true);
      // A unit already offered a rung this turn keeps its place in the ladder.
      const seen = previousSteps.get(unit.uid);
      if (seen !== undefined) data.nextAiStep = seen;
      return data;
    });
    sortUnitsFarFromEnemyFirst(this.ownUnits, enemies);

    const influence = this.influence!;
    influence.clear();
    influence.setOwner(player);
    influence.addBuildingInfluence();
    for (const data of [...this.ownUnits, ...this.enemyUnits]) {
      if (data.range !== null) influence.addUnitInfluence(data.unit, data.range, data.movementPoints);
    }
    influence.updateOwners();
    influence.calculateGlobalData();
  }

  // --- action construction ----------------------------------------------

  /** Is `actionId` offered to this unit at this tile? */
  private canPerform(game: Game, unit: Unit, at: Point, actionId: string): boolean {
    if (!game.select(unit.x, unit.y)) return false;
    const offered = game.availableActions(unit, at).some(option => option.id === actionId);
    game.clearSelection();
    return offered;
  }

  private unitAction(unit: Unit, actionId: string, to: Point, target?: Point): ActionDescriptor {
    return target === undefined
      ? { kind: 'unit', uid: unit.uid, actionId, to: { x: to.x, y: to.y } }
      : { kind: 'unit', uid: unit.uid, actionId, to: { x: to.x, y: to.y }, target: { x: target.x, y: target.y } };
  }

  // --- the ladder -------------------------------------------------------

  async selectAction(env: GameEnvironment): Promise<ActionDescriptor | null> {
    const game = env.game;
    const player = game.currentPlayer;
    if (this.core === null || this.core.player !== player) this.beginTurn(env);
    this.refresh(game, player);

    const buildings = this.ownBuildings(game, player);
    const enemyBuildings = this.enemyBuildings(game, player);
    const enemyUnits = this.enemyUnits.map(data => data.unit);

    // Each rung is tried in turn; the first to produce an action wins the call.
    // The bounded loop lets a rung that only advances state (returning null
    // after bumping aiStep) hand over without ending the turn prematurely.
    for (let attempt = 0; attempt < 32; attempt++) {
      const action = this.step(game, player, buildings, enemyBuildings, enemyUnits);
      if (action !== null) return action;
      if (this.aiStep > AISteps.buildUnits) break;
    }
    return null;
  }

  private step(
    game: Game, player: Player,
    buildings: BuildingHost[], enemyBuildings: BuildingHost[], enemyUnits: Unit[],
  ): ActionDescriptor | null {
    if (this.aiStep <= AISteps.moveUnits) {
      const captured = this.captureBuildings(game, enemyBuildings);
      if (captured !== null) return captured;
      // Indirects first, then directs -- artillery that has to stand still
      // wants the pick of the targets before the tanks commit.
      const joined = this.joinCaptureBuildings(game);
      if (joined !== null) return joined;
      const supported = this.moveSupport(game, AISteps.moveUnits, false);
      if (supported !== null) return supported;
      const indirect = this.fireWithUnits(
        game, 1, 2, Number.MAX_SAFE_INTEGER, buildings, enemyBuildings);
      if (indirect !== null) return indirect;
      const direct = this.fireWithUnits(game, 1, 1, 1, buildings, enemyBuildings);
      if (direct !== null) return direct;
      const repaired = this.repairUnits(game, buildings, enemyBuildings);
      if (repaired !== null) return repaired;
    }
    if (this.aiStep <= AISteps.moveToTargets) {
      const refilled = this.refillUnits(game, buildings, enemyBuildings);
      if (refilled !== null) return refilled;
    }
    if (this.aiStep <= AISteps.moveToTargets) {
      const moved = this.moveUnits(
        game, player, buildings, enemyBuildings, enemyUnits, 1, 1);
      if (moved !== null) return moved;
    }
    if (this.aiStep <= AISteps.moveIndirectsToTargets) {
      const moved = this.moveUnits(
        game, player, buildings, enemyBuildings, enemyUnits, 2, Number.MAX_SAFE_INTEGER);
      if (moved !== null) return moved;
    }
    if (this.aiStep <= AISteps.moveSupportUnits) {
      const supported = this.moveSupport(game, AISteps.moveSupportUnits, true);
      if (supported !== null) return supported;
    }
    if (this.aiStep <= AISteps.loadUnits) {
      const loaded = this.loadUnits(game, buildings, enemyBuildings);
      if (loaded !== null) return loaded;
    }
    if (this.aiStep <= AISteps.moveTransporters) {
      const ferried = this.moveTransporters(game, buildings, enemyBuildings, enemyUnits);
      if (ferried !== null) return ferried;
    }
    if (this.aiStep <= AISteps.moveAway) {
      const cleared = this.moveAwayFromProduction(game);
      if (cleared !== null) return cleared;
    }
    if (this.aiStep <= AISteps.buildUnits) {
      const built = this.buildUnits(game, player, buildings, enemyUnits);
      if (built !== null) return built;
    }
    this.aiStep = AISteps.buildUnits + 1;
    return null;
  }

  /**
   * ai/normalai.cpp: NormalAi::joinCaptureBuildings -- merge a spare capturer
   * into one that is already part-way through taking a building.
   *
   * Two half-strength soldiers capture at half speed each; one full-strength
   * soldier captures at full speed, so joining is strictly better whenever the
   * receiver is mid-capture.
   */
  private joinCaptureBuildings(game: Game): ActionDescriptor | null {
    for (const data of this.ownUnits) {
      if (data.nextAiStep > this.aiFunctionStep) continue;
      const unit = data.unit;
      data.nextAiStep++;
      if (unit.getHasMoved() || data.range === null) continue;
      if (!data.actions.includes(CwAction.CAPTURE)) continue;
      if (!data.actions.includes(CwAction.JOIN)) continue;

      for (const tile of data.range.tiles.values()) {
        if (tile.cost > data.movementPoints) continue;
        const other = game.map.getTerrain(tile.x, tile.y).getUnit();
        if (other === null || other === unit) continue;
        if (other.getCapturePoints() <= 0) continue;
        if (!this.canPerform(game, unit, tile, CwAction.JOIN)) continue;
        return this.unitAction(unit, CwAction.JOIN, tile);
      }
    }
    this.aiFunctionStep++;
    return null;
  }

  /**
   * ai/normalai.cpp: NormalAi::refillUnits -- park a supply unit where it can
   * resupply the most neighbours at once.
   */
  private refillUnits(
    game: Game, buildings: BuildingHost[], enemyBuildings: BuildingHost[],
  ): ActionDescriptor | null {
    this.aiStep = AISteps.moveToTargets;
    const core = this.core!;
    for (const data of this.ownUnits) {
      if (data.nextAiStep > this.aiFunctionStep) continue;
      const unit = data.unit;
      if (unit.getLoadedUnitCount() !== 0 || data.range === null) continue;
      if (!this.isUsingUnit(game, unit)) continue;
      if (!isRefuelUnit(data.actions)) continue;

      // The action decides how many neighbours one stop can serve: the
      // ration-for-everyone forms want a crowd, the single-target ones want one.
      const supportAll = data.actions.includes(CwAction.SUPPORTALL_RATION)
        || data.actions.includes(CwAction.SUPPORTALL_RATION_MONEY);
      const actionId = supportAll
        ? (data.actions.includes(CwAction.SUPPORTALL_RATION)
          ? CwAction.SUPPORTALL_RATION : CwAction.SUPPORTALL_RATION_MONEY)
        : [CwAction.SUPPORTSINGLE_REPAIR, CwAction.SUPPORTSINGLE_FREEREPAIR,
           CwAction.SUPPORTSINGLE_SUPPLY].find(id => data.actions.includes(id));
      if (actionId === undefined) continue;

      const best = this.bestRefillTarget(game, data, supportAll ? 4 : 1);
      if (best !== null) {
        if (!this.canPerform(game, unit, best.moveTarget, actionId)) continue;
        data.nextAiStep++;
        return supportAll
          ? this.unitAction(unit, actionId, best.moveTarget)
          : {
            kind: 'unit', uid: unit.uid, actionId,
            to: { x: best.moveTarget.x, y: best.moveTarget.y },
            steps: [{ x: best.refillTarget.x, y: best.refillTarget.y }],
          };
      }

      // Nobody in reach: walk toward whoever needs supplying.
      const targets: MoveTargetField[] = [];
      this.appendRefillTargets(core, data, targets);
      if (targets.length === 0) continue;
      data.nextAiStep++;
      const move = this.moveUnit(game, data, targets, [], buildings, enemyBuildings, true);
      if (move !== null) return move;
    }
    this.aiFunctionStep++;
    return null;
  }

  /**
   * ai/normalai.cpp: NormalAi::getBestRefillTarget -- the reachable tile with
   * the most needy neighbours, stopping early once `maxRefillCount` is met.
   */
  private bestRefillTarget(
    game: Game, data: MoveUnitData, maxRefillCount: number,
  ): { moveTarget: Point; refillTarget: Point } | null {
    const range = data.range;
    if (range === null) return null;
    const ring = [[0, -1], [1, 0], [0, 1], [-1, 0]] as Array<[number, number]>;
    let found = false;
    let moveTarget: Point | null = null;
    let refillTarget: Point | null = null;
    let highestCount = 0;

    for (const tile of range.tiles.values()) {
      if (tile.cost > data.movementPoints + 1) continue;
      if (game.map.getTerrain(tile.x, tile.y).getUnit() !== null) continue;
      let count = 0;
      let lastNeedy: Point | null = null;
      for (const [dx, dy] of ring) {
        const x = tile.x + dx, y = tile.y + dy;
        if (!game.map.onMap(x, y)) continue;
        const supply = game.map.getTerrain(x, y).getUnit();
        if (supply === null || supply.getOwner() !== this.core!.player) continue;
        if (!this.core!.needsRefuel(supply)) continue;
        count++;
        found = true;
        lastNeedy = { x, y };
        if (count === maxRefillCount) break;
      }
      if (count === maxRefillCount && lastNeedy !== null) {
        return { moveTarget: { x: tile.x, y: tile.y }, refillTarget: lastNeedy };
      }
      if (count > highestCount) {
        highestCount = count;
        moveTarget = { x: tile.x, y: tile.y };
        refillTarget = lastNeedy;
      }
    }
    if (!found || moveTarget === null) return null;
    return { moveTarget, refillTarget: refillTarget ?? moveTarget };
  }

  /** ai/normalai.cpp: NormalAi::appendRefillTargets -- tiles beside needy units. */
  private appendRefillTargets(core: CoreAI, data: MoveUnitData, targets: MoveTargetField[]): void {
    if (!isRefuelUnit(data.actions)) return;
    const unit = data.unit;
    const islandIdx = core.getIslandIndex(unit);
    const islands = core.islandMaps[islandIdx];
    const ring = [[0, -1], [1, 0], [0, 1], [-1, 0]] as Array<[number, number]>;
    for (const other of this.ownUnits) {
      if (!core.needsRefuel(other.unit)) continue;
      for (const [dx, dy] of ring) {
        const x = other.unit.getX() + dx, y = other.unit.getY() + dy;
        if (!core.map.onMap(x, y)) continue;
        if (!islands.sameIsland(unit.getX(), unit.getY(), x, y)) continue;
        if (targets.some(t => t.x === x && t.y === y && t.z === 1)) continue;
        targets.push({ x, y, z: 1 });
      }
    }
  }

  /**
   * ai/coreai_predefinedai.cpp: CoreAI::moveSupport -- move a repair or supply
   * unit next to somebody who needs it.
   *
   * Upstream builds its candidate list twice, once filtered to damaged and
   * affordable units and once unfiltered; the second pass dedupes against the
   * first, so the filter has no effect and every unit's neighbours end up in
   * the list. Transcribed as the single unfiltered pass it amounts to.
   */
  private moveSupport(game: Game, step: number, useTransporters: boolean): ActionDescriptor | null {
    this.aiStep = step;
    const ring = [[0, -1], [1, 0], [0, 1], [-1, 0]] as Array<[number, number]>;
    const unitTargets: MoveTargetField[] = [];
    const unitPos: Point[] = [];
    for (const data of this.ownUnits) {
      const unit = data.unit;
      for (const [dx, dy] of ring) {
        const x = unit.getX() + dx, y = unit.getY() + dy;
        if (!game.map.onMap(x, y)) continue;
        if (game.map.getTerrain(x, y).getUnit() !== null) continue;
        if (unitTargets.some(t => t.x === x && t.y === y && t.z === 1)) continue;
        unitTargets.push({ x, y, z: 1 });
        unitPos.push({ x: unit.getX(), y: unit.getY() });
      }
    }

    for (const data of this.ownUnits) {
      const unit = data.unit;
      if (unit.getHasMoved() || data.range === null) continue;
      if (unit.getLoadedUnitCount() !== 0) continue;
      if (unit.getLoadingPlace() !== 0 && !useTransporters) continue;

      for (const action of data.actions) {
        const single = action.startsWith(CwAction.SUPPORTSINGLE);
        if (!single && !action.startsWith(CwAction.SUPPORTALL)) continue;
        for (const tile of data.range.tiles.values()) {
          if (tile.cost > data.movementPoints) continue;
          const index = unitTargets.findIndex(t => t.x === tile.x && t.y === tile.y);
          if (index < 0) continue;
          const beneficiary = unitPos[index];
          if (beneficiary.x === unit.getX() && beneficiary.y === unit.getY()) continue;
          if (!this.canPerform(game, unit, tile, action)) continue;
          return single
            ? {
              kind: 'unit', uid: unit.uid, actionId: action,
              to: { x: tile.x, y: tile.y },
              steps: [{ x: beneficiary.x, y: beneficiary.y }],
            }
            : this.unitAction(unit, action, tile);
        }
      }
    }
    return null;
  }

  /**
   * ai/normalai.cpp: NormalAi::loadUnits -- get passengers aboard.
   *
   * Only units that carry nothing themselves board: getLoadingPlace() == 0 is
   * upstream's test for "this is cargo, not a carrier".
   */
  private loadUnits(
    game: Game, buildings: BuildingHost[], enemyBuildings: BuildingHost[],
  ): ActionDescriptor | null {
    this.aiStep = AISteps.loadUnits;
    for (const data of this.ownUnits) {
      if (data.nextAiStep > this.aiFunctionStep) continue;
      const unit = data.unit;
      data.nextAiStep++;
      if (unit.getHasMoved() || data.range === null) continue;
      if (unit.getLoadingPlace() !== 0) continue;

      const transporterTargets: MoveTargetField[] = [];
      appendTransporterTargets(unit, this.ownUnits.map(other => other.unit), transporterTargets);
      if (transporterTargets.length === 0) continue;
      const move = this.moveUnit(
        game, data, [...transporterTargets], transporterTargets, buildings, enemyBuildings, false);
      if (move !== null) return move;
    }
    this.aiFunctionStep++;
    return null;
  }

  /**
   * ai/normalai.cpp: NormalAi::moveTransporters.
   *
   * A loaded transport heads for somewhere its cargo can do something -- a
   * capture first, an attack second, and failing both simply the nearest shore
   * that reaches an enemy island. An empty one goes to pick somebody up.
   */
  private moveTransporters(
    game: Game, buildings: BuildingHost[], enemyBuildings: BuildingHost[], enemyUnits: Unit[],
  ): ActionDescriptor | null {
    this.aiStep = AISteps.moveTransporters;
    const core = this.core!;
    const ownUnits = this.ownUnits.map(other => other.unit);

    for (const data of this.ownUnits) {
      if (data.nextAiStep > this.aiFunctionStep) continue;
      const unit = data.unit;
      data.nextAiStep++;
      if (unit.getHasMoved() || data.range === null) continue;
      if (unit.getLoadingPlace() <= 0) continue;

      if (unit.getLoadedUnitCount() > 0) {
        const targets: MoveTargetField[] = [];
        const cargo = unit.getLoadedUnits();
        if (cargo.some(carried => carried.getActionList().includes(CwAction.CAPTURE))) {
          appendUnloadTargetsForCapturing(core, unit, ownUnits, enemyBuildings, targets);
        } else if (cargo.some(carried => carried.getActionList().includes(CwAction.FIRE))) {
          appendUnloadTargetsForAttacking(core, unit, enemyUnits, targets, 1);
        }
        if (targets.length === 0) appendUnloadTargetsForAttacking(core, unit, enemyUnits, targets, 3);
        if (targets.length === 0) {
          appendNearestUnloadTargets(core, unit, enemyUnits, enemyBuildings, targets);
        }
        const move = this.moveToUnloadArea(game, data, targets, buildings, enemyBuildings, enemyUnits);
        if (move !== null) return move;
      } else {
        const targets: MoveTargetField[] = [];
        core.appendCaptureTargets(data.actions, unit, enemyBuildings, targets, 1);
        const withTargets = (loadingUnit: Unit, canCapture: boolean, idx: number, island: number) =>
          hasTargets(core, unit.getMovementpoints({ x: unit.getX(), y: unit.getY() }),
            loadingUnit, canCapture, enemyUnits, enemyBuildings, idx, island, false);
        appendLoadingTargets(core, unit, ownUnits, enemyUnits, enemyBuildings,
          false, false, targets, false, 5, false, withTargets);
        if (targets.length === 0) {
          appendLoadingTargets(core, unit, ownUnits, enemyUnits, enemyBuildings,
            true, false, targets, false, 5, false, withTargets);
        }
        if (targets.length === 0) continue;
        const move = this.moveUnit(game, data, targets, [], buildings, enemyBuildings, false);
        if (move !== null) return move;
      }
    }
    this.aiFunctionStep++;
    return null;
  }

  /**
   * ai/normalai.cpp: NormalAi::moveToUnloadArea -- drive to the shore and, if
   * we have actually arrived, put somebody off.
   */
  private moveToUnloadArea(
    game: Game, data: MoveUnitData, targets: MoveTargetField[],
    buildings: BuildingHost[], enemyBuildings: BuildingHost[], enemyUnits: Unit[],
  ): ActionDescriptor | null {
    if (targets.length === 0) return null;
    const unit = data.unit;
    const pfs = new TargetedUnitPathFindingSystem(game.map, unit, targets, {
      moveCostMap: this.core!.moveCostMap,
    });
    const movepoints = unit.getMovementpoints({ x: unit.getX(), y: unit.getY() });
    const field = pfs.getReachableTargetField(movepoints);
    if (field.x < 0) return null;

    // Only unload once we are standing on the tile we were aiming for; short of
    // that, keep driving.
    const arrived = targets.some(t => t.x === field.x && t.y === field.y);
    if (arrived) {
      const unload = this.unloadUnits(game, data, field, enemyUnits);
      if (unload !== null) return unload;
    }
    return this.moveUnit(game, data, targets, targets, buildings, enemyBuildings, true);
  }

  /**
   * ai/transporterselector.cpp: choose which passenger to drop and where.
   *
   * Preference order is upstream's: a passenger with exactly one legal drop tile
   * goes first, then a capturing unit that can be put directly onto an enemy
   * building. Failing both, drop the first passenger nearest the enemy.
   */
  private unloadUnits(
    game: Game, data: MoveUnitData, at: Point, enemyUnits: Unit[],
  ): ActionDescriptor | null {
    const unit = data.unit;
    if (!this.canPerform(game, unit, at, CwAction.UNLOAD)) return null;
    const cargo = game.cargoOf(unit);
    if (cargo.length === 0) return null;

    const drops = cargo.map(entry => ({
      entry,
      fields: game.unloadTargets(unit, entry.index),
    })).filter(candidate => candidate.fields.length > 0
      && !this.core!.needsRefuel(candidate.entry.unit));
    if (drops.length === 0) return null;

    const single = drops.find(candidate => candidate.fields.length === 1);
    if (single !== undefined) {
      return this.unloadDescriptor(game, unit, at, single.entry.index, single.fields[0]);
    }
    for (const candidate of drops) {
      if (!candidate.entry.unit.getActionList().includes(CwAction.CAPTURE)) continue;
      const onBuilding = candidate.fields.find(field => {
        const building = game.map.getTerrain(field.x, field.y).getBuilding();
        return building !== null && this.core!.player.isEnemy(building.getOwner());
      });
      if (onBuilding !== undefined) {
        return this.unloadDescriptor(game, unit, at, candidate.entry.index, onBuilding);
      }
    }
    // Fallback: put the first passenger down as close to the enemy as we can.
    const first = drops[0];
    let best = first.fields[0], bestDistance = Number.MAX_SAFE_INTEGER;
    for (const field of first.fields) {
      let nearest = Number.MAX_SAFE_INTEGER;
      for (const enemy of enemyUnits) {
        const distance = Math.abs(field.x - enemy.getX()) + Math.abs(field.y - enemy.getY());
        if (distance < nearest) nearest = distance;
      }
      if (nearest < bestDistance) { bestDistance = nearest; best = field; }
    }
    return this.unloadDescriptor(game, unit, at, first.entry.index, best);
  }

  /**
   * ACTION_UNLOAD as a descriptor.
   *
   * With one passenger the action goes straight to picking a tile; with several
   * it asks which passenger first, so the step list is one longer.
   */
  private unloadDescriptor(
    game: Game, unit: Unit, at: Point, cargoIndex: number, field: Point,
  ): ActionDescriptor | null {
    const probe = game.probeAction(CwAction.UNLOAD, unit, at);
    if (probe.kind === 'field') {
      return {
        kind: 'unit', uid: unit.uid, actionId: CwAction.UNLOAD,
        to: { x: at.x, y: at.y }, steps: [{ x: field.x, y: field.y }],
      };
    }
    if (probe.kind === 'menu') {
      const entry = probe.entries[cargoIndex] ?? probe.entries[0];
      if (entry === undefined) return null;
      return {
        kind: 'unit', uid: unit.uid, actionId: CwAction.UNLOAD,
        to: { x: at.x, y: at.y }, steps: [entry.actionID, { x: field.x, y: field.y }],
      };
    }
    return null;
  }

  /**
   * ai/coreai.cpp: CoreAI::moveAwayFromProduction -- get idle units off our own
   * factories.
   *
   * A unit that sat out the turn on a production building blocks it for the
   * rest of the game, which is one half of how the piperunner stalemate
   * happened: something unable to leave, parked where units come out. The other
   * half is refusing to build such a unit at all, which the production rung
   * handles.
   */
  private moveAwayFromProduction(game: Game): ActionDescriptor | null {
    this.aiStep = AISteps.moveAway;
    for (const data of this.ownUnits) {
      const unit = data.unit;
      if (unit.getHasMoved() || data.range === null) continue;
      const terrain = unit.getTerrain();
      if (terrain === null) continue;
      const building = terrain.getBuilding();
      const owner = building?.getOwner() ?? null;
      const onProduction = building !== null && !this.core!.player.isEnemy(owner)
        && building.isProductionBuilding();
      if (!onProduction) continue;

      for (const tile of data.range.tiles.values()) {
        if (tile.cost <= 0 || tile.cost > data.movementPoints) continue;
        if (!tile.canStop) continue;
        const newTerrain = game.map.getTerrain(tile.x, tile.y);
        if (newTerrain.getUnit() !== null) continue;
        const newBuilding = newTerrain.getBuilding();
        if (newBuilding !== null && newBuilding.isProductionBuilding()) continue;
        if (!this.canPerform(game, unit, tile, CwAction.WAIT)) continue;
        return this.unitAction(unit, CwAction.WAIT, tile);
      }
    }
    return null;
  }

  /**
   * ai/normalai.cpp: NormalAi::buildUnits, through the ported production system.
   *
   * The system buys toward a target army composition rather than picking a
   * favourite unit, so what to buy depends on what is already fielded. A unit
   * that could not leave the factory is refused outright -- that check is the
   * one whose absence produced the piperunner stalemate.
   */
  private buildUnits(
    game: Game, player: Player, buildings: BuildingHost[], _enemyUnits: Unit[],
  ): ActionDescriptor | null {
    const production = this.production;
    const owned = buildings.filter(building => building.getOwner() === player);
    if (!production.ready) production.initialize(player, owned);
    production.updateActive(owned);

    const action = production.buildNextUnit(
      game, player, owned, player.units,
      (at, unitId) => this.canBuildHere(game, player, at, unitId));
    if (action === null) this.aiStep = AISteps.buildUnits + 1;
    return action;
  }

  /** Affordable, offered by this factory, and able to actually leave it. */
  private canBuildHere(game: Game, player: Player, at: Point, unitId: string): boolean {
    if (!game.canProduceAt(at.x, at.y)) return false;
    const building = game.map.getTerrain(at.x, at.y).getBuilding();
    if (building === null) return false;
    if (!game.buildOptions(building).some(o => o.id === unitId && o.affordable)) return false;

    const map = game.map;
    const cacheKey = `${unitId}@${at.x},${at.y}`;
    const cached = this.mobility.get(cacheKey);
    if (cached !== undefined) return cached;
    // A probe consumes a uid, and a uid the real game never issued
    // desynchronises every later action, so the counter is rewound.
    const uidBefore = map.getUnitUidCounter();
    const probe = map.addUnit(unitId, player, at.x, at.y);
    const mobile = computeMovementRange(map, probe).tiles.size > 1;
    map.removeUnit(probe);
    map.setUnitUidCounter(uidBefore);
    this.mobility.set(cacheKey, mobile);
    return mobile;
  }

  /**
   * ai/capturebuildingselector.cpp: the capture rung.
   *
   * The assignment matters more than the priority. Every unit picking the
   * highest-value building independently piles the whole army onto one tile and
   * nothing ever gets captured, which is exactly what findSingleCaptureBuilding
   * exists to prevent: a building only one unit can reach is claimed by that
   * unit first, so the rest spread out to what is left.
   */
  private captureBuildings(game: Game, enemyBuildings: BuildingHost[]): ActionDescriptor | null {
    const candidates = this.captureCandidates(game);

    for (let i = 0; i < this.ownUnits.length; i++) {
      const data = this.ownUnits[i];
      if (data.nextAiStep > this.aiFunctionStep) continue;
      const unit = data.unit;
      if (unit.getHasMoved() || data.range === null) continue;
      if (!data.actions.includes(CwAction.CAPTURE)) continue;

      // Part-way through a capture where it stands: finish the job.
      const here = { x: unit.getX(), y: unit.getY() };
      if (unit.getCapturePoints() > 0 && this.canPerform(game, unit, here, CwAction.CAPTURE)) {
        data.nextAiStep++;
        return this.unitAction(unit, CwAction.CAPTURE, here);
      }

      const mine = candidates.filter(entry => entry.unitIdx === i);
      if (mine.length === 0) continue;
      const chosen = this.pickCaptureTarget(game, candidates, mine);
      if (chosen === null) continue;
      data.nextAiStep++;

      if (!chosen.farAway) {
        if (this.canPerform(game, unit, chosen, CwAction.CAPTURE)) {
          return this.unitAction(unit, CwAction.CAPTURE, chosen);
        }
        if (this.canPerform(game, unit, chosen, CwAction.MISSILE)) {
          const silo = this.core!.player.getSiloRockettarget(
            2, 3, 1, 0, null, count => this.randomIndex(count));
          if (silo.x >= 0) {
            return {
              kind: 'unit', uid: unit.uid, actionId: CwAction.MISSILE,
              to: { x: chosen.x, y: chosen.y }, steps: [{ x: silo.x, y: silo.y }],
            };
          }
        }
        continue;
      }
      // Out of reach this turn: walk toward it and claim it so nobody else does.
      const move = this.walkToward(game, data, chosen, [], enemyBuildings);
      if (move !== null) {
        this.usedFarAwayBuildings.push({ x: chosen.x, y: chosen.y });
        return move;
      }
    }
    this.aiFunctionStep++;
    return null;
  }

  /**
   * ai/capturebuildingselector.cpp: getTargetBuildings -- every (unit, building)
   * pair worth considering this turn, tagged with whether it is in reach.
   */
  private captureCandidates(game: Game): CaptureInfo[] {
    const found: CaptureInfo[] = [];
    for (let i = 0; i < this.ownUnits.length; i++) {
      const data = this.ownUnits[i];
      if (data.nextAiStep > this.aiFunctionStep) continue;
      const unit = data.unit;
      if (unit.getHasMoved() || data.range === null) continue;
      if (!data.actions.includes(CwAction.CAPTURE)) continue;

      for (const tile of data.range.tiles.values()) {
        const building = game.map.getTerrain(tile.x, tile.y).getBuilding();
        if (building === null) continue;
        if (tile.cost < data.movementPoints + 1) {
          if (!tile.canStop) continue;
          if (this.canPerform(game, unit, tile, CwAction.CAPTURE)
            || (this.core!.missileTarget && this.canPerform(game, unit, tile, CwAction.MISSILE))) {
            found.push({ x: tile.x, y: tile.y, unitIdx: i, farAway: false });
          }
        } else if (building.getOwner() === null
          && HIGH_PRIO_BUILDINGS.includes(building.getBuildingID())
          && game.map.getTerrain(tile.x, tile.y).getUnit() === null
          && !this.usedFarAwayBuildings.some(used => used.x === tile.x && used.y === tile.y)) {
          found.push({ x: tile.x, y: tile.y, unitIdx: i, farAway: true });
        }
      }
    }
    return found;
  }

  /**
   * ai/capturebuildingselector.cpp: getNextTarget / findSingleCaptureBuilding.
   *
   * Prefer a building this unit is the only claimant for, or a production
   * building; failing that, take the highest priority on offer.
   */
  private pickCaptureTarget(
    game: Game, all: CaptureInfo[], mine: CaptureInfo[],
  ): CaptureInfo | null {
    if (mine.length === 0) return null;
    if (mine.length === 1) return mine[0];

    let best: CaptureInfo | null = null;
    let bestPrio = -Infinity;
    const remaining: CaptureInfo[] = [];
    for (const candidate of mine) {
      // How many units want this tile, with a far-away claim counting against.
      let claimants = 0;
      for (const other of all) {
        if (other.x !== candidate.x || other.y !== candidate.y) continue;
        const compatible = other.farAway === candidate.farAway
          || (other.farAway && !candidate.farAway);
        claimants += compatible ? 1 : -1;
      }
      if (claimants <= 0) continue;
      remaining.push(candidate);

      const building = game.map.getTerrain(candidate.x, candidate.y).getBuilding();
      if (building === null) continue;
      const isProduction = building.isProductionBuilding();
      if (claimants === 1 || isProduction) {
        let prio = this.capturePriority(building, candidate.farAway);
        if (isProduction && claimants === 1) prio += 1;
        if (best === null || prio > bestPrio) { best = candidate; bestPrio = prio; }
      }
    }
    if (best !== null) return best;

    // Nothing uniquely ours: fall back to the best available by priority.
    let fallback: CaptureInfo | null = null;
    let fallbackPrio = -Infinity;
    for (const candidate of remaining.length > 0 ? remaining : mine) {
      const building = game.map.getTerrain(candidate.x, candidate.y).getBuilding();
      if (building === null) continue;
      const prio = this.capturePriority(building, candidate.farAway);
      if (fallback === null || prio > fallbackPrio) { fallback = candidate; fallbackPrio = prio; }
    }
    return fallback;
  }

  /** ai/capturebuildingselector.cpp: CaptureBuildingSelector::getPrio. */
  private capturePriority(building: BuildingHost, farAway: boolean): number {
    const NEARBY_BONUS = 2048, ENEMY_OWNED_BONUS = 1;
    if (building.isHq()) return Number.MAX_SAFE_INTEGER;
    let prio = -Number.MAX_SAFE_INTEGER;
    if (building.isProductionBuilding()) prio = building.getConstructionList().length;
    if (building.isEnemyBuilding(this.core!.player)) prio += ENEMY_OWNED_BONUS;
    if (!farAway && prio > 0) prio += NEARBY_BONUS;
    return prio;
  }

  /**
   * ai/normalai.cpp: NormalAi::fireWithUnits -- attack with everything whose
   * range falls in the given band, best trade first.
   */
  private fireWithUnits(
    game: Game, minFireRange: number, minMaxFireRange: number, maxFireRange: number,
    buildings: BuildingHost[], enemyBuildings: BuildingHost[],
  ): ActionDescriptor | null {
    const context = this.context();
    for (const data of this.ownUnits) {
      if (data.nextAiStep > this.aiFunctionStep) continue;
      const unit = data.unit;
      data.nextAiStep++;
      if (unit.getHasMoved() || data.range === null) continue;
      if (this.core!.needsRefuel(unit) && unit.getFuel() !== 0) continue;
      if (data.minFireRange < minFireRange) continue;
      if (data.maxFireRange < minMaxFireRange || data.maxFireRange > maxFireRange) continue;
      if (unit.getAmmo1() === 0 && unit.getAmmo2() === 0) continue;
      if (!data.actions.includes(CwAction.FIRE)) continue;

      const { targets, moveTargetFields } = getAttackTargets(
        game, this.core!.predictor, unit, data.range, this.targetOptions(),
        data.movementPoints + 1);
      const index = getBestAttackTarget(
        context, data, targets, moveTargetFields, buildings, enemyBuildings);
      if (index < 0) continue;

      const from = moveTargetFields[index];
      const target = targets[index];
      if (!this.canPerform(game, unit, from, CwAction.FIRE)) continue;
      return this.unitAction(unit, CwAction.FIRE, from, target);
    }
    this.aiFunctionStep++;
    return null;
  }

  /**
   * ai/normalai.cpp: NormalAi::repairUnits -- send anything too hurt to be
   * useful back to a building that will heal it.
   */
  private repairUnits(
    game: Game, buildings: BuildingHost[], enemyBuildings: BuildingHost[],
  ): ActionDescriptor | null {
    for (const data of this.ownUnits) {
      if (data.nextAiStep > this.aiFunctionStep) continue;
      const unit = data.unit;
      data.nextAiStep++;
      if (unit.getHasMoved() || data.range === null) continue;
      if (this.isUsingUnit(game, unit)) continue;

      const targets: MoveTargetField[] = [];
      this.core!.appendRepairTargets(unit, buildings, targets);
      if (this.core!.needsRefuel(unit)) {
        appendTransporterTargets(unit, this.ownUnits.map(other => other.unit), targets);
      }
      if (targets.length === 0) continue;
      const move = this.moveUnit(game, data, targets, [], buildings, enemyBuildings, false);
      if (move !== null) return move;
    }
    this.aiFunctionStep++;
    return null;
  }

  /**
   * ai/normalai.cpp: NormalAi::isUsingUnit -- is this unit healthy enough to be
   * worth committing, or should it go and repair?
   */
  private isUsingUnit(game: Game, unit: Unit): boolean {
    if (this.core!.needsRefuel(unit)) return false;
    if (game.map.onMap(unit.getX(), unit.getY())) {
      const building = game.map.getTerrain(unit.getX(), unit.getY()).getBuilding();
      if (building === null && unit.getHpRounded() <= this.config.minUnitHealth) return false;
      if (building !== null && building.getOwner() === this.core!.player
        && unit.getHpRounded() <= this.config.maxUnitHealth) return false;
    }
    return !unit.getHasMoved();
  }

  /**
   * ai/normalai.cpp: NormalAi::moveUnits -- advance everything in the given
   * range band toward whatever is worth reaching.
   */
  private moveUnits(
    game: Game, player: Player, buildings: BuildingHost[], enemyBuildings: BuildingHost[],
    enemyUnits: Unit[], minFireRange: number, maxFireRange: number,
  ): ActionDescriptor | null {
    const core = this.core!;
    const AVERAGE_TRANSPORTER_MOVEMENT = 7;
    for (const data of this.ownUnits) {
      if (data.nextAiStep > this.aiFunctionStep) continue;
      const unit = data.unit;
      data.nextAiStep++;
      if (unit.getHasMoved() || data.range === null) continue;
      if (unit.getBaseMaxRange() < minFireRange || unit.getBaseMaxRange() > maxFireRange) continue;
      if (!unit.hasWeapons() || unit.getLoadedUnitCount() !== 0) continue;

      const canCapture = data.actions.includes(CwAction.CAPTURE);
      const loadingIslandIdx = core.getIslandIndex(unit);
      const loadingIsland = core.getIsland(unit);
      if (!this.isUsingUnit(game, unit)) continue;
      if (!hasTargets(core, AVERAGE_TRANSPORTER_MOVEMENT, unit, canCapture,
        enemyUnits, enemyBuildings, loadingIslandIdx, loadingIsland, false)) continue;

      const targets: MoveTargetField[] = [];
      const transporterTargets: MoveTargetField[] = [];
      let distanceModifier = 1;
      core.appendCaptureTargets(data.actions, unit, enemyBuildings, targets, distanceModifier);
      if (targets.length > 0) {
        distanceModifier = 4;
        appendCaptureTransporterTargets(
          core, unit, this.ownUnits.map(other => other.unit), enemyBuildings,
          transporterTargets, distanceModifier);
        distanceModifier = 5;
        targets.unshift(...transporterTargets);
      }
      core.appendAttackTargets(unit, enemyUnits, targets, distanceModifier);
      core.appendAttackTargetsIgnoreOwnUnits(unit, enemyUnits, targets, distanceModifier);
      appendTerrainBuildingAttackTargets(core, unit, enemyBuildings, targets, distanceModifier);
      if (targets.length === 0) core.appendRepairTargets(unit, buildings, targets);
      if (targets.length === 0 && transporterTargets.length === 0) continue;

      const move = this.moveUnit(
        game, data, targets, transporterTargets, buildings, enemyBuildings, true);
      if (move !== null) return move;
    }
    if (!this.secondMoveRound) {
      this.secondMoveRound = true;
      this.aiStep = AISteps.moveUnits;
    } else {
      this.aiStep = AISteps.moveIndirectsToTargets;
    }
    this.aiFunctionStep++;
    return null;
  }

  /**
   * ai/normalai.cpp: NormalAi::moveUnit -- turn a set of wanted tiles into one
   * concrete move, and attack from wherever it lands if that is worthwhile.
   */
  private moveUnit(
    game: Game, data: MoveUnitData, targets: MoveTargetField[], transporterTargets: MoveTargetField[],
    buildings: BuildingHost[], enemyBuildings: BuildingHost[], shortenPathForTarget: boolean,
  ): ActionDescriptor | null {
    if (targets.length === 0) return null;
    const core = this.core!;
    const unit = data.unit;
    const range = data.range;
    if (range === null) return null;

    const pfs = new TargetedUnitPathFindingSystem(game.map, unit, targets, {
      moveCostMap: core.moveCostMap,
    });
    const targetField = pfs.getReachableTargetField(data.movementPoints);
    if (targetField.x < 0) return null;

    const targetUnit = game.map.getTerrain(targetField.x, targetField.y).getUnit();
    const wantsTransport = transporterTargets.some(
      t => t.x === targetField.x && t.y === targetField.y);
    if (wantsTransport && targetUnit !== null && !targetUnit.getHasMoved()
      && this.canPerform(game, unit, targetField, CwAction.LOAD)) {
      return this.unitAction(unit, CwAction.LOAD, targetField);
    }

    const wantsExactTile = targets.some(t => t.x === targetField.x && t.y === targetField.y);
    if (!shortenPathForTarget && wantsExactTile) {
      const path = getClosestReachableMovePath(core, unit, range, targetField, data.movementPoints);
      const stop = path.length > 0 ? path[0] : { x: unit.getX(), y: unit.getY() };
      if (data.actions.includes(CwAction.CAPTURE)
        && this.canPerform(game, unit, stop, CwAction.CAPTURE)) {
        return this.unitAction(unit, CwAction.CAPTURE, stop);
      }
      if (this.canPerform(game, unit, stop, CwAction.WAIT)) {
        return this.unitAction(unit, CwAction.WAIT, stop);
      }
      return null;
    }

    return this.walkToward(game, data, targetField, buildings, enemyBuildings);
  }

  /**
   * The general "go that way" move: pick how far along the route is safe, fall
   * back to the least dangerous tile in reach, then attack from wherever we end
   * up if there is anything worth shooting.
   */
  private walkToward(
    game: Game, data: MoveUnitData, target: Point,
    buildings: BuildingHost[], enemyBuildings: BuildingHost[],
  ): ActionDescriptor | null {
    const core = this.core!;
    const context = this.context();
    const unit = data.unit;
    const range = data.range!;

    let movePath = getClosestReachableMovePath(core, unit, range, target, data.movementPoints);
    if (movePath.length === 0) movePath = [{ x: unit.getX(), y: unit.getY(), cost: 0, canStop: true, canAct: true }];

    const idx = getMoveTargetField(
      context, data, movePath, buildings, enemyBuildings, data.movementPoints);
    let stop: Point;
    if (idx < 0 || idx === movePath.length - 1) {
      const safety = moveToSafety(
        context, data, movePath[0], buildings, enemyBuildings, data.movementPoints);
      stop = safety.point;
      const stuck = (stop.x === unit.getX() && stop.y === unit.getY())
        || safety.leastDamage > unit.getCoUnitValue() / 2 || safety.allEqual;
      if (stuck && safety.leastDamage > 0) {
        // Nowhere is safe, so trade rather than sit and be shot for free.
        const desperate = this.suicide(game, data);
        if (desperate !== null) return desperate;
      }
    } else {
      stop = movePath[idx];
    }

    if (!range.tiles.has(key(stop.x, stop.y))) return null;
    const stayedPut = stop.x === unit.getX() && stop.y === unit.getY();

    // Attack from where we landed, if we can still shoot after moving.
    if (unit.canMoveAndFire(stop) || stayedPut) {
      const shot = this.bestShotFrom(game, data, stop);
      if (shot !== null) return shot;
    }
    if (data.actions.includes(CwAction.CAPTURE)
      && this.canPerform(game, unit, stop, CwAction.CAPTURE)) {
      return this.unitAction(unit, CwAction.CAPTURE, stop);
    }
    if (this.canPerform(game, unit, stop, CwAction.WAIT)) {
      return this.unitAction(unit, CwAction.WAIT, stop);
    }
    return null;
  }

  /** The best attack available from one tile, if it clears the suicide floor. */
  private bestShotFrom(game: Game, data: MoveUnitData, from: Point): ActionDescriptor | null {
    const unit = data.unit;
    if (!this.canPerform(game, unit, from, CwAction.FIRE)) return null;
    const options = this.targetOptions();
    const best: MoveTargetField[] = [];
    for (const target of game.attackTargets(unit, from)) {
      const damage = this.core!.predictor.calcVirtualUnitDamage(
        unit, 0, from, target.unit, 0, target);
      const score = target.unit !== null
        ? damage.x
        : damage.x * options.buildingValue;
      if (best.length === 0 || score > best[0].z) { best.length = 0; }
      else if (score !== best[0].z) continue;
      best.push({ x: target.x, y: target.y, z: score });
    }
    if (best.length === 0) return null;
    if (best[0].z < -unit.getCoUnitValue() * this.config.minSuicideDamage) return null;
    const pick = best[this.randomIndex(best.length)];
    return this.unitAction(unit, CwAction.FIRE, from, pick);
  }

  /**
   * ai/normalai.cpp: NormalAi::suicide -- when there is no safe square, take
   * the best attack going rather than stand and be shot for nothing.
   */
  private suicide(game: Game, data: MoveUnitData): ActionDescriptor | null {
    const unit = data.unit;
    if (data.range === null) return null;
    const { targets, moveTargetFields } = getBestTarget(
      game, this.core!.predictor, unit, data.range, this.targetOptions(),
      data.movementPoints + 1);
    if (targets.length === 0) return null;
    if (targets[0].z < -unit.getCoUnitValue() * this.config.minSuicideDamage) return null;
    const pick = this.randomIndex(targets.length);
    const from = moveTargetFields[pick];
    if (!this.canPerform(game, unit, from, CwAction.FIRE)) return null;
    return this.unitAction(unit, CwAction.FIRE, from, targets[pick]);
  }
}
