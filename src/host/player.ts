import { QmlVector } from './qmlvector.ts';
import { GameEnums, MAX_UNIT_HP } from './enums.ts';
import { getCircle, type QPoint } from './globals.ts';
import type { Unit } from './unit.ts';
import type { GameMap } from './gamemap.ts';
import type { BuildingHost } from './building.ts';

/** GameEnums::RocketTarget -- what a silo strike is being scored for. */
export const RocketTarget_Money = 0;
export const RocketTarget_HpLowMoney = 1;
export const RocketTarget_HpHighMoney = 2;

export class Player {
  readonly units: Unit[] = [];
  /** Lazy cache behind getAverageCost(); negative means "not computed yet". */
  private averageCosts = -1;
  funds = 0;
  team = 0;
  isDefeated = false;
  color = '#ff0000';
  private buildList: string[] = [];

  readonly map: GameMap;
  private army: string;
  private readonly index: number;

  constructor(map: GameMap, army: string, index: number) {
    this.map = map;
    this.army = army;
    this.index = index;
  }

  getArmy(): string { return this.army; }
  setArmy(value: string): void { this.army = value; }
  getPlayerID(): number { return this.index; }
  getColor(): string { return this.color; }
  getFunds(): number { return this.funds; }
  getTeam(): number { return this.team; }
  getIsDefeated(): boolean { return this.isDefeated; }
  getUnits(): QmlVector<Unit> { return new QmlVector([...this.units]); }
  /**
   * game/player.cpp: Player::getUnitCount walks the board, so units riding in
   * a transport are not counted — they are not on a tile of their own.
   * Optionally narrowed to one unit id.
   */
  getUnitCount(unitID = ''): number {
    let count = 0;
    for (let y = 0; y < this.map.height; y++) {
      for (let x = 0; x < this.map.width; x++) {
        const unit = this.map.getTerrain(x, y).getUnit();
        if (!unit || unit.getOwner() !== this) continue;
        if (unitID === '' || unit.getUnitID() === unitID) count++;
      }
    }
    return count;
  }

  /**
   * game/player.cpp: Player::getBuildings — this player's buildings, optionally
   * narrowed to one building id.
   */
  getBuildings(id = ''): QmlVector<BuildingHost> {
    const owned: BuildingHost[] = [];
    for (let y = 0; y < this.map.height; y++) {
      for (let x = 0; x < this.map.width; x++) {
        const building = this.map.getTerrain(x, y).getBuilding();
        if (!building || building.getOwner() !== this) continue;
        if (id === '' || building.getBuildingID() === id) owned.push(building);
      }
    }
    return new QmlVector(owned);
  }

  /**
   * game/player.cpp: Player::getBuildingListCount. An empty list counts every
   * building this player owns; `whitelist = false` inverts the match.
   */
  getBuildingListCount(list: string[] = [], whitelist = true): number {
    let count = 0;
    for (let y = 0; y < this.map.height; y++) {
      for (let x = 0; x < this.map.width; x++) {
        const building = this.map.getTerrain(x, y).getBuilding();
        if (!building || building.getOwner() !== this) continue;
        const listed = list.includes(building.getBuildingID());
        if (list.length === 0 || listed === whitelist) count++;
      }
    }
    return count;
  }

  /**
   * game/player.cpp: Player::defeatPlayer. The loser's buildings pass to
   * `toPlayer` (null leaves them neutral) and its units are either handed over
   * — domination — or destroyed. A unit part-way through capturing a building
   * that just changed hands to its own side loses that progress.
   */
  defeatPlayer(toPlayer: Player | null, transferUnits = false): void {
    this.isDefeated = true;
    for (let y = 0; y < this.map.height; y++) {
      for (let x = 0; x < this.map.width; x++) {
        const terrain = this.map.getTerrain(x, y);
        const building = terrain.getBuilding();
        if (!building || building.getOwner() !== this) continue;
        building.setOwner(toPlayer);
        const sitting = terrain.getUnit();
        if (sitting && toPlayer && sitting.getOwner()?.isAlly(toPlayer)) {
          sitting.setCapturePoints(0);
        }
      }
    }
    for (const unit of [...this.units]) {
      if (toPlayer && transferUnits) {
        // Ownership is tracked in two places, so move it in both. The C++ also
        // promotes transferred units to their max rank; ranks are unimplemented.
        const index = this.units.indexOf(unit);
        if (index >= 0) this.units.splice(index, 1);
        unit.setOwner(toPlayer);
        if (!toPlayer.units.includes(unit)) toPlayer.units.push(unit);
        unit.setCapturePoints(0);
      } else {
        this.map.removeUnit(unit);
      }
    }
  }

  /** No CO support yet — see the CO milestone. */
  getCO(_index: number): null { return null; }
  getSpCO(_index: number): null { return null; }

  /**
   * game/player.cpp: teams decide alliance, not player identity — two players on
   * the same team are allies and cannot attack each other.
   */
  isAlly(player: Player | null): boolean {
    return player !== null && player.getTeam() === this.team;
  }
  isEnemy(player: Player | null): boolean {
    return player !== null && player.getTeam() !== this.team;
  }
  isEnemyUnit(unit: Unit): boolean { return this.isEnemy(unit.getOwner()); }
  getBaseGameInput() { return { getAiType: () => GameEnums.AiTypes_Human ?? 0 }; }

  /** game/player.cpp: Player::checkAlliance */
  checkAlliance(player: Player | null): number {
    return this.isAlly(player) ? GameEnums.Alliance_Friend : GameEnums.Alliance_Enemy;
  }

  // --- vision -----------------------------------------------------------
  // Delegated to the map's VisionMap so every player shares one computation.

  getFieldVisibleType(x: number, y: number): number {
    return this.map.vision.getFieldVisibleType(this, x, y);
  }
  getFieldVisible(x: number, y: number): boolean {
    return this.map.vision.getFieldVisible(this, x, y);
  }

  /** CO power meters are not implemented; battle calls this on every hit. */
  gainPowerstar(): void {}
  buildedUnit(): void {}
  postBattleActions(): void {}

  addFunds(amount: number): void { this.funds += amount; }

  /** Unit ids this player is allowed to build; empty means "everything". */
  getBuildList(): string[] { return [...this.buildList]; }
  setBuildList(list: string[]): void { this.buildList = [...list]; }

  /** game/player.cpp: Player::getCosts — price with CO and rule modifiers. */
  getCosts(unitID: string, _position?: unknown): number {
    const value = this.map.registry[unitID]?.getBaseCost?.(null, this.map);
    return typeof value === 'number' ? value : 0;
  }

  fundsModifier = 1;
  getFundsModifier(): number { return this.fundsModifier; }
  swapCOs(): void {}
  setColor(color: string): void { this.color = color; }
  addVisionField(): void {}
  getFieldDirectVisible(x: number, y: number): boolean { return this.getFieldVisible(x, y); }
  setFunds(amount: number): void { this.funds = amount; }
  getMovementcostModifier(): number { return 0; }
  getWeatherMovementCostModifier(): number { return 0; }
  // --- AI surface -------------------------------------------------------

  /**
   * game/player.cpp: Player::calcIncome -- what this player collects per turn.
   * Each building truncates its own income before the sum, so rounding once at
   * the end would drift by a few funds a turn.
   */
  calcIncome(modifier = 1): number {
    let income = 0;
    for (let y = 0; y < this.map.getMapHeight(); y++) {
      for (let x = 0; x < this.map.getMapWidth(); x++) {
        const building = this.map.getTerrain(x, y).getBuilding();
        if (building?.getOwner() !== this) continue;
        income += Math.trunc(building.getIncome() * modifier);
      }
    }
    return income;
  }

  /**
   * game/player.cpp: Player::isPlayerIdEnemy / isPlayerIdAlly.
   *
   * Both answer true for an out-of-range id, matching the C++, which reports the
   * error and falls through to the default rather than throwing.
   */
  isPlayerIdEnemy(playerId: number): boolean {
    const other = this.map.getPlayer(playerId);
    if (!other) return true;
    return this.checkAlliance(other) === GameEnums.Alliance_Enemy;
  }

  isPlayerIdAlly(playerId: number): boolean {
    const other = this.map.getPlayer(playerId);
    if (!other) return true;
    return this.checkAlliance(other) === GameEnums.Alliance_Friend;
  }

  /**
   * game/player.cpp: Player::getAverageCost -- mean getBaseCost over every unit
   * script, used to split "cheap" from "expensive" when valuing a silo strike.
   * Lazily cached exactly as the C++ caches m_averageCosts.
   */
  getAverageCost(): number {
    if (this.averageCosts >= 0) return this.averageCosts;
    let total = 0, count = 0;
    for (const key of Object.keys(this.map.registry)) {
      const script = this.map.registry[key];
      // The same predicate bootstrap's unitIds() uses: a unit script is the
      // thing that can price itself. UNIT is the shared base, not a unit.
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
      if (!script || typeof script !== 'object') continue;
      if (typeof script.getBaseCost !== 'function') continue;
      if (script === this.map.registry.UNIT) continue;
      const cost = this.getCosts(key);
      if (typeof cost === 'number') { total += cost; count++; }
    }
    this.averageCosts = count > 0 ? Math.trunc(total / count) : 0;
    return this.averageCosts;
  }

  /**
   * game/player.cpp: Player::getRocketTargetDamage -- value of detonating at
   * (x, y). Own units count negatively, scaled by ownUnitValue, which is what
   * stops the AI nuking its own army.
   */
  getRocketTargetDamage(
    x: number, y: number, offsets: QPoint[], damage: number,
    ownUnitValue = 1, targetType = RocketTarget_Money, ignoreStealthed = false,
  ): number {
    const averageCosts = this.getAverageCost();
    let damageDone = 0;
    for (const offset of offsets) {
      const x2 = x + offset.x, y2 = y + offset.y;
      if (!this.map.onMap(x2, y2)) continue;
      const unit = this.map.getTerrain(x2, y2).getUnit();
      if (unit === null) continue;
      if (unit.isStealthed(this) && !ignoreStealthed) continue;
      const modifier = this.isEnemyUnit(unit) ? 1 : -ownUnitValue;
      // A silo cannot take a unit below 1 hp, so overkill is not worth points.
      const damagePoints = Math.min(damage, unit.getHpRounded());
      switch (targetType) {
        case RocketTarget_Money:
          damageDone += damagePoints / MAX_UNIT_HP * modifier * unit.getCoUnitValue();
          break;
        case RocketTarget_HpHighMoney:
          damageDone += unit.getCosts() >= averageCosts / 2
            ? damagePoints * modifier * 4 : damagePoints * modifier;
          break;
        case RocketTarget_HpLowMoney:
          damageDone += unit.getCosts() <= averageCosts / 2
            ? damagePoints * modifier * 4 : damagePoints * modifier;
          break;
      }
    }
    return Math.trunc(damageDone);
  }

  /**
   * game/player.cpp: Player::getSiloRockettarget -- best detonation point and
   * what it is worth. The C++ returns the point and writes the score through an
   * out-parameter; here both come back together.
   *
   * Ties are broken by `pick` rather than the C++ randInt so a match reproduces;
   * the default takes the first, and the AI passes its own seeded chooser.
   */
  getSiloRockettarget(
    radius: number, damage: number, ownUnitValue = 1,
    targetType = RocketTarget_Money, searchArea: QPoint[] | null = null,
    pick: (count: number) => number = () => 0,
  ): { x: number; y: number; damage: number } {
    const offsets = getCircle(0, radius);
    let highestDamage = -1;
    const targets: QPoint[] = [];
    const consider = (x: number, y: number, restricted: boolean) => {
      const done = this.getRocketTargetDamage(
        x, y, offsets, damage, ownUnitValue, targetType, restricted);
      if (done > highestDamage) { highestDamage = done; targets.length = 0; targets.push({ x, y }); }
      else if (done === highestDamage && highestDamage >= 0) targets.push({ x, y });
    };
    if (searchArea === null) {
      for (let x = 0; x < this.map.getMapWidth(); x++) {
        for (let y = 0; y < this.map.getMapHeight(); y++) consider(x, y, false);
      }
    } else {
      for (const point of searchArea) consider(point.x, point.y, true);
    }
    if (targets.length === 0) return { x: -1, y: -1, damage: highestDamage };
    const chosen = targets[pick(targets.length) % targets.length];
    return { x: chosen.x, y: chosen.y, damage: highestDamage };
  }

  /**
   * game/player.cpp: Player::getMaxCoCount.
   *
   * Zero, not the C++ array size: this build has no COs, so every ported branch
   * that gates on a CO slot is inert by construction rather than by deletion.
   */
  getMaxCoCount(): number { return 0; }

}
