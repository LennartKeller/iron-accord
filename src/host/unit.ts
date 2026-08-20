import type { GameMap } from './gamemap.ts';
import type { Player } from './player.ts';
import type { Terrain } from './terrain.ts';
import type { QPoint } from './globals.ts';
import { MAX_UNIT_HP } from './enums.ts';
import { ScriptVariables } from './variables.ts';

const clamp = (value: number, min: number, max: number) =>
  value < min ? min : (max > 0 && value > max ? max : value);

/**
 * Host-side Unit. Mirrors the Q_INVOKABLE surface of game/unit.h that the
 * scripts actually call; the rest of unit.h is engine/rendering concerns.
 */
export class Unit {
  hp = 10;
  virtualHp = 10;
  ammo1 = 0; maxAmmo1 = 0; weapon1ID = '';
  ammo2 = 0; maxAmmo2 = 0; weapon2ID = '';
  fuel = 0; maxFuel = 0;
  baseMovementPoints = 0;
  minRange = 1; maxRange = 1;
  vision = 1; visionHigh = 0;
  cursorInfoRange = 0;
  hidden = false;
  ignoreUnitCollision = false;
  hasMoved = false;
  capturePoints = 0;
  customRange: unknown[] = [];
  /** Populated by the unit script's loadSprites(). */
  readonly sprites: Array<{ id: string; kind: 'base'; palette: string; recoloring: number }> = [];
  rank = 0;
  /**
   * Stable per-map identity. Actions reference units by this rather than by
   * object, so an action stays meaningful across a snapshot/restore cycle.
   */
  uid: number;
  /** Script-owned key/value store (ScriptVariables in the C++). */
  readonly variables = new ScriptVariables();
  cloaked = false;
  coUnit = -1;
  customName = '';
  readonly offensiveBonus: Array<{ value: number; duration: number }> = [];
  readonly defensiveBonus: Array<{ value: number; duration: number }> = [];
  readonly movementBonus: Array<{ value: number; duration: number }> = [];
  readonly visionBonus: Array<{ value: number; duration: number }> = [];
  /** Units carried by a transport. */
  readonly loaded: Unit[] = [];

  readonly map: GameMap;
  readonly unitID: string;
  private owner: Player;
  x: number;
  y: number;

  constructor(map: GameMap, unitID: string, owner: Player, x: number, y: number) {
    this.map = map;
    this.unitID = unitID;
    this.owner = owner;
    this.x = x;
    this.y = y;
    this.uid = map.nextUnitUid();
    map.registry[unitID]?.init?.(this, map);
  }

  // --- setters called from a unit script's init() ---
  setAmmo1(v: number) { this.ammo1 = clamp(v, 0, this.maxAmmo1); }
  setMaxAmmo1(v: number) { this.maxAmmo1 = v; }
  setWeapon1ID(v: string) { this.weapon1ID = v; }
  setAmmo2(v: number) { this.ammo2 = clamp(v, 0, this.maxAmmo2); }
  setMaxAmmo2(v: number) { this.maxAmmo2 = v; }
  setWeapon2ID(v: string) { this.weapon2ID = v; }
  /**
   * game/unit.cpp: Unit::setFuel clamps against maxFuel but NOT against zero —
   * fuel is allowed to go negative, and GameMap::checkFuel destroys those units
   * at their owner's next turn. Flooring at zero here is what made aircraft
   * immortal.
   */
  setFuel(v: number) { this.fuel = this.maxFuel > 0 ? Math.min(v, this.maxFuel) : v; }
  setMaxFuel(v: number) { this.maxFuel = v; }
  setBaseMovementPoints(v: number) { this.baseMovementPoints = v; }
  setBaseMovementPointsHigh(v: number) { this.baseMovementPoints = v; }
  setMinRange(v: number) { this.minRange = v; }
  setMaxRange(v: number) { this.maxRange = v; }
  setMinRangeHigh(v: number) { this.minRange = v; }
  setMaxRangeHigh(v: number) { this.maxRange = v; }
  setVision(v: number) { this.vision = v; }
  setVisionHigh(v: number) { this.visionHigh = v; }
  setCursorInfoRange(v: number) { this.cursorInfoRange = v; }
  setHidden(v: boolean) { this.hidden = v; }
  setIgnoreUnitCollision(v: boolean) { this.ignoreUnitCollision = v; }
  setHp(v: number) { this.hp = Math.min(v, MAX_UNIT_HP); this.virtualHp = this.hp; }
  setVirtualHpValue(v: number) { this.virtualHp = v; }
  setCapturePoints(v: number) { this.capturePoints = v; }
  setHasMoved(v: boolean) { this.hasMoved = v; }
  showCustomRange(...args: unknown[]) { this.customRange = args; }

  /**
   * Unit scripts call this once per layer: a "+mask" sprite that the engine
   * recolours to the player colour, then a plain sprite that already carries the
   * army's default colours.
   */
  loadSpriteV2(spriteID: string, recoloring = 0): void {
    this.sprites.push({ id: spriteID, kind: 'base', palette: '', recoloring });
  }
  loadSprite(spriteID: string): void { this.loadSpriteV2(spriteID, 0); }

  // --- getters ---
  getUnitID(): string { return this.unitID; }
  getOwner(): Player { return this.owner; }
  setOwner(p: Player) { this.owner = p; }
  getMap(): GameMap { return this.map; }
  getX(): number { return this.x; }
  getY(): number { return this.y; }
  getWeapon1ID(): string { return this.weapon1ID; }
  getWeapon2ID(): string { return this.weapon2ID; }
  getAmmo1(): number { return this.ammo1; }
  getAmmo2(): number { return this.ammo2; }
  getMaxAmmo1(): number { return this.maxAmmo1; }
  getMaxAmmo2(): number { return this.maxAmmo2; }
  getFuel(): number { return this.fuel; }
  getMaxFuel(): number { return this.maxFuel; }
  getHp(): number { return this.hp; }
  getHpRounded(): number { return Math.ceil(this.hp); }
  getVirtualHp(): number { return this.virtualHp; }
  getVirtualHpValue(): number { return this.virtualHp; }
  getTerrain(): Terrain { return this.map.getTerrain(this.x, this.y); }
  getWeatherImmune(): boolean { return false; }

  /** game/unit.cpp: Unit::getUnitDamageID() — empty script result means "use my own id". */
  getUnitDamageID(): string {
    const result = this.map.registry[this.unitID]?.getUnitDamageID?.(this, this.map);
    return typeof result === 'string' && result !== '' ? result : this.unitID;
  }

  getUnitDamage(weaponID: string): number {
    const result = this.map.registry[this.unitID]?.getUnitDamage?.(weaponID, this, this.map);
    return typeof result === 'number' ? result : -1;
  }

  useTerrainDefense(): boolean {
    const result = this.map.registry[this.unitID]?.useTerrainDefense?.(this, this.map);
    return typeof result === 'boolean' ? result : true;
  }

  /** CO-driven in C++; zero until COs land. */
  getTerrainDefenseModifier(_position: QPoint): number { return 0; }

  /** game/unit.cpp: Unit::getTerrainDefense(x, y) */
  getTerrainDefense(x: number, y: number): number {
    const tx = x < 0 ? this.x : x;
    const ty = y < 0 ? this.y : y;
    return this.useTerrainDefense() ? this.map.getTerrain(tx, ty).getDefense(this) : 0;
  }

  /**
   * game/unit.cpp: Unit::getBonusDefensive(...)
   * Implemented: terrain defense (with the HP-reduction malus), field bonuses,
   * weather. Not yet implemented: CO bonuses, owned-building bonuses, ranking.
   */
  getBonusDefensive(
    action: unknown, position: QPoint, attacker: Unit | null, atkPosition: QPoint,
    isAttacker: boolean, luckMode: number,
  ): number {
    let bonus = 0;
    if (this.useTerrainDefense()) {
      const hpReductionMalus = this.map.getGameRules().getHpDefenseReduction()
        ? this.getHpRounded() / MAX_UNIT_HP
        : 1;
      bonus += this.getTerrainDefense(position.x, position.y)
             * this.map.getGameRules().getTerrainDefense()
             * hpReductionMalus;
    }
    bonus += this.defensiveBonus.reduce((sum, entry) => sum + entry.value, 0);
    const terrain = this.map.getTerrain(position.x, position.y);
    const building = terrain.getBuilding();
    bonus += building
      ? building.getDeffensiveFieldBonus(action, attacker, atkPosition, this, position, isAttacker, luckMode)
      : terrain.getDeffensiveFieldBonus(action, attacker, atkPosition, this, position, isAttacker, luckMode);

    // Owned buildings elsewhere on the map can add a flat defensive bonus.
    for (let y = 0; y < this.map.height; y++) {
      for (let x = 0; x < this.map.width; x++) {
        const owned = this.map.getTerrain(x, y).getBuilding();
        if (owned && owned.getOwner() === this.owner) bonus += owned.getDefensiveBonus();
      }
    }

    if (!this.getWeatherImmune()) {
      bonus += this.map.getGameRules().getCurrentWeather().getDefensiveModifier();
    }
    return bonus;
  }

  /** game/unit.cpp: Unit::getBonusOffensive(...) — same coverage caveats. */
  getBonusOffensive(
    action: unknown, position: QPoint, defender: Unit | null, defPosition: QPoint,
    isDefender: boolean, luckMode: number,
  ): number {
    let bonus = 0;
    const terrain = this.map.getTerrain(position.x, position.y);
    const building = terrain.getBuilding();
    bonus += building
      ? building.getOffensiveFieldBonus(action, this, position, defender, defPosition, isDefender, luckMode)
      : terrain.getOffensiveFieldBonus(action, this, position, defender, defPosition, isDefender, luckMode);
    // Timed buffs from support units and CO powers.
    bonus += this.offensiveBonus.reduce((sum, entry) => sum + entry.value, 0);
    if (!this.getWeatherImmune()) {
      bonus += this.map.getGameRules().getCurrentWeather().getOffensiveModifier();
    }
    return bonus;
  }

  // --- movement ---------------------------------------------------------

  /** The unit script's movement type, e.g. "MOVE_FEET". */
  getMovementType(): string {
    const result = this.map.registry[this.unitID]?.getMovementType?.();
    return typeof result === 'string' ? result : '';
  }

  /**
   * game/unit.cpp: Unit::getVision adds the terrain's bonus vision — infantry on
   * a mountain see 5 tiles rather than 2, which is the classic scouting play.
   */
  getVision(position?: QPoint): number {
    const x = position?.x ?? this.x;
    const y = position?.y ?? this.y;
    let vision = this.vision;
    if (this.map.onMap(x, y)) {
      const terrain = this.map.getTerrain(x, y);
      const bonus = this.map.registry[terrain.getID()]?.getBonusVision?.(this, terrain, this.map);
      if (typeof bonus === 'number') vision += bonus;
    }
    vision += this.visionBonus.reduce((sum, entry) => sum + entry.value, 0);
    return Math.max(0, vision);
  }

  getBonusMovementpoints(_position?: QPoint): number {
    return this.movementBonus.reduce((sum, bonus) => sum + bonus.value, 0);
  }

  /** game/unit.cpp: Unit::getMovementpoints — fuel caps the range. */
  getMovementpoints(position?: QPoint): number {
    const points = Math.max(0, this.baseMovementPoints + this.getBonusMovementpoints(position));
    return this.fuel < points ? this.fuel : points;
  }

  /**
   * game/unit.cpp: Unit::getBaseMovementCosts — asks the movement table script.
   * A negative result means the tile is impassable for this movement type.
   */
  getBaseMovementCosts(x: number, y: number, curX = -1, curY = -1): number {
    const table = this.map.registry[this.getMovementType()];
    if (!table?.getMovementpoints) return -1;
    const target = this.map.getTerrain(x, y);
    const current = curX >= 0 && curY >= 0 ? this.map.getTerrain(curX, curY) : target;
    const result = table.getMovementpoints(target, this, current, false, this.map);
    return typeof result === 'number' ? result : -1;
  }

  /**
   * game/unit.cpp: Unit::getMovementCosts. CO, terrain and weather modifiers are
   * all zero until those systems land, so this currently equals the base cost.
   */
  getMovementCosts(x: number, y: number, curX = -1, curY = -1): number {
    return this.getBaseMovementCosts(x, y, curX, curY);
  }

  /**
   * game/unit.cpp: Unit::moveUnitAction — spends fuel equal to the action's
   * movement cost and relocates the unit to the end of its path. This is what
   * every action script calls through UNIT.moveUnit.
   */
  moveUnitAction(action: { getCosts(): number; getMovePath(): Array<{ x: number; y: number }> }): void {
    const cost = Math.max(0, action.getCosts());
    this.fuel = Math.max(0, this.fuel - cost);
    // game/unit.cpp: Unit::moveUnit only relocates when the path has more than
    // one point. Relocating unconditionally would re-run moveUnitToField for a
    // unit acting in place — which now resets capture points, so a capture
    // could never accumulate past one tick.
    const path = action.getMovePath();
    const destination = path.at(-1);
    if (path.length > 1 && destination) this.moveUnitToField(destination.x, destination.y);
  }

  /**
   * game/unit.cpp: Unit::moveUnitToField resets capture points first. Without
   * that, a unit can bank capture progress on one building and spend it on
   * another, and driving a capturer off a property costs the attacker nothing.
   */
  moveUnitToField(x: number, y: number): void {
    this.setCapturePoints(0);
    this.x = x;
    this.y = y;
  }

  /** Vision is recomputed wholesale after each action, so this is a no-op. */
  createMoveVisionAction(_action: unknown): void {}

  getIgnoreUnitCollision(): boolean { return this.ignoreUnitCollision; }
  getHasMoved(): boolean { return this.hasMoved; }
  setUnitVisible(_value: boolean, _player?: unknown): void {}
  getPosition(): QPoint { return { x: this.x, y: this.y }; }
  getUnitRank(): number { return this.rank; }
  setUnitRank(value: number): void { this.rank = value; }
  setUnitRankHigh(value: number): void { this.rank = value; }

  // --- combat -----------------------------------------------------------

  /** The action ids this unit's script offers, e.g. ACTION_FIRE, ACTION_CAPTURE. */
  getActionList(): string[] {
    const list = this.map.registry[this.unitID]?.actionList;
    return Array.isArray(list) ? [...list] : [];
  }

  getMinRange(_position?: QPoint): number { return this.minRange; }
  getMaxRange(_position?: QPoint): number { return this.maxRange; }
  /**
   * game/unit.cpp: Unit::hasWeapons — whether the unit is armed at all.
   *
   * Range is not the test: every unit script calls setMinRange/setMaxRange,
   * armed or not, so an APC declares range 1 while carrying no weapon.
   */
  hasWeapons(): boolean { return this.weapon1ID !== '' || this.weapon2ID !== ''; }

  hasAmmo1(): boolean { return this.maxAmmo1 <= 0 || this.ammo1 > 0; }
  hasAmmo2(): boolean { return this.maxAmmo2 <= 0 || this.ammo2 > 0; }
  hasDirectWeapon(): boolean { return this.maxRange <= 1; }
  /**
   * Whether the unit may move and still attack. This is a per-unit script
   * decision, not a range test: battleships, carriers, cruisers and gunboats all
   * say yes despite being indirect.
   */
  canMoveAndFire(_position?: QPoint): boolean {
    const result = this.map.registry[this.unitID]?.canMoveAndFire?.(this, this.map);
    if (typeof result === 'boolean') return result;
    return this.hasDirectWeapon();
  }

  canAttackWithWeapon(weaponIndex: number, atkX: number, atkY: number, defX: number, defY: number): boolean {
    const weaponID = weaponIndex === 0 ? this.weapon1ID : this.weapon2ID;
    if (!weaponID) return false;
    const distance = Math.abs(atkX - defX) + Math.abs(atkY - defY);
    return distance >= this.getMinRange() && distance <= this.getMaxRange();
  }

  /**
   * game/unit.cpp: Unit::isAttackable — an enemy this unit can actually hurt.
   *
   * `position` is the attacker's tile by default; when `isDefenderPos` is set it
   * is the *defender's* tile instead and the attacker uses its own. ACTION_FIRE
   * relies on that second form to ask "could the defender hit back?".
   */
  isAttackable(
    defender: Unit | null,
    ignoreOutOfVisionRange = false,
    position?: QPoint,
    isDefenderPos = false,
  ): boolean {
    if (!defender || defender === this) return false;
    if (!this.getOwner().isEnemyUnit(defender)) return false;
    if (!ignoreOutOfVisionRange
        && this.getOwner().getFieldVisibleType(defender.x, defender.y) !== 2 /* Clear */) {
      return false;
    }
    // A hidden unit can only be hit by something that can see it.
    if (!ignoreOutOfVisionRange && defender.isStealthed(this.getOwner())) return false;
    if (defender.isStatusStealthed() && !this.canAttackStealthedUnit(defender)) return false;
    if (isDefenderPos && position) {
      return this.canReach(position, { x: this.x, y: this.y }, defender);
    }
    const from = position ?? { x: this.x, y: this.y };
    for (const [index, weaponID] of [[0, this.weapon1ID], [1, this.weapon2ID]] as Array<[number, string]>) {
      if (!weaponID) continue;
      if (index === 0 && !this.hasAmmo1()) continue;
      if (index === 1 && !this.hasAmmo2()) continue;
      if (!this.canAttackWithWeapon(index, from.x, from.y, defender.x, defender.y)) continue;
      const damage = this.map.registry[weaponID]?.getBaseDamage?.(defender);
      if (typeof damage === 'number' && damage > 0) return true;
    }
    return false;
  }

  isAttackableFromPosition(defender: Unit | null, position: QPoint): boolean {
    return this.isAttackable(defender, false, position);
  }

  /** Shared weapon/range/damage test between the two isAttackable forms. */
  private canReach(defenderPos: QPoint, attackerPos: QPoint, defender: Unit): boolean {
    for (const [index, weaponID] of [[0, this.weapon1ID], [1, this.weapon2ID]] as Array<[number, string]>) {
      if (!weaponID) continue;
      if (index === 0 && !this.hasAmmo1()) continue;
      if (index === 1 && !this.hasAmmo2()) continue;
      if (!this.canAttackWithWeapon(index, attackerPos.x, attackerPos.y, defenderPos.x, defenderPos.y)) continue;
      const damage = this.map.registry[weaponID]?.getBaseDamage?.(defender);
      if (typeof damage === 'number' && damage > 0) return true;
    }
    return false;
  }

  /**
   * game/unit.cpp: Unit::canCounterAttack — adjacency alone allows a counter;
   * anything further asks the unit script. CO modifiers are not applied yet.
   */
  canCounterAttack(
    action: unknown, position: QPoint, defender: Unit | null, defPosition: QPoint, luckMode: number,
  ): boolean {
    const adjacent = Math.abs(position.x - defPosition.x) + Math.abs(position.y - defPosition.y) === 1;
    if (adjacent) return true;
    const script = this.map.registry[this.unitID];
    const result = script?.canCounterOnRangeAttacks?.(
      this, position.x, position.y, defender, defPosition.x, defPosition.y, action, luckMode, this.map);
    return result === true;
  }

  /** Build cost from the unit script; battle uses it for power-meter gain. */
  getCosts(): number {
    const value = this.map.registry[this.unitID]?.getBaseCost?.(this, this.map);
    return typeof value === 'number' ? value : 0;
  }

  reduceAmmo1(amount: number): void {
    if (this.maxAmmo1 > 0) this.ammo1 = Math.max(0, this.ammo1 - amount);
  }
  reduceAmmo2(amount: number): void {
    if (this.maxAmmo2 > 0) this.ammo2 = Math.max(0, this.ammo2 - amount);
  }

  /** No CO or terrain grants first strike yet. */
  getFirstStrike(): boolean { return false; }

  /** Marks the unit dead; Game.cleanupDead takes it off the board. */
  killUnit(): void {
    this.hp = 0;
    this.virtualHp = 0;
  }

  /** Death hooks, run once as the unit leaves the board. */
  onDeath(): void {
    const script = this.map.registry[this.unitID];
    try { script?.onKilled?.(this, this.map); } catch { /* optional */ }
    try { script?.onDeath?.(this, this.map); } catch { /* optional */ }
    try {
      this.map.registry.PLAYER?.onUnitDeath?.(this.getOwner(), this, this.map);
    } catch { /* optional */ }
  }

  postBattleActions(): void {}

  // --- turn start / repair ----------------------------------------------

  /**
   * game/unit.cpp: Unit::startOfTurn — the unit script's upkeep hook. This is
   * where aircraft and ships burn fuel, so skipping it means they fly forever.
   *
   * Failures are reported rather than swallowed: a missing host method here
   * silently disables upkeep, which is exactly the kind of gap that is hard to
   * notice from the outside.
   */
  startOfTurn(): void {
    this.tickBonusDurations();
    try {
      this.map.registry[this.unitID]?.startOfTurn?.(this, this.map);
    } catch (error) {
      console.warn(`${this.unitID}.startOfTurn failed`, error);
    }
    for (const carried of this.loaded) carried.startOfTurn();
  }

  /** game/unit.cpp: Unit::endOfTurn — the script's end-of-turn hook. */
  endOfTurn(): void {
    try { this.map.registry[this.unitID]?.endOfTurn?.(this, this.map); }
    catch (error) { console.warn(`${this.unitID}.endOfTurn failed`, error); }
    for (const carried of this.loaded) carried.endOfTurn();
  }

  /**
   * game/unit.cpp: Unit::updateUnitStatus — timed buffs count down at the start
   * of their owner's turn and drop off at zero. Without this a buff granted once
   * would last forever.
   */
  private tickBonusDurations(): void {
    for (const list of [this.offensiveBonus, this.defensiveBonus, this.movementBonus, this.visionBonus]) {
      for (const entry of list) entry.duration -= 1;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].duration <= 0) list.splice(i, 1);
      }
    }
  }

  /** game/unit.cpp: Unit::refill — tops up fuel and ammo by a fraction of max. */
  refill(noMaterial = false, fuelAmount = 1, ammo1Amount = 1, ammo2Amount = 1): void {
    this.setFuel(this.fuel + this.maxFuel * fuelAmount);
    if (!(noMaterial && this.weapon1ID === '')) this.setAmmo1(this.ammo1 + this.maxAmmo1 * ammo1Amount);
    if (!(noMaterial && this.weapon2ID === '')) this.setAmmo2(this.ammo2 + this.maxAmmo2 * ammo2Amount);
  }

  canBeRepaired(_position?: QPoint): boolean {
    const result = this.map.registry[this.unitID]?.canBeRepaired?.(this, this.map);
    return typeof result === 'boolean' ? result : true;
  }

  getRepairBonus(_position?: QPoint): number { return 0; }

  // Timed combat buffs. Durations tick down at turn start; without these the
  // buff simply never applies and the script that granted it aborts.
  addOffensiveBonus(value: number, duration: number): void {
    this.offensiveBonus.push({ value, duration });
  }
  addDefensiveBonus(value: number, duration: number): void {
    this.defensiveBonus.push({ value, duration });
  }
  addMovementBonus(value: number, duration: number): void {
    this.movementBonus.push({ value, duration });
  }
  addVisionBonus(value: number, duration: number): void {
    this.visionBonus.push({ value, duration });
  }

  getCloaked(): boolean { return this.cloaked; }
  setCloaked(cloaked: boolean): void { this.cloaked = cloaked; }
  removeCloaked(): void { this.cloaked = false; }

  /** Promotes a unit to a CO unit (ACTION_JOIN, ACTION_CO_UNIT_*). */
  makeCOUnit(co: number, _force = false): void { this.coUnit = co; }

  getTransportUnits(): string[] {
    const list = this.map.registry[this.unitID]?.getTransportUnits?.(this, this.map)
      ?? this.map.registry[this.unitID]?.transportList;
    return Array.isArray(list) ? [...list] : [];
  }
  getBaseMaxRange(): number { return this.maxRange; }
  setCustomName(name: string): void { this.customName = name; }
  getCustomName(): string { return this.customName; }
  unloadIcon(): void {}
  unloadIconAndDuration(): void {}
  createMoveVisionFromAction(): void {}

  /** CO/terrain modifier on per-turn fuel upkeep; none of those exist yet. */
  getFuelCostModifier(_position?: QPoint, _baseCost = 0): number { return 0; }

  getHidden(): boolean { return this.hidden; }
  getVariables() { return this.variables; }
  loadIcon(): void {}
  getRepairCostModifier(): number { return 1; }
  getUnitCosts(): number { return this.getCosts(); }

  /** Movement-type family the repair rules match on (BUILDING.getRepairTypes). */
  getUnitType(): number {
    const result = this.map.registry[this.unitID]?.getUnitType?.(this, this.map);
    return typeof result === 'number' ? result : -1;
  }

  /** Does this unit benefit from concealing terrain? (UNIT.useTerrainHide) */
  useTerrainHide(): boolean {
    const result = this.map.registry[this.unitID]?.useTerrainHide?.(this, this.map);
    return typeof result === 'boolean' ? result : true;
  }

  /** Actively hidden — a dived submarine or a stealthed bomber. */
  isStatusStealthed(): boolean { return this.hidden; }

  /**
   * game/unit.cpp: Unit::isStealthed — hidden from `player`, either because
   * they cannot see the tile at all, or because concealing terrain hides the
   * unit from anyone not standing adjacent.
   */
  isStealthed(player?: Player | null, ignoreOutOfVisionRange = false): boolean {
    if (!player || !player.isEnemy(this.getOwner())) return false;
    if (ignoreOutOfVisionRange) return false;
    if (!this.map.onMap(this.x, this.y)) return false;

    if (!player.getFieldVisible(this.x, this.y)) return true;
    if (this.isStatusStealthed()) return true;

    if (this.useTerrainHide() && this.map.getTerrain(this.x, this.y).getVisionHide(player)) {
      // Concealing terrain still gives away a unit to an adjacent observer.
      const adjacent = player.units.some(other =>
        Math.abs(other.x - this.x) + Math.abs(other.y - this.y) <= 1);
      return !adjacent;
    }
    return false;
  }

  /** Only units whose script says so can hit an actively hidden target. */
  canAttackStealthedUnit(defender: Unit): boolean {
    const result = this.map.registry[this.unitID]?.canAttackStealthedUnit?.(this, defender, this.map);
    return result === true;
  }

  // --- capture ----------------------------------------------------------

  getCapturePoints(): number { return this.capturePoints; }

  /**
   * game/unit.cpp: capture rate is the unit's rounded HP, so a damaged unit
   * captures more slowly.
   */
  increaseCapturePoints(_position?: QPoint): void {
    this.capturePoints += this.getHpRounded();
  }

  // --- transport --------------------------------------------------------

  getLoadedUnitCount(): number { return this.loaded.length; }
  getLoadedUnit(index: number): Unit | null { return this.loaded[index] ?? null; }
  /**
   * game/unit.cpp: Unit::loadUnit — cargo leaves the board entirely while it is
   * being carried, which is what makes it untargetable.
   */
  loadUnit(unit: Unit): void {
    if (this.loaded.length >= this.getLoadingPlace()) return;
    this.map.removeUnit(unit);
    unit.hasMoved = true;
    unit.setCapturePoints(0);
    this.loaded.push(unit);
  }

  /** Puts a carried unit back on the board at `position`. */
  unloadUnit(unit: Unit, position?: QPoint): void {
    const index = this.loaded.indexOf(unit);
    if (index < 0) return;
    this.loaded.splice(index, 1);
    if (position) {
      unit.x = position.x;
      unit.y = position.y;
      this.map.reAddUnit(unit);
      unit.hasMoved = true;
    }
  }

  /** Can this transport carry that unit, given its list and remaining space? */
  canLoad(unit: Unit): boolean {
    if (unit === this) return false;
    if (unit.getOwner() !== this.getOwner()) return false;
    if (this.loaded.length >= this.getLoadingPlace()) return false;
    return this.getTransportUnits().includes(unit.getUnitID());
  }
  getLoadingPlace(): number {
    const value = this.map.registry[this.unitID]?.getLoadingPlace?.(this, this.map);
    return typeof value === 'number' ? value : 0;
  }

  getAttackHpBonus(_position: QPoint): number { return 0; }
  getBonusLuck(_position: QPoint): number { return 0; }
  getBonusMisfortune(_position: QPoint): number { return 0; }
  getTrueDamage(): number { return 0; }
  getDamageReduction(): number { return 0; }
}
