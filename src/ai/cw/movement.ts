import type { MovementRange, ReachableTile } from '../../game/pathfinding.ts';
import { key, pathTo } from '../../game/pathfinding.ts';
import { getCircle } from '../../host/globals.ts';
import type { BuildingHost, Unit } from '../../host/index.ts';
import { isAttackOnTerrainAllowed, type MoveTargetField } from './targets.ts';
import type { CoreAI } from './coreai.ts';
import type { MoveUnitData } from './unitdata.ts';
import { calculateCounterDamage, type ScoringContext } from './scoring.ts';
import { hasCaptureTarget, TargetDistance } from './transport.ts';

export type Point = { x: number; y: number };

/**
 * game/unitpathfindingsystem.cpp: UnitPathFindingSystem::isCrossable -- may the
 * unit end its move here, within the given budget?
 *
 * An enemy-held tile counts as crossable in the C++ sense: the caller uses this
 * to walk *back* along a route looking for the last tile it can actually stop
 * on, and wants to know where the blockage is rather than to stop on it.
 */
function isCrossable(
  ai: CoreAI, unit: Unit, range: MovementRange,
  x: number, y: number, movementCosts: number, movepoints: number,
): boolean {
  const nodeUnit = ai.map.getTerrain(x, y).getUnit();
  const blocked = nodeUnit !== null && !nodeUnit.isStealthed(ai.player)
    && unit.getOwner().isEnemyUnit(nodeUnit);
  if (!(nodeUnit === null || nodeUnit === unit || blocked)) return false;
  if (movepoints >= 0 && movementCosts > movepoints) return false;
  return unit.getMovementCosts(x, y, x, y) > 0;
}

/**
 * game/unitpathfindingsystem.cpp: getClosestReachableMovePath(QPoint) -- from a
 * tile we want to be on, walk outward until we find one we can actually reach,
 * and return the route to it.
 *
 * This is what turns "go there" into "go as far as today allows", including
 * when "there" is occupied or off our island entirely.
 */
export function getClosestReachableMovePath(
  ai: CoreAI, unit: Unit, range: MovementRange, target: Point, movepoints: number,
): ReachableTile[] {
  const costOf = (x: number, y: number): number => {
    const tile = range.tiles.get(key(x, y));
    return tile === undefined ? -1 : tile.cost;
  };
  const seen = new Set<string>();
  const queued = new Set<string>();
  let current: Point[] = [{ x: target.x, y: target.y }];
  let next: Point[] = [];
  queued.add(key(target.x, target.y));

  while (current.length > 0 || next.length > 0) {
    if (current.length === 0) { current = next; next = []; }
    const node = current.shift()!;
    seen.add(key(node.x, node.y));
    if (!ai.map.onMap(node.x, node.y)) continue;
    const currentCost = costOf(node.x, node.y);
    if (currentCost >= 0
      && isCrossable(ai, unit, range, node.x, node.y, currentCost, movepoints)) {
      return pathTo(range, node.x, node.y).reverse();
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as Array<[number, number]>) {
      const nx = node.x + dx, ny = node.y + dy;
      if (!ai.map.onMap(nx, ny)) continue;
      const id = key(nx, ny);
      if (seen.has(id) || queued.has(id)) continue;
      const testCost = costOf(nx, ny);
      // Outward when it is further along, back down when it is nearer -- the
      // search spreads both ways so an unreachable target still finds a route.
      if (testCost > currentCost || (testCost >= 0 && testCost <= currentCost)) {
        queued.add(id);
        next.push({ x: nx, y: ny });
      }
    }
  }
  return [];
}

/**
 * ai/normalai.cpp: NormalAi::getMoveTargetField -- how far along a route it is
 * safe to actually go.
 *
 * Walks the route from the far end back and takes the first tile whose expected
 * counter-damage is acceptable, stopping immediately on a tile that costs
 * nothing. The final tile of the route is only accepted at zero damage, which
 * is what stops a unit parking in the open at the end of an advance.
 */
export function getMoveTargetField(
  context: ScoringContext, unitData: MoveUnitData, movePath: readonly Point[],
  buildings: readonly BuildingHost[], enemyBuildings: readonly BuildingHost[],
  movePoints: number,
): number {
  const { ai } = context;
  const minDamage = unitData.unitCosts * ai.config.minMovementDamage;
  let bestMinDamage = minDamage;
  let bestIdx = -1;
  const last = movePath.length - 1;
  const range = unitData.range;
  if (range === null) return -1;

  for (let i = 0; i <= last; i++) {
    const { x, y } = movePath[i];
    const terrain = ai.map.getTerrain(x, y);
    const occupant = terrain.getUnit();
    if (occupant !== null && occupant !== unitData.unit) continue;
    const costs = range.tiles.get(key(x, y))?.cost ?? -1;
    if (costs < 0 || costs > movePoints) continue;
    if (!ai.isMoveableTile(terrain.getBuilding(), range)) continue;

    const counterDamage = calculateCounterDamage(
      context, unitData, movePath[i], null, 0, buildings, enemyBuildings, true);
    if (counterDamage <= bestMinDamage && (i !== last || counterDamage <= 0)) {
      bestIdx = i;
      if (counterDamage <= 0) return bestIdx;
      bestMinDamage = counterDamage;
    }
  }
  return bestIdx;
}

/**
 * ai/normalai.cpp: NormalAi::moveToSafety -- the least dangerous tile in reach,
 * preferring one near where we wanted to go.
 *
 * Also reports whether every candidate scored the same, which the caller reads
 * as "running does not help" and takes as grounds for attacking instead.
 */
export function moveToSafety(
  context: ScoringContext, unitData: MoveUnitData, target: Point,
  buildings: readonly BuildingHost[], enemyBuildings: readonly BuildingHost[],
  movePoints: number,
): { point: Point; leastDamage: number; allEqual: boolean } {
  const { ai } = context;
  const unit = unitData.unit;
  const range = unitData.range;
  let point: Point = { x: unit.getX(), y: unit.getY() };
  let leastDamage = Number.MAX_VALUE;
  let shortestDistance = Number.MAX_SAFE_INTEGER;
  let allEqual = true;
  if (range === null) return { point, leastDamage, allEqual };

  for (const tile of range.tiles.values()) {
    if (tile.cost > movePoints + 1) continue;
    const { x, y } = tile;
    if (ai.map.getTerrain(x, y).getUnit() !== null) continue;
    if (unit.getMovementCosts(x, y, x, y) <= 0) continue;

    let currentDamage = calculateCounterDamage(
      context, unitData, tile, null, 0, buildings, enemyBuildings, true);
    if (currentDamage < 0) currentDamage = 0;
    if (leastDamage < Number.MAX_VALUE && Math.trunc(leastDamage) !== Math.trunc(currentDamage)) {
      allEqual = false;
    }
    const distance = Math.abs(target.x - x) + Math.abs(target.y - y);
    if (currentDamage < leastDamage) {
      point = { x, y };
      leastDamage = currentDamage;
      shortestDistance = distance;
    } else if (Math.trunc(currentDamage) === Math.trunc(leastDamage)
      && distance < shortestDistance && distance > 0) {
      point = { x, y };
      leastDamage = currentDamage;
      shortestDistance = distance;
    }
  }
  return { point, leastDamage, allEqual };
}

/**
 * ai/coreai.cpp: CoreAI::hasTargets -- is there anything for this unit to do on
 * the island it is standing on?
 *
 * A no here is what sends a unit looking for a boat instead of wandering its
 * own landmass with nothing to attack.
 */
export function hasTargets(
  ai: CoreAI, transporterMovement: number, loadingUnit: Unit, canCapture: boolean,
  enemyUnits: readonly Unit[], enemyBuildings: readonly BuildingHost[],
  loadingIslandIdx: number, loadingIsland: number,
  allowFastUnit = false, onlyTrueIslands = false, useEnemyProductionBuildings = true,
): boolean {
  const unitPos = { x: loadingUnit.getX(), y: loadingUnit.getY() };
  const movementPoints = loadingUnit.getMovementpoints(unitPos);
  const minMovementDistance = movementPoints * ai.config.minSameIslandDistance;
  // A unit fast enough to outrun the ferry is better off walking.
  const fastUnit = allowFastUnit
    && movementPoints * ai.config.slowUnitSpeed > transporterMovement;
  const islands = ai.islandMaps[loadingIslandIdx];
  const near = (x: number, y: number) =>
    fastUnit || onlyTrueIslands
    || Math.abs(x - unitPos.x) + Math.abs(y - unitPos.y) <= minMovementDistance;

  for (const enemy of enemyUnits) {
    const x = enemy.getX(), y = enemy.getY();
    if (!near(x, y)) continue;
    if (islands.getIsland(x, y) === loadingIsland && loadingUnit.isAttackable(enemy, true)) {
      return true;
    }
  }
  if (useEnemyProductionBuildings) {
    for (const building of enemyBuildings) {
      const x = building.getX(), y = building.getY();
      if (!near(x, y)) continue;
      if (islands.getIsland(x, y) === loadingIsland && building.isProductionBuilding()) return true;
    }
  }
  return hasCaptureTarget(ai, loadingUnit, canCapture, enemyBuildings,
    loadingIslandIdx, loadingIsland) >= TargetDistance.FarTarget;
}

/**
 * ai/coreai.cpp: CoreAI::appendTerrainBuildingAttackTargets -- firing positions
 * against structures with HP, which is how a map built around breaching a wall
 * gets played at all.
 */
export function appendTerrainBuildingAttackTargets(
  ai: CoreAI, unit: Unit, enemyBuildings: readonly BuildingHost[],
  targets: MoveTargetField[], distanceModifier = 1,
): void {
  const fireRange = unit.getMaxRange({ x: unit.getX(), y: unit.getY() });
  const ring = getCircle(fireRange, fireRange);
  const options = {
    ownUnitValue: ai.config.ownUnitValue,
    buildingValue: ai.config.buildingValue,
    minTerrainDamage: ai.config.minTerrainDamage,
    minHpDamage: ai.config.minHpDamage,
    enableNeutralTerrainAttack: ai.enableNeutralTerrainAttack,
  };

  for (const building of enemyBuildings) {
    const terrain = building.getTerrain();
    if (terrain === null) continue;
    const damage = unit.getEnvironmentDamage(building.getBuildingID());
    if (!isAttackOnTerrainAllowed(terrain, damage, ai.player, options)) continue;
    if (building.getHp() <= 0) continue;
    if (!unit.isEnvironmentAttackable(building.getBuildingID())) continue;

    const width = building.getBuildingWidth(), height = building.getBuildingHeigth();
    const pos = building.getPosition();
    const attackPositions: Point[] = [];
    for (let x = -width; x <= 0; x++) {
      for (let y = -height; y <= 0; y++) {
        if (building.getIsAttackable(x + pos.x, y + pos.y)) {
          attackPositions.push({ x: pos.x + x, y: pos.y + y });
        }
      }
    }
    for (const offset of ring) {
      for (const attackPos of attackPositions) {
        const x = offset.x + attackPos.x, y = offset.y + attackPos.y;
        if (!ai.map.onMap(x, y)) continue;
        if (ai.map.getTerrain(x, y).getUnit() !== null) continue;
        if (!unit.canMoveOver(x, y)) continue;
        const candidate = { x, y, z: 1 + distanceModifier };
        if (!targets.some(t => t.x === x && t.y === y && t.z === candidate.z)) {
          targets.push(candidate);
        }
      }
    }
  }
}
