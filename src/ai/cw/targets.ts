import type { Game } from '../../game/game.ts';
import type { MovementRange } from '../../game/pathfinding.ts';
import type { Player, Terrain, Unit } from '../../host/index.ts';
import { calcFundsDamage, type DamagePredictor } from './damage.ts';

/** ai/coreai.h: CoreAI::DamageData -- one attack the AI is considering. */
export interface DamageData {
  /** The tile being attacked. */
  x: number;
  y: number;
  /** Net funds swing, counter-attack already subtracted. */
  fundsDamage: number;
  /** HP taken off the defender. */
  hpDamage: number;
  /** HP swing in our favour: damage dealt minus damage taken back. */
  hpDamageDifference: number;
}

/** A tile to attack from, with the weight the targeted pathfinder reads. */
export interface MoveTargetField { x: number; y: number; z: number }

export interface TargetScoringOptions {
  /** OwnUnitValue -- how dearly the AI holds its own units in a trade. */
  ownUnitValue: number;
  /** BuildingValue -- attacking structures against attacking units. */
  buildingValue: number;
  /** MinTerrainDamage -- below this, shooting a structure is not worth a turn. */
  minTerrainDamage: number;
  /** MinHpDamage -- the worst HP trade still considered an attack worth making. */
  minHpDamage: number;
  /** Whether neutral structures may be shot at. */
  enableNeutralTerrainAttack: boolean;
}

/**
 * ai/coreai.cpp: CoreAI::isAttackOnTerrainAllowed -- may this unit shoot a
 * structure rather than a unit? Pipes, walls and enemy-held buildings with HP
 * qualify; the damage floor stops a unit wasting a turn chipping at one.
 */
export function isAttackOnTerrainAllowed(
  terrain: Terrain, damage: number, player: Player, options: TargetScoringOptions,
): boolean {
  if (damage < options.minTerrainDamage) return false;
  const building = terrain.getBuilding();
  if (options.enableNeutralTerrainAttack && terrain.getHp() > 0) return true;
  if (building !== null && building.getHp() > 0) {
    const owner = building.getOwner();
    if (owner !== null && owner.isEnemy(player)) return true;
    if (options.enableNeutralTerrainAttack && owner === null) return true;
  }
  return false;
}

/**
 * Every tile this unit could shoot at from `from`, scored.
 *
 * ai/coreai.cpp: CoreAI::getAttacksFromField. Upstream drives this through a
 * GameAction and its marked-field step data; `game.attackTargets` is this
 * project's port of that same enumeration, so it is used instead of rebuilding
 * the action plumbing.
 */
function attacksFromField(
  game: Game, predictor: DamagePredictor, unit: Unit, from: { x: number; y: number },
  options: TargetScoringOptions,
  into: DamageData[], moveTargetFields: MoveTargetField[],
): void {
  const player = unit.getOwner();
  for (const target of game.attackTargets(unit, from)) {
    const damage = predictor.calcVirtualUnitDamage(
      unit, 0, from, target.unit, 0, { x: target.x, y: target.y });
    if (target.unit !== null) {
      // A unit we cannot actually see is worth less as a target: it may not be
      // where we think it is by the time we shoot.
      const { hidden, terrainHide } = target.unit.isStatusStealthedAndInvisible(player);
      let stealthMalus = 0;
      if (hidden) stealthMalus = terrainHide ? 2 : 4;

      const funds = calcFundsDamage(damage, unit, target.unit, options.ownUnitValue);
      into.push({
        x: target.x, y: target.y,
        fundsDamage: funds.fundsDamage,
        hpDamage: funds.atkHpDamage,
        hpDamageDifference: funds.hpDamage,
      });
      moveTargetFields.push({ x: from.x, y: from.y, z: 1 + stealthMalus });
    } else {
      const terrain = game.map.getTerrain(target.x, target.y);
      if (!isAttackOnTerrainAllowed(terrain, damage.x, player, options)) continue;
      into.push({
        x: target.x, y: target.y,
        fundsDamage: damage.x * options.buildingValue,
        hpDamage: damage.x,
        hpDamageDifference: damage.x,
      });
      moveTargetFields.push({ x: from.x, y: from.y, z: 1 });
    }
  }
}

/**
 * ai/coreai.cpp: CoreAI::getAttackTargets -- everything this unit could hit
 * this turn, from where it stands and from anywhere it can move to first.
 *
 * A unit that cannot move and fire is only ever scored from its current tile,
 * which is what keeps artillery from planning attacks it could not make.
 */
export function getAttackTargets(
  game: Game, predictor: DamagePredictor, unit: Unit, range: MovementRange,
  options: TargetScoringOptions, maxDistance = Number.MAX_SAFE_INTEGER,
): { targets: DamageData[]; moveTargetFields: MoveTargetField[] } {
  const targets: DamageData[] = [];
  const moveTargetFields: MoveTargetField[] = [];
  const here = { x: unit.getX(), y: unit.getY() };
  attacksFromField(game, predictor, unit, here, options, targets, moveTargetFields);

  if (unit.canMoveAndFire(here)) {
    for (const tile of range.tiles.values()) {
      if (tile.cost > maxDistance) continue;
      // Occupied tiles are not places to shoot from, including our own -- the
      // starting tile was already scored above.
      if (game.map.getTerrain(tile.x, tile.y).getUnit() !== null) continue;
      attacksFromField(game, predictor, unit, tile, options, targets, moveTargetFields);
    }
  }
  return { targets, moveTargetFields };
}

/**
 * ai/coreai.cpp: CoreAI::getBestTarget -- only the attacks tied for the best
 * funds swing, so the caller picks between equals rather than ranking a list.
 *
 * Attacks whose HP trade is worse than MinHpDamage are dropped outright: that
 * tunable is what stops the AI feeding units into a bad exchange.
 *
 * The z on each returned target is its funds damage, not a weight -- upstream
 * reuses the same vector type for both.
 */
export function getBestTarget(
  game: Game, predictor: DamagePredictor, unit: Unit, range: MovementRange,
  options: TargetScoringOptions, maxDistance = Number.MAX_SAFE_INTEGER,
): { targets: MoveTargetField[]; moveTargetFields: MoveTargetField[] } {
  const targets: MoveTargetField[] = [];
  const moveTargetFields: MoveTargetField[] = [];
  const player = unit.getOwner();

  const consider = (from: { x: number; y: number }): void => {
    for (const target of game.attackTargets(unit, from)) {
      const damage = predictor.calcVirtualUnitDamage(
        unit, 0, from, target.unit, 0, { x: target.x, y: target.y });
      let score: number;
      if (target.unit !== null) {
        const funds = calcFundsDamage(damage, unit, target.unit, options.ownUnitValue);
        if (funds.hpDamage < options.minHpDamage) continue;
        score = funds.fundsDamage;
      } else {
        const terrain = game.map.getTerrain(target.x, target.y);
        if (!isAttackOnTerrainAllowed(terrain, damage.x, player, options)) continue;
        score = damage.x * options.buildingValue;
      }
      // Upstream compares the raw damage against the stored score in the
      // terrain branch while storing damage * BuildingValue. The two agree
      // whenever BuildingValue is 1, which every shipped profile sets.
      if (targets.length === 0 || score > targets[0].z) {
        targets.length = 0;
        moveTargetFields.length = 0;
      } else if (score !== targets[0].z) {
        continue;
      }
      targets.push({ x: target.x, y: target.y, z: score });
      moveTargetFields.push({ x: from.x, y: from.y, z: 1 });
    }
  };

  const here = { x: unit.getX(), y: unit.getY() };
  consider(here);
  if (unit.canMoveAndFire(here)) {
    for (const tile of range.tiles.values()) {
      if (tile.cost > maxDistance) continue;
      if (game.map.getTerrain(tile.x, tile.y).getUnit() !== null) continue;
      consider(tile);
    }
  }
  return { targets, moveTargetFields };
}
