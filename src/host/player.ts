import { QmlVector } from './qmlvector.ts';
import { GameEnums } from './enums.ts';
import type { Unit } from './unit.ts';
import type { GameMap } from './gamemap.ts';
import type { BuildingHost } from './building.ts';

export class Player {
  readonly units: Unit[] = [];
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
}
