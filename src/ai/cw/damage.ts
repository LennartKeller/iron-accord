import { GameEnums, MAX_UNIT_HP, type BuildingHost, type GameMap, type Player, type Unit } from '../../host/index.ts';

/**
 * A battle outcome as Commander Wars packs it: one QRectF where `x`/`y` are the
 * attacker's damage and weapon index, and `width`/`height` the defender's
 * counter. A negative counter means there was none.
 */
export interface BattleResult { x: number; y: number; width: number; height: number }

export interface FundsDamageData {
  /** HP the defender loses, capped at what it has. */
  atkHpDamage: number;
  /** HP swing in the attacker's favour, counter-attack subtracted. */
  hpDamage: number;
  /** The same in funds, with own losses weighted by OwnUnitValue. */
  fundsDamage: number;
}

function isRect(value: unknown): value is BattleResult {
  return typeof value === 'object' && value !== null && typeof (value as BattleResult).x === 'number';
}

/**
 * Damage prediction, delegated to Commander Wars' own ACTION_FIRE script.
 *
 * Nothing about the battle formula is reimplemented here: `calcBattleDamage3` is
 * the same function the real attack runs, so a prediction and the attack it
 * predicts cannot drift apart. Only the caching and the scoring around it are
 * ported.
 */
export class DamagePredictor {
  /** Keyed weaponID + defender unit id, as the C++ keys m_baseDamageTable. */
  private readonly baseDamageTable = new Map<string, number>();

  private readonly map: GameMap;

  constructor(map: GameMap) { this.map = map; }

  /**
   * resource_management/weaponmanager.cpp: WeaponManager::getBaseDamage -- what
   * one weapon does to one unit type before any modifier. -1 means "this weapon
   * cannot hurt that at all", which is the signal the AI reads to call a unit
   * unattackable.
   */
  getWeaponBaseDamage(weaponID: string, defender: Unit): number {
    if (weaponID === '') return -1;
    let value: unknown;
    try { value = this.map.registry[weaponID]?.getBaseDamage?.(defender); }
    catch { return -1; /* script gap */ }
    return typeof value === 'number' ? value : -1;
  }

  /**
   * ai/coreai.cpp: CoreAI::getBaseDamage -- the better of the attacker's two
   * weapons against this defender, ignoring position, terrain and luck.
   */
  getBaseDamage(attacker: Unit, defender: Unit): number {
    const lookup = (weaponID: string): number => {
      const key = weaponID + defender.getUnitID();
      const cached = this.baseDamageTable.get(key);
      if (cached !== undefined) return cached;
      const value = this.getWeaponBaseDamage(weaponID, defender);
      this.baseDamageTable.set(key, value);
      return value;
    };
    const damage1 = attacker.hasAmmo1() ? lookup(attacker.getWeapon1ID()) : -1;
    const damage2 = attacker.hasAmmo2() ? lookup(attacker.getWeapon2ID()) : -1;
    return damage1 > damage2 ? damage1 : damage2;
  }

  /**
   * ai/coreai.cpp: CoreAI::calcUnitDamageFast.
   *
   * Note the counter half: upstream computes it with `getBaseDamage(pAttacker,
   * pDefender)` a second time rather than swapping the two, so the "counter"
   * it reports is really the attack repeated. That is transcribed rather than
   * corrected -- the AI is tuned against these numbers, and silently making
   * them right would change every decision that reads them.
   */
  calcUnitDamageFast(attacker: Unit, defender: Unit): BattleResult {
    const attack = this.getBaseDamage(attacker, defender);
    return { x: attack, y: 0, width: attack, height: 0 };
  }

  /**
   * ai/coreai.cpp: CoreAI::calcVirtuelUnitDamage -- a full battle prediction for
   * units standing anywhere, including ones not currently adjacent, so the AI
   * can score a move before making it.
   */
  calcVirtualUnitDamage(
    attacker: Unit, attackerTakenDamage: number, atkPos: { x: number; y: number },
    defender: Unit | null, defenderTakenDamage: number, defPos: { x: number; y: number },
    luckModeAtk: number = GameEnums.LuckDamageMode_Average,
    luckModeDef: number = GameEnums.LuckDamageMode_Average,
    ignoreOutOfVisionRange = false,
    fastInaccurate = false,
  ): BattleResult {
    let result: unknown;
    try {
      result = this.map.registry.ACTION_FIRE?.calcBattleDamage3(
        this.map, null, attacker, attackerTakenDamage, atkPos.x, atkPos.y,
        defender, defPos.x, defPos.y, defenderTakenDamage,
        luckModeAtk, luckModeDef, ignoreOutOfVisionRange, fastInaccurate);
    } catch { return { x: -1, y: 0, width: -1, height: 0 }; }
    return isRect(result) ? result : { x: -1, y: 0, width: -1, height: 0 };
  }

  /**
   * ai/coreai.cpp: CoreAI::calcBuildingDamage -- what a hostile cannon-type
   * building would do to a unit standing on a tile, in funds.
   */
  calcBuildingDamage(
    player: Player, unit: Unit, newPosition: { x: number; y: number }, building: BuildingHost,
  ): number {
    const targets = building.getBuildingTargets();
    const owner = building.getOwner();
    const applies = targets === GameEnums.BuildingTarget_All
      || (targets === GameEnums.BuildingTarget_Enemy && player.isEnemy(owner))
      || (targets === GameEnums.BuildingTarget_Own && player === owner);
    if (!applies) return 0;
    if (building.getFireCount() > 1 || owner === null) return 0;

    const offset = building.getActionTargetOffset();
    const position = building.getPosition();
    const relative = {
      x: newPosition.x - offset.x - position.x,
      y: newPosition.y - offset.y - position.y,
    };
    const fields = building.getActionTargetFields();
    if (fields === null) return 0;
    if (!fields.some(field => field.x === relative.x && field.y === relative.y)) return 0;

    let damage = building.getDamage(unit);
    // Upstream clamps overkill to the BUILDING's hp, not the unit's. Kept.
    if (damage > unit.getHp()) damage = building.getHp();
    return damage / MAX_UNIT_HP * unit.getUnitCosts();
  }
}

/**
 * ai/coreai.cpp: CoreAI::calcFundsDamage -- turns a predicted battle into the
 * single number the AI ranks attacks by: funds destroyed minus funds lost to
 * the counter-attack, with own losses scaled by the OwnUnitValue tunable.
 */
export function calcFundsDamage(
  damage: BattleResult, attacker: Unit, defender: Unit, ownUnitValue: number,
): FundsDamageData {
  let atkDamage = damage.x / MAX_UNIT_HP;
  if (atkDamage > defender.getHp()) atkDamage = defender.getHp();
  let hpDamage = atkDamage;
  let fundsDamage = defender.getUnitCosts() * atkDamage / MAX_UNIT_HP;
  if (damage.width >= 0) {
    hpDamage -= damage.width / MAX_UNIT_HP;
    let counterDamage = damage.width / MAX_UNIT_HP;
    if (counterDamage > attacker.getHp()) counterDamage = attacker.getHp();
    fundsDamage -= attacker.getUnitCosts() * counterDamage / MAX_UNIT_HP * ownUnitValue;
  }
  return { atkHpDamage: atkDamage, hpDamage, fundsDamage };
}
