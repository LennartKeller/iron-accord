import type { Unit } from '../../host/index.ts';
import type { MovementRange } from '../../game/pathfinding.ts';
import { computeMovementRange } from '../../game/pathfinding.ts';
import { CwAction } from './actions.ts';

/**
 * ai/coreai.h: CoreAI::MoveUnitData -- everything the AI caches about one unit
 * for the length of a turn, so the ladder does not re-derive it per step.
 */
export interface MoveUnitData {
  unit: Unit;
  /** Reach explored over several turns, for judging how far off a target is. */
  range: MovementRange | null;
  /** The unit's own action list, cached; empty for enemies. */
  actions: string[];
  /** Damage this unit is already expected to take, from calcVirtualDamage. */
  virtualDamageData: number;
  /** One turn's movement, not the multi-turn budget `range` was built with. */
  movementPoints: number;
  minFireRange: number;
  maxFireRange: number;
  unitCosts: number;
  canCapture: boolean;
  distanceToEnemy: number;
  /** Which rung of the ladder this unit has been offered so far this turn. */
  nextAiStep: number;
}

/**
 * ai/normalai.cpp: NormalAi::createUnitData.
 *
 * `moveMultiplier` stretches the explored reach past one turn so the AI can see
 * targets it will arrive at later. Units too far from anything to matter get no
 * pathfinding at all, which is the single biggest cost saving in a turn.
 */
export function createUnitData(
  unit: Unit, enemy: boolean, moveMultiplier: number,
  otherUnitData: readonly MoveUnitData[], aiFunctionStep: number, always = false,
): MoveUnitData {
  const position = { x: unit.getX(), y: unit.getY() };
  const data: MoveUnitData = {
    unit,
    range: null,
    actions: [],
    virtualDamageData: 0,
    movementPoints: unit.getMovementpoints(position),
    minFireRange: unit.getMinRange(position),
    maxFireRange: unit.getMaxRange(position),
    unitCosts: unit.getCoUnitValue(),
    canCapture: false,
    distanceToEnemy: 0,
    nextAiStep: aiFunctionStep,
  };

  let valid = always;
  if (!always) {
    const reach = data.movementPoints + data.maxFireRange;
    for (const other of otherUnitData) {
      const distance = Math.abs(position.x - other.unit.getX())
        + Math.abs(position.y - other.unit.getY());
      if (distance <= reach + other.movementPoints + other.maxFireRange + 1) { valid = true; break; }
    }
  }
  if (!valid) return data;

  if (!enemy) data.actions = unit.getActionList();
  // A unit that has already acted will not be in the way next turn, so an
  // enemy's projected reach ignores those -- and costs itself one point,
  // because it has to spend a move getting going again.
  const budget = unit.getHasMoved()
    ? moveMultiplier * data.movementPoints - 1
    : moveMultiplier * data.movementPoints;
  data.range = computeMovementRange(unit.map, unit, {
    budget: Math.floor(budget),
    ignoreEnemies: enemy ? 'onlyNotMoved' : 'off',
  });
  return data;
}

/**
 * ai/coreai.cpp: CoreAI::sortUnitsFarFromEnemyFirst.
 *
 * Move order matters more than it looks: the units furthest from the fighting
 * go first so the ones already in contact can react to where their support
 * ended up, and non-capturing units go before capturers so a soldier is not
 * shoved off a building by its own escort.
 */
export function sortUnitsFarFromEnemyFirst(
  units: MoveUnitData[], enemyUnits: readonly Unit[],
): void {
  for (const data of units) {
    let distance = Number.MAX_SAFE_INTEGER;
    for (const enemy of enemyUnits) {
      const next = Math.abs(enemy.getX() - data.unit.getX())
        + Math.abs(enemy.getY() - data.unit.getY());
      if (next < distance) distance = next;
    }
    data.distanceToEnemy = distance;
    data.canCapture = data.actions.includes(CwAction.CAPTURE);
  }
  units.sort((lhs, rhs) => {
    // A map author's explicit priority overrides the heuristic entirely.
    const lhsPriority = lhs.unit.getAiPriority(), rhsPriority = rhs.unit.getAiPriority();
    if (lhsPriority !== rhsPriority) return rhsPriority - lhsPriority;
    if (lhs.canCapture !== rhs.canCapture) return (lhs.canCapture ? 1 : 0) - (rhs.canCapture ? 1 : 0);
    if (lhs.distanceToEnemy !== rhs.distanceToEnemy) return rhs.distanceToEnemy - lhs.distanceToEnemy;
    return lhs.movementPoints - rhs.movementPoints;
  });
}
