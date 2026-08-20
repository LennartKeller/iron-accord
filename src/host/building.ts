import type { GameMap } from './gamemap.ts';
import type { Player } from './player.ts';
import type { Terrain, SpriteRequest } from './terrain.ts';
import { ScriptVariables } from './variables.ts';

/** Host-side Building, mirroring the script-facing part of game/building.h. */
export class BuildingHost {
  readonly map: GameMap;
  readonly buildingID: string;
  private owner: Player | null;
  terrain: Terrain | null = null;
  hp = -1;
  fireCount = 0;
  readonly sprites: SpriteRequest[] = [];
  alwaysVisible = false;
  visionHigh = 0;
  readonly variables = new ScriptVariables();

  constructor(map: GameMap, buildingID: string, owner: Player | null) {
    this.map = map;
    this.buildingID = buildingID;
    this.owner = owner;
  }

  getBuildingID(): string { return this.buildingID; }
  getID(): string { return this.buildingID; }
  getOwner(): Player | null { return this.owner; }
  setOwner(player: Player | null): void { this.owner = player; }
  getTerrain(): Terrain | null { return this.terrain; }
  setTerrain(terrain: Terrain): void { this.terrain = terrain; }
  getX(): number { return this.terrain?.x ?? -1; }
  getY(): number { return this.terrain?.y ?? -1; }
  getMap(): GameMap { return this.map; }

  getHp(): number { return this.hp; }
  setHp(value: number): void { this.hp = value; }

  /**
   * Firing cooldown for silos, cannons, lasers and death rays. ACTION_CANNON_FIRE
   * gates on this and decrements it *after* dealing damage, so a missing
   * implementation lets those buildings fire every single turn.
   */
  getFireCount(): number { return this.fireCount; }
  setFireCount(value: number): void { this.fireCount = value; }

  setAlwaysVisble(value: boolean): void { this.alwaysVisible = value; }
  getAlwaysVisble(): boolean { return this.alwaysVisible; }
  setVisionHigh(value: number): void { this.visionHigh = value; }
  getVisionHigh(): number { return this.visionHigh; }
  getVariables() { return this.variables; }
  unloadSprites(): void { this.sprites.length = 0; }
  getImageSize(): number { return this.map.getImageSize(); }
  getIsAttackable(): boolean { return this.hp > 0; }
  getBaseTerrain(): string[] {
    const list = this.map.registry[this.buildingID]?.getBaseTerrain?.(this, this.map);
    return Array.isArray(list) ? [...list] : [];
  }
  getVision(): number {
    const value = this.map.registry[this.buildingID]?.getVision?.(this, this.map);
    return typeof value === 'number' ? value : this.map.getGameRules().getBuildingVision();
  }
  loadWeatherOverlaySpriteV2(spriteID: string): void {
    this.sprites.push({ id: spriteID, kind: 'overlay', palette: '' });
  }

  /**
   * game/building.cpp: Building::init — where a script sets its starting HP,
   * visibility and firing cooldown. Never calling it left 55 building scripts
   * uninitialised.
   */
  init(): void {
    try { this.map.registry[this.buildingID]?.init?.(this, this.map); } catch { /* optional */ }
  }

  getBuildingWidth(): number { return 1; }
  getBuildingHeigth(): number { return 1; }
  getDefensiveBonus(): number {
    const value = this.map.registry[this.buildingID]?.getDefensiveBonus?.(this, this.map);
    return typeof value === 'number' ? value : 0;
  }

  getOffensiveFieldBonus(
    action: unknown, attacker: unknown, atkPosition: { x: number; y: number },
    defender: unknown, defPosition: { x: number; y: number }, isDefender: boolean, luckMode: number,
  ): number {
    const value = this.map.registry[this.buildingID]?.getOffensiveFieldBonus?.(
      this, attacker, atkPosition.x, atkPosition.y,
      defender, defPosition.x, defPosition.y, isDefender, action, luckMode, this.map);
    return typeof value === 'number' ? value : 0;
  }

  getDeffensiveFieldBonus(
    action: unknown, attacker: unknown, atkPosition: { x: number; y: number },
    defender: unknown, defPosition: { x: number; y: number }, isAttacker: boolean, luckMode: number,
  ): number {
    const value = this.map.registry[this.buildingID]?.getDeffensiveFieldBonus?.(
      this, attacker, atkPosition.x, atkPosition.y,
      defender, defPosition.x, defPosition.y, isAttacker, action, luckMode, this.map);
    return typeof value === 'number' ? value : 0;
  }

  loadSprite(spriteID: string): void {
    this.sprites.push({ id: spriteID, kind: 'base', palette: '' });
  }
  /** loadSpriteV2(id, recoloring, frameTime, offset, palette, neutral) */
  loadSpriteV2(spriteID: string, _recoloring = 0, _frameTime = 0, _offset?: unknown, palette = ''): void {
    this.sprites.push({ id: spriteID, kind: 'base', palette });
  }
  getOwnerID(): number { return this.owner ? this.owner.getPlayerID() : -1; }
  loadOverlaySprite(spriteID: string): void {
    this.sprites.push({ id: spriteID, kind: 'overlay', palette: '' });
  }
  setBuildingName(_value: string): void {}

  getPosition(): { x: number; y: number } {
    return { x: this.getX(), y: this.getY() };
  }

  /**
   * The actions this building offers (BUILDING.getActions). This — not the
   * construction list — is what decides whether a building can produce units:
   * factory, airport and harbour declare ACTION_BUILD_UNITS, while town and HQ
   * do not, even though TOWN.constructionList is a full unit roster. That list
   * is dead data, in the same way WEAPON_TANKHUNTER_GUN.damageTable is.
   */
  getActions(): string[] {
    const script = this.map.registry[this.buildingID];
    const list = script?.getActions?.(this, this.map) ?? script?.actionList;
    return Array.isArray(list) ? [...list] : [];
  }

  canBuildUnits(): boolean {
    return this.getActions().includes('ACTION_BUILD_UNITS');
  }

  /** What this building can produce, from its script. */
  getConstructionList(): string[] {
    const list = this.map.registry[this.buildingID]?.getConstructionList?.(this, this.map)
      ?? this.map.registry[this.buildingID]?.constructionList;
    if (!Array.isArray(list)) return [];
    // game/building.cpp filters the script's list by what the owner is allowed
    // to build; an empty player list means no restriction.
    const allowed = this.owner?.getBuildList() ?? [];
    return allowed.length > 0 ? list.filter((id: string) => allowed.includes(id)) : [...list];
  }

  /** ACTION_CAPTURE hands ownership over by naming the capturing unit. */
  setUnitOwner(unit: { getOwner(): Player }): void {
    this.owner = unit.getOwner();
  }

  /**
   * game/building.cpp: Building::startOfTurn — the script hook that repairs and
   * resupplies a unit standing on this building.
   */
  startOfTurn(): void {
    try { this.map.registry[this.buildingID]?.startOfTurn?.(this, this.map); } catch { /* optional */ }
  }

  endOfTurn(): void {
    try { this.map.registry[this.buildingID]?.endOfTurn?.(this, this.map); }
    catch (error) { console.warn(`${this.buildingID}.endOfTurn failed`, error); }
  }

  onDestroyed(): void {
    try { this.map.registry[this.buildingID]?.onDestroyed?.(this, this.map); }
    catch { /* optional */ }
  }

  /** BUILDING.canRepair, asked of the script. */
  canRepair(unit: unknown, always = false): boolean {
    const result = this.map.registry[this.buildingID]?.canRepair?.(this, unit, this.map, always);
    return result === true;
  }

  getRepairTypes(): number[] {
    const list = this.map.registry[this.buildingID]?.getRepairTypes?.(this, this.map);
    return Array.isArray(list) ? [...list] : [];
  }

  getBaseIncome(): number {
    const value = this.map.registry[this.buildingID]?.getBaseIncome?.(this, this.map);
    return typeof value === 'number' ? value : 0;
  }
}
