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
  /** GameEnums::GameAi -- 0 is AiMode_Normal, the only value we produce. */
  aiMode = 0;
  /** Higher moves first; 0 keeps the AI's own ordering. */
  aiPriority = 0;
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
  /** Lazily resolved movement type; see getBaseMovementCosts. */
  private movementTypeCache: string | null = null;

  readonly map: GameMap;
  readonly unitID: string;
  private owner: Player;
  // Position is an accessor pair so ANY assignment — moveUnitToField, unload,
  // snapshot restore — invalidates the map's tile→unit index. A missed
  // invalidation here would silently corrupt occupancy checks, so the backing
  // fields are written only by these setters.
  private xValue = 0;
  private yValue = 0;
  get x(): number { return this.xValue; }
  set x(value: number) {
    this.xValue = value;
    this.map.markUnitsDirty();
  }
  get y(): number { return this.yValue; }
  set y(value: number) {
    this.yValue = value;
    this.map.markUnitsDirty();
  }

  constructor(map: GameMap, unitID: string, owner: Player, x: number, y: number) {
    // map must be set first: the x/y setters dirty its unit index.
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
    const map = this.map;
    // Movement type never changes for a unit id (the scripts answer with a
    // literal), so resolve it once per unit and skip the map lookup after.
    const type = this.movementTypeCache ?? (this.movementTypeCache = map.movementTypeOf(this));
    const entry = map.moveCostEntry(type);
    const table = entry.table;
    if (!table?.getMovementpoints) return -1;
    // Fast path: for tables that promise per-tile costs (getSupportsFastPfs,
    // the same contract the desktop engine's fast pathfinding keys on) the
    // answer is cached per tile in the map, invalidated by its board version.
    // Two exclusions keep this exact: gate/fort tiles, whose cost depends on
    // the asking unit's alliance, are marked Infinity and always re-asked; and
    // off-map coordinates fall through so they throw exactly as before.
    if (entry.fast && map.onMap(x, y)) {
      const index = y * map.width + x;
      const cached = entry.costs[index];
      if (cached === cached) { // not NaN — already computed
        if (cached !== Infinity) return cached;
      } else {
        const target = map.getTerrain(x, y);
        const id = target.getID();
        if (id !== 'ZGATE_E_W' && id !== 'ZGATE_N_S' && id !== 'FORTHQ') {
          // currentTerrain is passed but unused by every fast table (only
          // MOVE_HOVERCRAFT reads it, and it opted out of fast pfs), so the
          // cached call may hand over the target tile in its place.
          const result = table.getMovementpoints(target, this, target, false, map);
          const value = typeof result === 'number' ? result : -1;
          entry.costs[index] = value;
          return value;
        }
        entry.costs[index] = Infinity;
      }
    }
    const target = map.getTerrain(x, y);
    const current = curX >= 0 && curY >= 0 ? map.getTerrain(curX, curY) : target;
    const result = table.getMovementpoints(target, this, current, false, map);
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
    return [...this.map.actionListOf(this.unitID)];
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

    // game/unit.cpp:3599 — status stealth (dived sub, stealthed bomber) and
    // terrain hide share one escape hatch: an observer on the adjacent ring
    // reveals the unit either way. Without it a dived submarine could never
    // be depth-charged by the cruiser standing right next to it.
    if (this.isStatusStealthed()
        || (this.useTerrainHide() && this.map.getTerrain(this.x, this.y).getVisionHide(player))) {
      // game/unit.cpp:3603 — getSpCircle(1, 1): the four tiles at manhattan
      // distance 1. Any unit there that is Alliance_Friend to the checking
      // player reveals us — allies count, not just the player's own units.
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        if (!this.map.onMap(this.x + dx, this.y + dy)) continue;
        const observer = this.map.getTerrain(this.x + dx, this.y + dy).getUnit();
        if (observer && player.isAlly(observer.getOwner())) return false;
      }
      return true;
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

  /**
   * game/unit.cpp: Unit::removeUnit — takes this unit off the board.
   *
   * Scripts call it on themselves: ACTION_JOIN merges one unit's fuel, ammo and
   * health into another and then removes the donor. Without this the donor
   * stayed, so a join handed out a free unit's worth of material — and because
   * the failure happened in an animation callback it was logged and swallowed
   * rather than thrown.
   *
   * `killed` distinguishes being destroyed from being consumed: only a death
   * runs the unit's onDeath hook and takes its passengers down with it.
   */
  removeUnit(killed = false): void {
    if (killed) {
      try { this.map.registry[this.unitID]?.onDeath?.(this, this.map); } catch { /* script gap */ }
      try { this.map.registry.PLAYER?.onUnitDeath?.(this.owner, this, this.map); } catch { /* ditto */ }
      // Passengers go down with the ship.
      for (const carried of [...this.loaded]) carried.removeUnit(true);
    }
    this.loaded.length = 0;
    this.map.removeUnit(this);
  }

  /**
   * game/unit.cpp: Unit::spawnUnit — creates a unit directly into this one's
   * hold, without a factory and without paying for it.
   *
   * This is how a carrier builds its own aircraft (ACTION_BUILD_WATERPLANE).
   * The unit limit still applies; unlike loadUnit there is nothing to remove
   * from the board first, because the unit has never been on it.
   */
  spawnUnit(unitID: string): Unit | null {
    const limit = this.map.getGameRules().getUnitLimit();
    if (limit > 0 && this.owner.getUnitCount() >= limit) return null;
    if (this.loaded.length >= this.getLoadingPlace()) return null;
    // The constructor runs the unit script's init, and cargo deliberately does
    // not join the owner's roster — the same end state loadUnit leaves.
    const unit = new Unit(this.map, unitID, this.owner, this.x, this.y);
    this.loaded.push(unit);
    return unit;
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

  // --- AI surface -------------------------------------------------------
  //
  // These are Q_INVOKABLE on game/unit.h but were never reached by the unit
  // scripts, so the host had no reason to carry them until the CoreAI port.
  // They are transcriptions, not new behaviour -- see src/ai/cw/README.md.

  /** game/unit.cpp: Unit::canMoveOver -- terrain is enterable at all, ignoring range. */
  canMoveOver(x: number, y: number): boolean {
    return this.getBaseMovementCosts(x, y, x, y) > 0;
  }

  /** game/unit.cpp: Unit::getUnitValue -- cost scaled by remaining health. */
  getUnitValue(): number {
    return Math.trunc(this.getCosts() * this.hp / MAX_UNIT_HP);
  }

  /**
   * game/unit.cpp: Unit::getCoUnitValue.
   *
   * A negative rank marks a CO unit in the C++. We never build one, so this
   * always equals getUnitValue() -- kept so the ported scoring reads 1:1.
   */
  getCoUnitValue(): number {
    const value = this.getUnitValue();
    return this.rank < 0 ? Math.trunc(value * 1.5) : value;
  }

  getBaseMovementPoints(): number { return this.baseMovementPoints; }

  /** game/unit.cpp: Unit::hasAction */
  hasAction(action: string): boolean { return this.getActionList().includes(action); }

  /** The carried units themselves, where getLoadedUnit(i) fetches one. */
  getLoadedUnits(): Unit[] { return this.loaded; }

  /**
   * game/unit.cpp: Unit::canTransportUnit.
   *
   * Differs from canLoad(): the AI asks this while planning, so it needs the
   * ignoreLoadingPlace form to tell "wrong kind of cargo" from "full right now",
   * and it deliberately does not check ownership.
   */
  canTransportUnit(unit: Unit, ignoreLoadingPlace = false): boolean {
    if (!this.getTransportUnits().includes(unit.getUnitID())) return false;
    return ignoreLoadingPlace || this.getLoadedUnitCount() < this.getLoadingPlace();
  }

  /**
   * game/unit.cpp: Unit::getEnvironmentDamage -- damage this unit deals to a
   * destructible terrain, which is how the AI decides to shoot a forest or a pipe.
   */
  getEnvironmentDamage(terrainID: string): number {
    // Game.environmentDamage inlines the same walk for ACTION_FIRE targeting;
    // this is the Unit-side entry point the AI uses while scoring.
    let damage = 0;
    for (const [hasAmmo, weaponID] of [
      [this.hasAmmo1(), this.weapon1ID],
      [this.hasAmmo2(), this.weapon2ID],
    ] as Array<[boolean, string]>) {
      if (!hasAmmo || weaponID === '') continue;
      let value: unknown;
      try { value = this.map.registry[weaponID]?.getEnviromentDamage?.(terrainID); }
      catch { continue; /* script gap */ }
      if (typeof value === 'number' && value > damage) damage = value;
    }
    return damage;
  }

  /**
   * game/unit.h: Unit::getAiMode / getAiPriority -- per-unit overrides a map
   * author can set to script an opponent. Nothing in our maps sets them, so
   * these hold the defaults and keep the ported branches live but inert.
   */
  getAiMode(): number { return this.aiMode; }
  setAiMode(mode: number): void { this.aiMode = mode; }
  getAiPriority(): number { return this.aiPriority; }
  setAiPriority(priority: number): void { this.aiPriority = priority; }

  /**
   * game/unit.cpp: Unit::isStatusStealthedAndInvisible -- hidden *and* actually
   * unseen by this player. The AI charges a malus for shooting at one, since a
   * unit it cannot see may not be where it thinks.
   *
   * Returns the verdict together with whether terrain (rather than a status) is
   * what is hiding it, which the C++ passes back through a reference parameter.
   */
  isStatusStealthedAndInvisible(player: Player): { hidden: boolean; terrainHide: boolean } {
    const terrainHide = this.hasTerrainHide(player);
    const hidden = (this.isStatusStealthed() || terrainHide) && this.isStealthed(player);
    return { hidden, terrainHide };
  }

  /** game/unit.cpp: Unit::hasTerrainHide -- hidden in woods/reef under fog. */
  hasTerrainHide(player: Player): boolean {
    if (this.map.getGameRules().getFogMode() === 0) return false;
    if (player.getFieldVisible(this.x, this.y)) return false;
    return this.getTerrain().getVisionHide(player) && this.useTerrainHide();
  }
}
