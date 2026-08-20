import { QmlVector } from './qmlvector.ts';
import { GameEnums } from './enums.ts';
import type { Unit } from './unit.ts';
import type { GameMap } from './gamemap.ts';

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
  getUnitCount(): number { return this.units.length; }

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
