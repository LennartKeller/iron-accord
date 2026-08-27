import type { Game } from '../../game/game.ts';
import { GameEnums, type BuildingHost, type GameMap, type Player, type Terrain, type Unit } from '../../host/index.ts';
import type { MovementRange } from '../../game/pathfinding.ts';
import { key } from '../../game/pathfinding.ts';
import { getCircle } from '../../host/globals.ts';
import { IslandMap } from './islandmap.ts';
import { DamagePredictor } from './damage.ts';
import { CwAction } from './actions.ts';
import type { NormalAiConfig } from './config.ts';
import type { MoveTargetField } from './targets.ts';

/**
 * ai/coreai.cpp: the state and helpers every Commander Wars AI shares.
 *
 * NormalAi is the only subclass this project cares about, so this holds what
 * NormalAi actually reaches for: the island maps, the damage predictor, the
 * cannon-danger overlay, and the family of `append*Targets` methods that answer
 * "where might this unit usefully go".
 *
 * Not ported: CO powers and CO units (absent by design here), save-game
 * serialisation, the flare/Oozium/black-bomb branches, and the predefined AI
 * modes in coreai_predefinedai.cpp, which only run for units a map author has
 * given an explicit AiMode -- none of ours do.
 */
export class CoreAI {
  readonly map: GameMap;
  readonly predictor: DamagePredictor;
  /** One per movement type, built lazily as units ask about their own. */
  readonly islandMaps: IslandMap[] = [];
  /**
   * ai/coreai.cpp: m_MoveCostMap -- extra movement cost on tiles a hostile
   * cannon building covers. Zero everywhere on maps without one.
   */
  readonly moveCostMap: Int32Array;
  /** Whether a silo strike is currently worth taking, set once per turn. */
  missileTarget = false;
  /** Whether neutral structures may be shot at; upstream reads it from rules. */
  enableNeutralTerrainAttack = false;

  constructor(
    readonly game: Game,
    readonly player: Player,
    readonly config: NormalAiConfig,
  ) {
    this.map = game.map;
    this.predictor = new DamagePredictor(this.map);
    this.moveCostMap = new Int32Array(this.map.getMapWidth() * this.map.getMapHeight());
  }

  // --- islands ----------------------------------------------------------

  /**
   * ai/coreai.cpp: CoreAI::createIslandMap -- one island map per movement type,
   * built on demand. Note the C++ matches on movement type but constructs from
   * the unit id, leaving the constructor to re-derive the type; same result.
   */
  createIslandMap(movementType: string, unitID: string): number {
    for (let i = 0; i < this.islandMaps.length; i++) {
      if (this.islandMaps[i].getMovementType() === movementType) return i;
    }
    this.islandMaps.push(new IslandMap(this.map, unitID, this.player));
    return this.islandMaps.length - 1;
  }

  /** ai/coreai.cpp: CoreAI::getIslandIndex. */
  getIslandIndex(unit: Unit): number {
    return this.createIslandMap(unit.getMovementType(), unit.getUnitID());
  }

  /**
   * ai/coreai.cpp: CoreAI::getIsland -- which island this unit is standing on.
   *
   * Upstream's fallback path, taken when no island map for the movement type
   * exists yet, returns the new map's *index* rather than the island at the
   * unit's position. Reproduced: callers compare the result against other
   * getIsland results, so a wrong value there is not inert, and correcting it
   * would change behaviour the tuning was fitted around.
   */
  getIsland(unit: Unit): number {
    const movementType = unit.getMovementType();
    for (const island of this.islandMaps) {
      if (island.getMovementType() === movementType) {
        return island.getIsland(unit.getX(), unit.getY());
      }
    }
    this.islandMaps.push(new IslandMap(this.map, unit.getUnitID(), this.player));
    return this.islandMaps.length - 1;
  }

  /**
   * ai/coreai.cpp: CoreAI::rebuildIsland -- make sure every movement type in
   * play, including cargo and anything buildable, has an island map.
   */
  rebuildIsland(units: readonly Unit[]): void {
    for (const unit of units) {
      this.getIslandIndex(unit);
      for (const loaded of unit.getLoadedUnits()) this.getIslandIndex(loaded);
    }
    for (const unitId of this.player.getBuildList()) {
      this.createIslandMap(this.map.movementTypeOfId(unitId), unitId);
    }
  }

  /**
   * ai/coreai.cpp: CoreAI::onSameIsland -- can the first unit walk to where the
   * second thing is? Deliberately asymmetric: it is the *first* unit's movement
   * type that decides, so a ship and a soldier disagree about the same pair.
   */
  onSameIsland(unit: Unit, x: number, y: number): boolean {
    const movementType = unit.getMovementType();
    for (const island of this.islandMaps) {
      if (island.getMovementType() !== movementType) continue;
      return island.getIsland(unit.getX(), unit.getY()) === island.getIsland(x, y);
    }
    return false;
  }

  onSameIslandAs(unit: Unit, other: Unit | BuildingHost): boolean {
    return this.onSameIsland(unit, other.getX(), other.getY());
  }

  // --- small predicates -------------------------------------------------

  /** ai/coreai.cpp: CoreAI::needsRefuel -- low on fuel or on ammo it can use. */
  needsRefuel(unit: Unit): boolean {
    const { fuelResupply, ammoResupply } = this.config;
    if (unit.getMaxFuel() > 0 && unit.getFuel() <= fuelResupply * unit.getMaxFuel()) return true;
    if (unit.getMaxAmmo1() > 0 && unit.getAmmo1() <= ammoResupply * unit.getMaxAmmo1()
      && unit.getWeapon1ID() !== '') return true;
    if (unit.getMaxAmmo2() > 0 && unit.getAmmo2() <= ammoResupply * unit.getMaxAmmo2()
      && unit.getWeapon2ID() !== '') return true;
    return false;
  }

  /**
   * ai/coreai.cpp: CoreAI::isMoveableTile -- may a unit settle here, or is it a
   * factory it would be blocking? Only our own reachable production buildings
   * are off limits; standing on one is how a factory ends up unable to build,
   * which is exactly the stalemate this port is meant to help avoid.
   */
  isMoveableTile(building: BuildingHost | null, range: MovementRange): boolean {
    if (building === null) return true;
    const owner = building.getOwner();
    if (owner === null || owner.isEnemy(this.player)) return true;
    const reachable = range.tiles.has(key(building.getX(), building.getY()));
    return !reachable || !building.isProductionBuilding();
  }

  /** ai/coreai.cpp: CoreAI::isLoadingTerrain -- asks the ACTION_LOAD script. */
  isLoadingTerrain(transporter: Unit, terrain: Terrain): boolean {
    try {
      return this.map.registry.ACTION_LOAD?.isLoadingTerrain?.(transporter, terrain) === true;
    } catch { return false; /* script gap */ }
  }

  /** ai/coreai.cpp: CoreAI::isUnloadTerrain -- asks the ACTION_UNLOAD script. */
  isUnloadTerrain(unit: Unit, terrain: Terrain): boolean {
    try {
      return this.map.registry.ACTION_UNLOAD?.isUnloadTerrain?.(unit, terrain) === true;
    } catch { return false; /* script gap */ }
  }

  // --- where to go ------------------------------------------------------

  /**
   * ai/coreai.cpp: CoreAI::appendCaptureTargets -- unoccupied enemy or neutral
   * buildings this unit could take, plus silos when one is worth firing.
   */
  appendCaptureTargets(
    actions: readonly string[], unit: Unit, enemyBuildings: readonly BuildingHost[],
    targets: MoveTargetField[], distanceModifier: number,
  ): void {
    if (!actions.includes(CwAction.CAPTURE) && !actions.includes(CwAction.MISSILE)) return;
    for (const building of enemyBuildings) {
      const x = building.getX(), y = building.getY();
      if (!unit.canMoveOver(x, y)) continue;
      if (!building.isCaptureOrMissileBuilding(this.missileTarget)) continue;
      if (building.getTerrain()?.getUnit() != null) continue;
      targets.push({ x, y, z: distanceModifier });
    }
  }

  /**
   * ai/coreai.cpp: CoreAI::appendAttackTargets -- the empty tiles from which
   * this unit could shoot an enemy, at exactly its maximum range.
   *
   * A hidden enemy adds a malus so the AI is drawn to it less strongly; the
   * malus is halved when terrain rather than a status is doing the hiding.
   */
  appendAttackTargets(
    unit: Unit, enemyUnits: readonly Unit[], targets: MoveTargetField[], distanceModifier: number,
  ): void {
    const fireRange = unit.getMaxRange({ x: unit.getX(), y: unit.getY() });
    const ring = getCircle(fireRange, fireRange);
    for (const enemy of enemyUnits) {
      if (!unit.isAttackable(enemy, true)) continue;
      for (const offset of ring) {
        const x = offset.x + enemy.getX(), y = offset.y + enemy.getY();
        if (!this.map.onMap(x, y)) continue;
        if (this.map.getTerrain(x, y).getUnit() !== null) continue;
        if (!unit.canMoveOver(x, y)) continue;
        const { hidden, terrainHide } = enemy.isStatusStealthedAndInvisible(this.player);
        const stealthMalus = hidden ? (terrainHide ? 2 : 4) : 0;
        pushUnique(targets, { x, y, z: distanceModifier + stealthMalus });
      }
    }
  }

  /**
   * ai/coreai.cpp: CoreAI::appendAttackTargetsIgnoreOwnUnits -- the same firing
   * positions, but the ones currently held by a friendly unit.
   *
   * These come with a flat +4 on top, so they rank below a free tile: the unit
   * still has to wait for the friend to move first.
   */
  appendAttackTargetsIgnoreOwnUnits(
    unit: Unit, enemyUnits: readonly Unit[], targets: MoveTargetField[], distanceModifier: number,
  ): void {
    const fireRange = unit.getMaxRange({ x: unit.getX(), y: unit.getY() });
    const ring = getCircle(fireRange, fireRange);
    for (const enemy of enemyUnits) {
      if (!unit.isAttackable(enemy, true)) continue;
      for (const offset of ring) {
        const x = offset.x + enemy.getX(), y = offset.y + enemy.getY();
        if (!this.map.onMap(x, y)) continue;
        const occupant = this.map.getTerrain(x, y).getUnit();
        if (!unit.canMoveOver(x, y) || occupant === null) continue;
        if (occupant.getOwner().checkAlliance(this.player) !== GameEnums.Alliance_Friend) continue;
        const { hidden, terrainHide } = enemy.isStatusStealthedAndInvisible(this.player);
        const stealthMalus = hidden ? (terrainHide ? 3 : 6) : 0;
        pushUnique(targets, { x, y, z: 4 + distanceModifier + stealthMalus });
      }
    }
  }

  /** ai/coreai.cpp: CoreAI::appendRepairTargets -- free buildings that heal us. */
  appendRepairTargets(
    unit: Unit, buildings: readonly BuildingHost[], targets: MoveTargetField[],
  ): void {
    for (const building of buildings) {
      const x = building.getX(), y = building.getY();
      if (this.map.getTerrain(x, y).getUnit() !== null) continue;
      if (!building.canRepair(unit)) continue;
      targets.push({ x, y, z: 1 });
    }
  }

  /**
   * ai/coreai.cpp: CoreAI::appendSupplyTargets -- friendly units under half on
   * ammo or fuel, for a supply truck to drive to.
   */
  appendSupplyTargets(unit: Unit, units: readonly Unit[], targets: MoveTargetField[]): void {
    for (const other of units) {
      if (other === unit) continue;
      const lowAmmo1 = other.hasAmmo1() && other.getAmmo1() / other.getMaxAmmo1() < 0.5;
      const lowAmmo2 = other.hasAmmo2() && other.getAmmo2() / other.getMaxAmmo2() < 0.5;
      const lowFuel = other.getMaxFuel() > 0 && other.getFuel() / other.getMaxFuel() < 0.5;
      if (lowAmmo1 || lowAmmo2 || lowFuel) {
        targets.push({ x: other.getX(), y: other.getY(), z: 1 });
      }
    }
  }
}

/**
 * ai/coreai.cpp: GlobalUtils::contains over the target list.
 *
 * The comparison includes the weight, so the same tile really can appear twice
 * with two different weights -- that is upstream's behaviour, not an oversight
 * on this side.
 */
function pushUnique(targets: MoveTargetField[], candidate: MoveTargetField): void {
  for (const target of targets) {
    if (target.x === candidate.x && target.y === candidate.y && target.z === candidate.z) return;
  }
  targets.push(candidate);
}
