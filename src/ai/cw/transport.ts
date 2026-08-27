import { getCircle } from '../../host/globals.ts';
import type { BuildingHost, Unit } from '../../host/index.ts';
import { CwAction } from './actions.ts';
import type { CoreAI } from './coreai.ts';
import type { MoveTargetField } from './targets.ts';

/** ai/coreai.h: CoreAI::CircleReturns. */
export const enum CircleResult { Stop, Fail, Success }

/** ai/coreai.h: CoreAI::TargetDistance, ordered as the C++ enum is. */
export const enum TargetDistance { CloseTarget, FarTarget, NoTarget }

/** Tiles adjacent to a point -- where cargo can step off a transport. */
const UNLOAD_AREA = getCircle(1, 1);
/** ai/coreai.cpp: checkIslandForUnloading's ring width. */
const SEARCH_RADIUS = 6;

/**
 * ai/coreai.cpp: CoreAI::doExtendedCircleAction -- walks diamond rings outward
 * around (x, y) from `min` to `max`, calling `functor` on each tile.
 *
 * Each of the four arcs tracks its own state: once an arc returns nothing but
 * Stop for a whole radius it is abandoned, which is how the search gives up on
 * a direction that has left the island rather than the whole map.
 */
export function doExtendedCircleAction(
  currentX: number, currentY: number, x: number, y: number,
  min: number, max: number,
  functor: (x: number, y: number) => CircleResult,
): CircleResult {
  let ret = CircleResult.Fail;
  const states: CircleResult[] = [
    CircleResult.Success, CircleResult.Success, CircleResult.Success, CircleResult.Success,
  ];
  // The four arcs, as offsets applied step by step around the diamond.
  const arcs: Array<[number, number]> = [[1, 1], [1, -1], [-1, -1], [-1, 1]];

  for (let radius = min; radius <= max; radius++) {
    if (Math.abs(currentX - x) + Math.abs(currentY - y) === radius) {
      ret = functor(x, y);
      if (ret === CircleResult.Success) break;
    }
    let x2 = -radius, y2 = 0;
    if (radius === 0) {
      ret = functor(x, y);
      if (ret === CircleResult.Success) break;
      continue;
    }
    for (let arc = 0; arc < 4; arc++) {
      const [dx, dy] = arcs[arc];
      if (states[arc] === CircleResult.Stop) {
        // Skipped arcs still advance the cursor, or the next arc starts wrong.
        x2 += dx * radius;
        y2 += dy * radius;
        continue;
      }
      let onlyStop = true;
      for (let i = 0; i < radius; i++) {
        x2 += dx;
        y2 += dy;
        const state = functor(x + x2, y + y2);
        if (state === CircleResult.Success) return CircleResult.Success;
        if (state !== CircleResult.Stop) onlyStop = false;
      }
      if (onlyStop) states[arc] = CircleResult.Stop;
    }
  }
  return states.some(state => state === CircleResult.Stop) ? CircleResult.Stop : ret;
}

/**
 * ai/coreai.cpp: CoreAI::checkIslandForUnloading -- find a shore tile the
 * transport can reach where its cargo can actually get off onto the target
 * island.
 *
 * Three things must line up: the tile is on the cargo's target island, on the
 * transport's own island so it can be reached, and has at least one adjacent
 * free tile the cargo can stand on.
 */
export function checkIslandForUnloading(
  ai: CoreAI, unit: Unit, loadedUnit: Unit, checkedIslands: number[],
  unitIslandIdx: number, unitIsland: number,
  loadedUnitIslandIdx: number, targetIsland: number,
  islandX: number, islandY: number,
  targets: MoveTargetField[], distanceModifier = 1,
): void {
  let min = 0, max = SEARCH_RADIUS;
  let result = CircleResult.Fail;
  // Upstream records the island map's *index* here while the callers test
  // `contains(checkedIslands, targetIsland)` against island ids. Transcribed:
  // the mismatch changes which islands get skipped, so it is not inert.
  checkedIslands.push(loadedUnitIslandIdx);

  const startX = unit.getX(), startY = unit.getY();
  while (result === CircleResult.Fail) {
    result = doExtendedCircleAction(startX, startY, islandX, islandY, min, max, (x, y) => {
      if (!ai.map.onMap(x, y)) return CircleResult.Stop;
      const fieldUnit = ai.map.getTerrain(x, y).getUnit();
      if (ai.islandMaps[loadedUnitIslandIdx].getIsland(x, y) !== targetIsland) {
        return CircleResult.Stop;
      }
      if (ai.islandMaps[unitIslandIdx].getIsland(x, y) !== unitIsland) return CircleResult.Fail;
      if (fieldUnit !== null && fieldUnit !== unit) return CircleResult.Fail;
      if (unit.getBaseMovementCosts(x, y, x, y) <= 0) return CircleResult.Fail;
      if (contains(targets, x, y, distanceModifier)) return CircleResult.Fail;
      if (!ai.isUnloadTerrain(unit, ai.map.getTerrain(x, y))) return CircleResult.Fail;

      for (const offset of UNLOAD_AREA) {
        const ux = x + offset.x, uy = y + offset.y;
        if (!ai.map.onMap(ux, uy)) continue;
        if (ai.map.getTerrain(ux, uy).getUnit() !== null) continue;
        if (loadedUnit.getBaseMovementCosts(ux, uy, ux, uy) <= 0) continue;
        targets.push({ x, y, z: distanceModifier });
        return CircleResult.Fail;
      }
      return CircleResult.Fail;
    });
    min += SEARCH_RADIUS + 1;
    max += SEARCH_RADIUS + 1;
  }
}

/**
 * ai/coreai.cpp: CoreAI::canTransportToEnemy -- is this cargo worth shipping?
 *
 * True when the passenger could reach something to fight or capture on an
 * island it cannot walk to. This is what stops a transport ferrying a unit that
 * already has work where it stands.
 */
export function canTransportToEnemy(
  ai: CoreAI, unit: Unit, loadedUnit: Unit,
  enemyUnits: readonly Unit[], enemyBuildings: readonly BuildingHost[],
): boolean {
  const loadedUnitIslandIdx = ai.getIslandIndex(loadedUnit);
  const unitIslandIdx = ai.getIslandIndex(unit);
  const unitIsland = ai.getIsland(unit);
  const checkedIslands: number[] = [];
  const targets: MoveTargetField[] = [];

  for (const enemy of enemyUnits) {
    const x = enemy.getX(), y = enemy.getY();
    const targetIsland = ai.islandMaps[loadedUnitIslandIdx].getIsland(x, y);
    if (targetIsland < 0 || checkedIslands.includes(targetIsland)) continue;
    if (!loadedUnit.isAttackable(enemy, true)) continue;
    checkIslandForUnloading(ai, unit, loadedUnit, checkedIslands, unitIslandIdx, unitIsland,
      loadedUnitIslandIdx, targetIsland, x, y, targets);
    if (targets.length > 0) break;
  }

  if (loadedUnit.getActionList().includes(CwAction.CAPTURE) && targets.length === 0) {
    for (const building of enemyBuildings) {
      const x = building.getX(), y = building.getY();
      const targetIsland = ai.islandMaps[loadedUnitIslandIdx].getIsland(x, y);
      if (targetIsland < 0 || checkedIslands.includes(targetIsland)) continue;
      if (!building.isCaptureOrMissileBuilding(ai.missileTarget)) continue;
      checkIslandForUnloading(ai, unit, loadedUnit, checkedIslands, unitIslandIdx, unitIsland,
        loadedUnitIslandIdx, targetIsland, x, y, targets);
      if (targets.length > 0) break;
    }
  }
  return targets.length > 0;
}

/**
 * ai/coreai.cpp: CoreAI::appendNearestUnloadTargets -- shore tiles worth
 * steering a loaded transport towards.
 */
export function appendNearestUnloadTargets(
  ai: CoreAI, unit: Unit, enemyUnits: readonly Unit[], enemyBuildings: readonly BuildingHost[],
  targets: MoveTargetField[], distanceModifier = 1,
): void {
  const checkedIslands = new Map<string, number[]>();
  const checkedFor = (movementType: string): number[] => {
    let list = checkedIslands.get(movementType);
    if (list === undefined) { list = []; checkedIslands.set(movementType, list); }
    return list;
  };

  const unitIslandIdx = ai.getIslandIndex(unit);
  const unitIsland = ai.getIsland(unit);
  const loaded = unit.getLoadedUnits();
  const loadedUnitIslandIdx = loaded.map(cargo => ai.getIslandIndex(cargo));
  const captureUnits = loaded.filter(cargo => cargo.getActionList().includes(CwAction.CAPTURE));

  for (const enemy of enemyUnits) {
    for (let i = 0; i < loaded.length; i++) {
      // Upstream keys the checked set on the TRANSPORT's movement type here,
      // not the cargo's, so two different passengers share one bookkeeping
      // list. Transcribed.
      const movementType = unit.getMovementType();
      const cargo = loaded[i];
      const x = enemy.getX(), y = enemy.getY();
      const targetIsland = ai.islandMaps[loadedUnitIslandIdx[i]].getIsland(x, y);
      if (targetIsland < 0 || checkedFor(movementType).includes(targetIsland)) continue;
      if (!cargo.isAttackable(enemy, true) && cargo.getLoadedUnitCount() === 0) continue;
      checkIslandForUnloading(ai, unit, cargo, checkedFor(movementType), unitIslandIdx, unitIsland,
        loadedUnitIslandIdx[i], targetIsland, x, y, targets, distanceModifier);
    }
  }

  if (captureUnits.length === 0) return;
  for (const building of enemyBuildings) {
    for (let i = 0; i < captureUnits.length; i++) {
      const cargo = captureUnits[i];
      const movementType = cargo.getMovementType();
      const x = building.getX(), y = building.getY();
      // Upstream indexes loadedUnitIslandIdx by the *capture* index while that
      // array was built over every passenger, so a transport carrying a
      // non-capturing unit first reads the wrong island map here. Transcribed;
      // guarded only against running off the end of the array.
      const islandIdx = loadedUnitIslandIdx[i];
      if (islandIdx === undefined) continue;
      const targetIsland = ai.islandMaps[islandIdx].getIsland(x, y);
      if (targetIsland < 0 || checkedFor(movementType).includes(targetIsland)) continue;
      if (!building.isCaptureOrMissileBuilding(ai.missileTarget)) continue;
      checkIslandForUnloading(ai, unit, cargo, checkedFor(movementType), unitIslandIdx, unitIsland,
        islandIdx, targetIsland, x, y, targets, distanceModifier);
    }
  }
}

/**
 * ai/coreai.cpp: CoreAI::appendUnloadTargetsForAttacking -- shore tiles from
 * which the cargo could reach an enemy it can actually hurt.
 */
export function appendUnloadTargetsForAttacking(
  ai: CoreAI, unit: Unit, enemyUnits: readonly Unit[],
  targets: MoveTargetField[], rangeMultiplier: number, distanceModifier = 1,
): void {
  const unitIslandIdx = ai.getIslandIndex(unit);
  const unitIsland = ai.getIsland(unit);
  const attackUnits = unit.getLoadedUnits()
    .filter(cargo => cargo.getActionList().includes(CwAction.FIRE));
  if (attackUnits.length === 0) return;

  const averageMovepoints = Math.trunc(
    attackUnits.reduce((sum, cargo) => sum + cargo.getBaseMovementPoints(), 0) / attackUnits.length);
  const range = getCircle(1, averageMovepoints * rangeMultiplier + 1);

  for (const enemy of enemyUnits) {
    const enemyX = enemy.getX(), enemyY = enemy.getY();
    const attackers = attackUnits.filter(
      cargo => ai.predictor.getBaseDamage(cargo, enemy) > 0);
    if (attackers.length === 0) continue;

    for (const rangePos of range) {
      for (const unloadPos of UNLOAD_AREA) {
        const x = enemyX + rangePos.x + unloadPos.x;
        const y = enemyY + rangePos.y + unloadPos.y;
        if (!ai.map.onMap(x, y)) continue;
        if (ai.map.getTerrain(x, y).getUnit() !== null) continue;
        if (contains(targets, x, y, distanceModifier)) continue;
        if (!ai.isUnloadTerrain(unit, ai.map.getTerrain(x, y))) continue;
        if (ai.islandMaps[unitIslandIdx].getIsland(x, y) !== unitIsland) continue;
        for (const attacker of attackers) {
          const attackerIslandIdx = ai.getIslandIndex(attacker);
          const islands = ai.islandMaps[attackerIslandIdx];
          if (attacker.canMoveOver(x, y)
            && islands.getIsland(x, y) === islands.getIsland(enemyX, enemyY)) {
            targets.push({ x, y, z: distanceModifier });
            break;
          }
        }
      }
    }
  }
}

/**
 * ai/coreai.cpp: CoreAI::appendUnloadTargetsForCapturing -- shore tiles beside
 * a capturable building the cargo could take.
 *
 * Islands where we already have a capturing unit get a malus, so a transport
 * prefers opening a new front over reinforcing one that is already covered.
 */
export function appendUnloadTargetsForCapturing(
  ai: CoreAI, unit: Unit, ownUnits: readonly Unit[], enemyBuildings: readonly BuildingHost[],
  targets: MoveTargetField[], distanceModifier = 1,
): void {
  const unitIslandIdx = ai.getIslandIndex(unit);
  const unitIsland = ai.getIsland(unit);
  const captureUnits = unit.getLoadedUnits()
    .filter(cargo => cargo.getActionList().includes(CwAction.CAPTURE));
  if (captureUnits.length === 0) return;

  // Upstream also builds a GameAction here and toggles the first passenger's
  // hasMoved around the loop; nothing reads either, so both are dropped.
  const usedIsland: number[] = [];
  const island = ai.getIslandIndex(captureUnits[0]);
  const USED_ISLAND_MALUS = 3;

  for (const building of enemyBuildings) {
    const px = building.getX(), py = building.getY();
    if (!captureUnits[0].canMoveOver(px, py)) continue;
    if (!building.isCaptureOrMissileBuilding(ai.missileTarget)) continue;
    if (building.getTerrain()?.getUnit() != null) continue;

    const islandIdx = ai.islandMaps[island].getIsland(px, py);
    let finalDistanceModifier = distanceModifier;
    if (usedIsland.includes(islandIdx)) {
      finalDistanceModifier += USED_ISLAND_MALUS;
    } else {
      for (const own of ownUnits) {
        if (!own.canCapture()) continue;
        if (ai.islandMaps[island].sameIsland(px, py, own.getX(), own.getY())) {
          finalDistanceModifier += USED_ISLAND_MALUS;
          usedIsland.push(islandIdx);
          break;
        }
      }
    }

    for (const offset of UNLOAD_AREA) {
      const x = px + offset.x, y = py + offset.y;
      if (!ai.map.onMap(x, y)) continue;
      if (ai.map.getTerrain(x, y).getUnit() !== null) continue;
      if (contains(targets, x, y, finalDistanceModifier)) continue;
      if (!ai.isUnloadTerrain(unit, ai.map.getTerrain(x, y))) continue;
      if (ai.islandMaps[unitIslandIdx].getIsland(x, y) !== unitIsland) continue;
      if (captureUnits.some(cargo => cargo.canMoveOver(x, y))) {
        targets.push({ x, y, z: finalDistanceModifier });
      }
    }
  }
}

/** ai/coreai.cpp: CoreAI::appendTransporterTargets -- friendly rides going spare. */
export function appendTransporterTargets(
  unit: Unit, units: readonly Unit[], targets: MoveTargetField[],
): void {
  for (const transporter of units) {
    if (transporter === unit) continue;
    if (transporter.canTransportUnit(unit)) {
      targets.push({ x: transporter.getX(), y: transporter.getY(), z: 1 });
    }
  }
}

/**
 * ai/coreai.cpp: CoreAI::hasCaptureTarget -- is there anything for this unit to
 * capture on the island it is being asked about, and how far off is it?
 */
export function hasCaptureTarget(
  ai: CoreAI, loadingUnit: Unit, canCapture: boolean,
  enemyBuildings: readonly BuildingHost[], loadingIslandIdx: number, loadingIsland: number,
  onlyTrueIslands = false,
): TargetDistance {
  if (!canCapture) return TargetDistance.NoTarget;
  const unitX = loadingUnit.getX(), unitY = loadingUnit.getY();
  const movementPoints = loadingUnit.getMovementpoints({ x: unitX, y: unitY });
  const minMovementDistance = movementPoints * ai.config.minSameIslandDistance;

  let found = TargetDistance.NoTarget;
  for (const building of enemyBuildings) {
    const x = building.getX(), y = building.getY();
    const distance = Math.abs(x - unitX) + Math.abs(y - unitY);
    if (!onlyTrueIslands && distance > minMovementDistance) continue;
    if (ai.islandMaps[loadingIslandIdx].getIsland(x, y) !== loadingIsland) continue;
    if (!building.isCaptureOrMissileBuilding(ai.missileTarget)) continue;
    if (distance <= minMovementDistance) return TargetDistance.CloseTarget;
    found = TargetDistance.FarTarget;
  }
  return found;
}

/**
 * ai/coreai.cpp: CoreAI::appendCaptureTransporterTargets -- single-seat rides
 * worth boarding, for a capturing unit with nothing to take where it stands.
 */
export function appendCaptureTransporterTargets(
  ai: CoreAI, unit: Unit, units: readonly Unit[], enemyBuildings: readonly BuildingHost[],
  targets: MoveTargetField[], distanceModifier = 1,
): void {
  const unitIslandIdx = ai.getIslandIndex(unit);
  const unitIsland = ai.getIsland(unit);
  for (const transporter of units) {
    if (transporter === unit) continue;
    // Single-seaters only: upstream assumes a dedicated ferry, not a carrier.
    if (!transporter.canTransportUnit(unit)) continue;
    if (transporter.getLoadedUnitCount() !== 0 || transporter.getLoadingPlace() !== 1) continue;

    const transporterIslandIdx = ai.getIslandIndex(transporter);
    const transporterIsland = ai.getIsland(transporter);
    const distance = hasCaptureTarget(
      ai, unit, true, enemyBuildings, transporterIslandIdx, transporterIsland);
    if (distance > TargetDistance.FarTarget) continue;

    // Only worth boarding if there is something both of them can get to --
    // otherwise the pair load and unload each other in circles.
    const good = enemyBuildings.some(building => {
      const x = building.getX(), y = building.getY();
      return ai.islandMaps[unitIslandIdx].getIsland(x, y) === unitIsland
        && ai.islandMaps[transporterIslandIdx].getIsland(x, y) === transporterIsland
        && ai.map.getTerrain(x, y).getUnit() === null
        && building.isCaptureOrMissileBuilding(ai.missileTarget);
    });
    if (good) {
      targets.push({ x: transporter.getX(), y: transporter.getY(), z: Math.ceil(distanceModifier) });
    }
  }
}

/**
 * ai/coreai.cpp: CoreAI::appendSupportTargets -- tiles beside a friend worth
 * repairing or resupplying, or beside an enemy for a mine-layer.
 */
export function appendSupportTargets(
  ai: CoreAI, actions: readonly string[], currentUnit: Unit,
  units: readonly Unit[], enemyUnits: readonly Unit[],
  targets: MoveTargetField[], distanceModifier = 1,
): void {
  const ring = getCircle(1, 1);
  for (const action of actions) {
    const supports = action.startsWith(CwAction.SUPPORTSINGLE)
      || action.startsWith(CwAction.SUPPORTALL);
    const places = action.startsWith(CwAction.PLACE);
    if (!supports && !places) continue;
    for (const other of supports ? units : enemyUnits) {
      if (supports && other === currentUnit) continue;
      for (const field of ring) {
        const x = other.getX() + field.x, y = other.getY() + field.y;
        if (!ai.map.onMap(x, y)) continue;
        if (ai.map.getTerrain(x, y).getUnit() !== null) continue;
        if (contains(targets, x, y, 1 + distanceModifier)) continue;
        targets.push({ x, y, z: 1 + distanceModifier });
      }
    }
  }
}

/** GlobalUtils::contains -- weight included, so one tile can appear twice. */
function contains(targets: readonly MoveTargetField[], x: number, y: number, z: number): boolean {
  for (const target of targets) {
    if (target.x === x && target.y === y && target.z === z) return true;
  }
  return false;
}
