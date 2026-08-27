import { GameEnums, MAX_UNIT_HP, type BuildingHost, type Unit } from '../../host/index.ts';
import { getCircle } from '../../host/globals.ts';
import { calcFundsDamage, type BattleResult } from './damage.ts';
import { CwAction } from './actions.ts';
import type { CoreAI } from './coreai.ts';
import type { InfluenceFrontMap } from './influencefrontmap.ts';
import type { MoveUnitData } from './unitdata.ts';
import type { DamageData, MoveTargetField, TargetScoringOptions } from './targets.ts';
import { getAttackTargets } from './targets.ts';

/** Everything the attack scoring reads beyond the CoreAI base. */
export interface ScoringContext {
  ai: CoreAI;
  ownUnits: MoveUnitData[];
  enemyUnits: MoveUnitData[];
  influence: InfluenceFrontMap;
  targetOptions: TargetScoringOptions;
}

/**
 * ai/normalai.cpp: NormalAi::calculateCaptureBonus.
 *
 * Multiplies an attack's worth by how much it disrupts a capture in progress.
 * Killing a soldier one turn from taking a building is worth far more than the
 * soldier, and killing one on our own HQ is worth almost anything.
 */
export function calculateCaptureBonus(
  context: ScoringContext, unit: Unit, newLife: number,
): number {
  const { config, player } = context.ai;
  let ret = 1;
  const capturePoints = unit.getCapturePoints();
  const building = unit.getTerrain()?.getBuilding() ?? null;

  if (capturePoints > 0) {
    const restCapture = 20 - capturePoints;
    const currentHp = unit.getHpRounded();
    const newHp = Math.ceil(newLife);
    const remainingDays = Math.ceil(restCapture / currentHp);
    if (remainingDays <= 1) {
      if (newHp <= 0) {
        ret = config.antiCaptureBonus;
      } else {
        const newRemainingDays = Math.ceil(restCapture / newHp);
        if (remainingDays > newRemainingDays) ret = 0.8;
        else if (remainingDays === newRemainingDays && remainingDays < 2) ret = 1;
        else if (remainingDays === 0) ret = 1;
        else ret = 1 + (newRemainingDays - remainingDays) / remainingDays;
        if (ret > config.antiCaptureBonusScoreReduction) {
          ret = ret / config.antiCaptureBonusScoreDivider
            + config.antiCaptureBonusScoreReduction / config.antiCaptureBonusScoreDivider;
        }
      }
    }
  }
  if (building !== null && building.getOwner() === player
    && building.getBuildingID() === 'HQ' && unit.hasAction(CwAction.CAPTURE)) {
    ret *= config.antiCaptureHqBonus;
  }
  return ret;
}

/**
 * ai/normalai.cpp: NormalAi::calculateCounteBuildingDamage -- what standing on
 * a tile costs in return fire from structures and mines.
 *
 * Upstream walks the *enemy* building list twice and never touches the own-
 * building list it is handed, so hostile cannons are counted double and
 * friendly ones not at all. Transcribed; the doubling is baked into how the
 * tunables were fitted.
 */
export function calculateCounterBuildingDamage(
  context: ScoringContext, unit: Unit, newPosition: { x: number; y: number },
  _buildings: readonly BuildingHost[], enemyBuildings: readonly BuildingHost[],
): number {
  const { ai } = context;
  let counterDamage = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (const building of enemyBuildings) {
      counterDamage += ai.predictor.calcBuildingDamage(ai.player, unit, newPosition, building);
    }
  }
  for (const offset of getCircle(1, 2)) {
    const x = newPosition.x + offset.x, y = newPosition.y + offset.y;
    if (!ai.map.onMap(x, y)) continue;
    const mine = ai.map.getTerrain(x, y).getUnit();
    if (mine !== null && !mine.isStealthed(ai.player) && mine.getUnitID() === 'WATERMINE') {
      counterDamage += ai.config.watermineDamage;
    }
  }
  return counterDamage;
}

/**
 * ai/normalai.cpp: NormalAi::getMapInfluenceModifier -- a risk premium for
 * standing on ground the enemy owns.
 *
 * The division is upstream's and so is its edge: the second branch guards only
 * `enemyInfluence > 0`, so a tile where we have no influence at all divides by
 * zero and yields Infinity, which then flows straight into a counter-damage
 * score. JavaScript numbers are IEEE doubles exactly like the C++ floats, so
 * this reproduces the original rather than diverging from it.
 */
export function getMapInfluenceModifier(
  context: ScoringContext, unit: Unit, x: number, y: number,
): number {
  const info = context.influence.getInfluenceInfo(x, y);
  const enemyInfluence = info.getEnemyInfluence();
  const ownInfluence = info.getOwnInfluence();
  let influence = 0;
  if (enemyInfluence > ownInfluence && ownInfluence > 0) {
    influence = 1 - ownInfluence / enemyInfluence;
  } else if (enemyInfluence > 0) {
    influence = -(1 - enemyInfluence / ownInfluence);
  }
  if (Math.abs(influence) > context.ai.config.influenceIgnoreValue) {
    return influence * unit.getCoUnitValue() * context.ai.config.influenceMultiplier;
  }
  return 0;
}

/**
 * ai/normalai.cpp: NormalAi::calculateCounterDamage -- what moving to a tile is
 * expected to cost, in funds, once every enemy that could answer has answered.
 *
 * The interesting part is the discount loop: an enemy that could hit several of
 * our units from the same spot is only going to hit one of them, so its threat
 * against this particular unit is halved in proportion to the alternatives.
 */
export function calculateCounterDamage(
  context: ScoringContext, curUnitData: MoveUnitData, newPosition: { x: number; y: number },
  enemyUnit: Unit | null, enemyTakenDamage: number,
  buildings: readonly BuildingHost[], enemyBuildings: readonly BuildingHost[],
  ignoreOutOfVisionRange: boolean,
): number {
  const { ai, ownUnits, enemyUnits } = context;
  const { config } = ai;
  const unit = curUnitData.unit;
  // Cached per unit *type*: two identical tanks threaten a tile identically.
  const unitDamageData = new Map<string, number>();
  let counterDamage = 0;

  const distanceTo = (ax: number, ay: number, bx: number, by: number) =>
    Math.abs(ax - bx) + Math.abs(ay - by);

  for (const enemyData of enemyUnits) {
    const nextEnemy = enemyData.unit;
    if (nextEnemy.getHp() <= 0 || nextEnemy.getTerrain() === null) continue;
    const enemyPos = { x: nextEnemy.getX(), y: nextEnemy.getY() };
    let distance = distanceTo(newPosition.x, newPosition.y, enemyPos.x, enemyPos.y);
    const maxFireRange = enemyData.maxFireRange;
    const hasDamage = unitDamageData.has(nextEnemy.getUnitID());
    const unitDamage = hasDamage ? unitDamageData.get(nextEnemy.getUnitID())! : -1;

    let moveRange = 0;
    let canMoveAndFire = false;
    if (distance <= enemyData.movementPoints + maxFireRange) {
      canMoveAndFire = nextEnemy.canMoveAndFire(enemyPos);
      if (canMoveAndFire) moveRange = enemyData.movementPoints;
    }
    if (distance > moveRange + maxFireRange) continue;
    if (!(unitDamage >= 0 || (!hasDamage && nextEnemy.isAttackable(unit, true)))) continue;

    const minFireRange = enemyData.minFireRange;
    let enemyDamage = enemyData.virtualDamageData;
    if (nextEnemy === enemyUnit) enemyDamage += enemyTakenDamage;
    enemyDamage *= config.enemyCounterDamageMultiplier;
    if (enemyDamage >= nextEnemy.getHp() * MAX_UNIT_HP) continue;

    let damageData: BattleResult = { x: 0, y: 0, width: -1, height: 0 };
    if (distance >= minFireRange && distance <= maxFireRange) {
      // An indirect can already reach us from where it stands.
      if (hasDamage) {
        damageData = { x: unitDamage * nextEnemy.getHp() / MAX_UNIT_HP, y: 0, width: -1, height: 0 };
      } else {
        damageData = ai.predictor.calcVirtualUnitDamage(
          nextEnemy, enemyDamage, enemyPos, unit, 0, newPosition,
          GameEnums.LuckDamageMode_Average, GameEnums.LuckDamageMode_Average, ignoreOutOfVisionRange);
        if (damageData.x >= 0) {
          unitDamageData.set(nextEnemy.getUnitID(), damageData.x * MAX_UNIT_HP / nextEnemy.getHp());
        }
      }
      if (damageData.x >= config.notAttackableDamage) {
        for (const otherData of ownUnits) {
          distance = distanceTo(otherData.unit.getX(), otherData.unit.getY(), enemyPos.x, enemyPos.y);
          if (distance < minFireRange || distance > maxFireRange) continue;
          if (!nextEnemy.isAttackable(otherData.unit, true)) continue;
          damageData.x = discount(damageData.x, curUnitData.unitCosts, otherData.unitCosts);
        }
      }
    } else if (canMoveAndFire) {
      const targets = enemyData.range === null ? [] : [...enemyData.range.tiles.values()]
        .filter(tile => tile.cost <= enemyData.movementPoints + 1);
      let found = false;
      for (const target of targets) {
        distance = distanceTo(newPosition.x, newPosition.y, target.x, target.y);
        const terrainUnit = ai.map.getTerrain(target.x, target.y).getUnit();
        if (distance < minFireRange || distance > maxFireRange) continue;
        if (terrainUnit !== null && terrainUnit !== nextEnemy) continue;
        if (hasDamage) {
          damageData = { x: unitDamage * nextEnemy.getHp() / MAX_UNIT_HP, y: 0, width: -1, height: 0 };
        } else {
          damageData = ai.predictor.calcVirtualUnitDamage(
            nextEnemy, enemyDamage, target, unit, 0, newPosition,
            GameEnums.LuckDamageMode_Average, GameEnums.LuckDamageMode_Average, ignoreOutOfVisionRange);
          if (damageData.x >= 0) {
            unitDamageData.set(nextEnemy.getUnitID(), damageData.x * MAX_UNIT_HP / nextEnemy.getHp());
          }
        }
        found = true;
        break;
      }
      const enemyIslandIdx = ai.getIslandIndex(nextEnemy);
      const enemyIsland = ai.getIsland(nextEnemy);
      if (found && damageData.x >= config.notAttackableDamage) {
        for (const otherData of ownUnits) {
          for (const target of targets) {
            const nextUnit = otherData.unit;
            distance = distanceTo(nextUnit.getX(), nextUnit.getY(), target.x, target.y);
            const targetUnit = ai.map.getTerrain(target.x, target.y).getUnit();
            if (distance < minFireRange || distance > maxFireRange) continue;
            if (targetUnit !== null && !targetUnit.getOwner().isAlly(ai.player)) continue;
            if (enemyIsland !== ai.islandMaps[enemyIslandIdx].getIsland(target.x, target.y)) continue;
            damageData.x = discount(damageData.x, curUnitData.unitCosts, otherData.unitCosts);
            break;
          }
        }
      }
    }

    if (damageData.x < 0) damageData.x = 0;
    if (damageData.x > 0) {
      const funds = calcFundsDamage(damageData, nextEnemy, unit, config.ownUnitValue);
      counterDamage += Math.trunc(funds.fundsDamage);
    }
  }

  return counterDamage
    + getMapInfluenceModifier(context, unit, newPosition.x, newPosition.y)
    + calculateCounterBuildingDamage(context, unit, newPosition, buildings, enemyBuildings);
}

/** An enemy that can shoot several of us only shoots one; halve accordingly. */
function discount(damage: number, ownCosts: number, otherCosts: number): number {
  if (ownCosts <= 0 || otherCosts <= 0) return damage;
  const ratio = ownCosts > otherCosts ? otherCosts / ownCosts : ownCosts / otherCosts;
  return damage - damage * 0.5 * ratio;
}

/**
 * ai/normalai.cpp: NormalAi::getOwnSupportDamage -- how much a friend could add
 * to this same target, so a unit does not open an attack nobody can finish.
 */
export function getOwnSupportDamage(
  context: ScoringContext, unit: Unit, moveTarget: { x: number; y: number }, enemy: Unit | null,
): { supportDamage: number; hpDamage: number } {
  const { ai, ownUnits, targetOptions } = context;
  const { config } = ai;
  let supportDamage = 0, hpDamage = 0;
  if (enemy === null) return { supportDamage, hpDamage };

  for (const data of ownUnits) {
    if (data.unit === unit || data.unit.getHasMoved() || !data.unit.hasWeapons()) continue;
    if (data.range === null) continue;
    const position = { x: data.unit.getX(), y: data.unit.getY() };
    const distance = Math.abs(moveTarget.x - position.x) + Math.abs(moveTarget.y - position.y);
    if (distance > data.movementPoints) continue;

    const { targets } = getAttackTargets(
      ai.game, ai.predictor, data.unit, data.range, targetOptions);
    const minFundsDamage = -data.unit.getCoUnitValue() * config.minAttackFunds;
    const usedUnits: Unit[] = [];
    let newFundsDamage = -Infinity, newHpDamage = -Infinity;

    for (const damageData of targets) {
      const newEnemy = ai.map.getTerrain(damageData.x, damageData.y).getUnit();
      const sameTile = moveTarget.x === damageData.x && moveTarget.y === damageData.y;
      if (newEnemy === enemy && !sameTile && newEnemy !== null) {
        const newHp = enemy.getHp() - damageData.hpDamage;
        const funds = Math.trunc(
          damageData.fundsDamage * calculateCaptureBonus(context, enemy, newHp));
        if (funds > minFundsDamage && funds > newFundsDamage) {
          newFundsDamage = funds;
          newHpDamage = damageData.hpDamage;
        }
      } else if (newEnemy !== null && newEnemy !== enemy && !usedUnits.includes(newEnemy)) {
        // A friend with a better target of its own is not really support.
        if (newEnemy.getCoUnitValue() >= config.cheapUnitValue) usedUnits.push(newEnemy);
      }
    }
    if (newFundsDamage > minFundsDamage) {
      supportDamage += newFundsDamage / (usedUnits.length + 1) * config.supportDamageBonus;
      hpDamage += newHpDamage / (usedUnits.length + 1) * config.supportDamageBonus;
    }
  }
  return { supportDamage, hpDamage };
}

/**
 * ai/normalai.cpp: NormalAi::getBestAttackTarget -- which of the scored attacks
 * to actually make, or -1 for none worth making.
 *
 * Ties break on terrain defence, so given two equal trades the unit takes the
 * one that leaves it standing somewhere better.
 */
export function getBestAttackTarget(
  context: ScoringContext, unitData: MoveUnitData,
  targets: readonly DamageData[], moveTargetFields: readonly MoveTargetField[],
  buildings: readonly BuildingHost[], enemyBuildings: readonly BuildingHost[],
): number {
  const { ai } = context;
  const { config } = ai;
  const unit = unitData.unit;
  let best = -1, currentDamage = -Number.MAX_SAFE_INTEGER, defense = 0;
  const minFundsDamage = -unitData.unitCosts * config.minAttackFunds;

  for (let i = 0; i < targets.length; i++) {
    const moveTarget = { x: moveTargetFields[i].x, y: moveTargetFields[i].y };
    const enemy = ai.map.getTerrain(targets[i].x, targets[i].y).getUnit();
    const minFireRange = unit.getMinRange(moveTarget);
    let fundsDamage = 0, bonusDamage = 0;

    if (enemy !== null) {
      const newHp = enemy.getHp() - targets[i].hpDamage;
      fundsDamage = Math.trunc(
        targets[i].fundsDamage * calculateCaptureBonus(context, enemy, newHp));
      if (fundsDamage > minFundsDamage && newHp > 0) {
        // The support scan asks what the board looks like after this attack.
        enemy.setVirtualHpValue(newHp);
        const support = getOwnSupportDamage(context, unit, moveTarget, enemy);
        fundsDamage += support.supportDamage;
        bonusDamage = support.hpDamage;
        enemy.setVirtualHpValue(0);
      }
      if (minFireRange > 1) fundsDamage *= config.ownIndirectAttackValue;
      if (newHp <= 0) fundsDamage *= config.enemyKillBonus;
      if (enemy.getMinRange({ x: enemy.getX(), y: enemy.getY() }) > 1) {
        fundsDamage *= config.enemyIndirectBonus;
      }
      if (unitData.range !== null
        && !ai.isMoveableTile(ai.map.getTerrain(moveTarget.x, moveTarget.y).getBuilding(), unitData.range)) {
        fundsDamage -= config.ownProdctionMalus;
      }
    } else {
      fundsDamage = targets[i].fundsDamage;
    }

    let counterDamage = calculateCounterDamage(
      context, unitData, moveTarget, enemy, targets[i].hpDamage + bonusDamage,
      buildings, enemyBuildings, true);
    const stillThere = unitData.range?.tiles.has(`${unit.getX()},${unit.getY()}`) ?? false;
    if (counterDamage < 0 || !stillThere) counterDamage = 0;
    fundsDamage -= counterDamage;

    const targetDefense = ai.map.getTerrain(targets[i].x, targets[i].y).getDefense(unit);
    if (fundsDamage < minFundsDamage) continue;
    if (targets[i].hpDamageDifference < config.minHpDamage) continue;
    if (fundsDamage > currentDamage
      || (fundsDamage === currentDamage && targetDefense > defense)) {
      currentDamage = fundsDamage;
      best = i;
      defense = targetDefense;
    }
  }
  return best;
}
