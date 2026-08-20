import type { GameMap } from './gamemap.ts';
import type { Unit } from './unit.ts';
import { Qt, type QPoint } from './globals.ts';
import { GameEnums } from './enums.ts';
import { ScriptVariables } from './variables.ts';

/** game/gamemap.cpp: GameMap::getField — direction ordinal to a tile delta. */
const DIRECTION_DELTA: ReadonlyArray<readonly [number, number]> = [
  [0, -1],  // North
  [1, -1],  // NorthEast
  [1, 0],   // East
  [1, 1],   // SouthEast
  [0, 1],   // South
  [-1, 1],  // SouthWest
  [-1, 0],  // West
  [-1, -1], // NorthWest
];

/** Direction suffix the sprite ids use, and its mirror for flow-inverted lookups. */
const DIRECTION_SUFFIX: ReadonlyArray<readonly [string, string]> = [
  ['+N', '+S'],
  ['+NE', '+SW'],
  ['+E', '+W'],
  ['+SE', '+NW'],
  ['+S', '+N'],
  ['+SW', '+NE'],
  ['+W', '+E'],
  ['+NW', '+SE'],
];

const DIRECT = new Set([0, 2, 4, 6]);
const DIAGONAL = new Set([1, 3, 5, 7]);

/** A sprite the terrain scripts asked us to draw, in draw order. */
export interface SpriteRequest {
  id: string;
  kind: 'base' | 'overlay';
  palette: string;
}

// building.ts imports Terrain type-only, so this value import is not a runtime cycle.
import { BuildingHost } from './building.ts';

export type Building = BuildingHost;

export class Terrain {
  building: Building | null = null;
  hp = -1;
  /** Nested terrain (e.g. a FOREST drawn on top of a PLAINS base). */
  baseTerrain: Terrain | null = null;
  palette = '';
  visionHigh = 0;
  readonly variables = new ScriptVariables();
  readonly animationVariables = new ScriptVariables();
  /** Populated by the terrain scripts through loadBaseSprite/loadOverlaySprite. */
  readonly sprites: SpriteRequest[] = [];

  readonly map: GameMap;
  readonly x: number;
  readonly y: number;
  terrainID: string;

  constructor(map: GameMap, x: number, y: number, terrainID: string) {
    this.map = map;
    this.x = x;
    this.y = y;
    this.terrainID = terrainID;
  }

  getTerrainID(): string { return this.terrainID; }

  /**
   * game/terrain.cpp: Terrain::getID returns the BUILDING's id when the tile has
   * one. Movement tables and defence both key on it, so returning the raw
   * terrain id makes harbours impassable to ships and gives cities the defence
   * of the plains underneath them.
   */
  getID(): string {
    return this.building ? this.building.getBuildingID() : this.terrainID;
  }
  getX(): number { return this.x; }
  getY(): number { return this.y; }
  getMap(): GameMap { return this.map; }
  getBuilding(): Building | null { return this.building; }
  getUnit(): Unit | null { return this.map.getUnitAt(this.x, this.y); }
  getPalette(): string { return this.palette; }
  setPalette(value: string): void { this.palette = value; }
  setTerrainName(_value: string): void {}
  getTerrainName(): string { return this.terrainID; }

  // --- sprite recording -------------------------------------------------
  // The scripts "load" sprites; we just record what they asked for so the
  // renderer can draw the same thing the desktop client would.

  loadBaseSprite(spriteID: string): void {
    this.sprites.push({ id: spriteID, kind: 'base', palette: this.palette });
  }

  loadOverlaySprite(spriteID: string, _startFrame?: number, _endFrame?: number, palette = ''): void {
    this.sprites.push({ id: spriteID, kind: 'overlay', palette: palette || this.palette });
  }

  addTerrainOverlay(id: string): void {
    this.sprites.push({ id, kind: 'overlay', palette: this.palette });
  }

  /** Does this sprite exist in the resource index? Scripts branch on it. */
  existsResAnim(spriteID: string): boolean {
    return this.map.spriteExists(spriteID);
  }

  /** game/terrain.cpp: Terrain::getFittingResAnim */
  getFittingResAnim(start: string, end: string): string {
    for (let i = 0; i < 100; i++) {
      const candidate = `${start}${i}${end}`;
      if (this.map.spriteExists(candidate)) return candidate;
    }
    return '';
  }

  // --- base terrain chain -----------------------------------------------

  getBaseTerrain(terrainId = '', returnNullIfNotFound = false): Terrain | null {
    if (this.baseTerrain) {
      if (this.baseTerrain.terrainID === terrainId || terrainId === '') return this.baseTerrain;
      return this.baseTerrain.getBaseTerrain(terrainId, returnNullIfNotFound);
    }
    return returnNullIfNotFound ? null : this;
  }

  getBaseTerrainID(): string {
    return this.baseTerrain ? this.baseTerrain.getBaseTerrainID() : this.terrainID;
  }

  getBaseTerrainIDOfLevel(count: number): string {
    if (this.baseTerrain && count !== 0) return this.baseTerrain.getBaseTerrainIDOfLevel(count - 1);
    return this.terrainID;
  }

  /**
   * game/terrain.cpp: Terrain::getSurroundings — builds the direction suffix
   * that drives autotiling, e.g. "+N+E" for a road joining north and east.
   */
  /** Terrain group from the script; movement tables branch on it. */
  getTerrainGroup(): number {
    const result = this.map.registry[this.terrainID]?.getTerrainGroup?.();
    return typeof result === 'number' ? result : 0;
  }

  getSurroundings(
    list: string,
    useBaseTerrainID: boolean,
    blacklist: boolean,
    searchType: number,
    useMapBorder = true,
    useBuildingID = false,
    recursionCount = -1,
    inverted = false,
  ): string {
    const searchList = list.split(',');
    let result = '';

    for (let direction = 0; direction < 8; direction++) {
      let compare = GameEnums.Directions_None;
      if (searchType === GameEnums.Directions_All) compare = direction;
      else if (searchType === GameEnums.Directions_Direct) compare = DIRECT.has(direction) ? direction : GameEnums.Directions_None;
      else if (searchType === GameEnums.Directions_Diagnonal) compare = DIAGONAL.has(direction) ? direction : GameEnums.Directions_None;
      else if (searchType === direction) compare = direction;

      if (compare === GameEnums.Directions_None) continue;
      const suffix = DIRECTION_SUFFIX[compare][inverted ? 1 : 0];

      const [dx, dy] = DIRECTION_DELTA[direction];
      const x = this.x + dx;
      const y = this.y + dy;

      let found: boolean;
      if (this.map.onMap(x, y)) {
        const neighbour = this.map.getTerrain(x, y);
        let terrainID = neighbour.getTerrainID();
        if (useBuildingID && neighbour.getBuilding()) terrainID = neighbour.getID();

        let baseID = '';
        if (useBaseTerrainID) {
          baseID = recursionCount > 0
            ? neighbour.getBaseTerrainIDOfLevel(recursionCount)
            : neighbour.getBaseTerrainID();
        }

        found = blacklist
          ? !searchList.includes(terrainID) && !searchList.includes(baseID)
          : searchList.includes(terrainID) || searchList.includes(baseID);
      } else {
        found = useMapBorder;
      }

      if (found) result += suffix;
    }
    return result;
  }

  /**
   * game/terrain.cpp: Terrain::getBaseDefense() — dispatched on getID(), so a
   * building's own defence (3 for most, 4 for an HQ) applies rather than the
   * terrain beneath it.
   */
  getBaseDefense(): number {
    const script = this.map.registry[this.getID()];
    const value = script?.getDefense?.(this, this.map);
    return typeof value === 'number' ? value : 0;
  }

  /** game/terrain.cpp: Terrain::getDefense(Unit*) */
  getDefense(unit: Unit | null): number {
    let defense = this.getBaseDefense();
    if (unit) {
      if (!unit.useTerrainDefense()) return 0;
      defense += unit.getTerrainDefenseModifier(Qt.point(this.x, this.y));
      // CO enemy-terrain modifiers are applied here in C++; no COs yet.
    }
    return defense < 0 ? 0 : defense;
  }

  /**
   * Places a building on this tile — used by the temporary airport/harbour
   * actions. Ownership follows whoever built it, set by the caller.
   */
  loadBuilding(buildingID: string): void {
    const building = new BuildingHost(this.map, buildingID, null);
    building.setTerrain(this);
    this.building = building;
    building.init();
  }

  getHp(): number { return this.hp; }
  setHp(value: number): void { this.hp = value; }
  setVisionHigh(value: number): void { this.visionHigh = value; }
  getVisionHigh(): number { return this.visionHigh; }
  getVariables() { return this.variables; }
  getAnimationVariables() { return this.animationVariables; }
  getTerrainSpriteName(): string { return this.sprites.at(-1)?.id ?? ''; }
  getFixedSprite(): boolean { return false; }
  setHasFlowDirection(_value: boolean): void {}
  setHasStartOfTurn(_value: boolean): void {}
  setTerrainPalette(palette: string): void { this.palette = palette; }
  unloadSprites(): void { this.sprites.length = 0; }
  loadBaseTerrainSprites(): void {}
  loadBaseTerrain(terrainID: string): void {
    const base = new Terrain(this.map, this.x, this.y, terrainID);
    base.palette = this.palette;
    this.baseTerrain = base;
  }

  /** Neighbour's palette, falling back to this terrain's default off-map. */
  getNeighbourPalette(direction: number, _baseTerrainId = ''): string {
    const deltas: Record<number, [number, number]> = {
      0: [0, -1], 2: [1, 0], 4: [0, 1], 6: [-1, 0],
    };
    const delta = deltas[direction];
    if (delta && this.map.onMap(this.x + delta[0], this.y + delta[1])) {
      return this.map.getTerrain(this.x + delta[0], this.y + delta[1]).getPalette();
    }
    return this.getPalette();
  }
  getNeighbourDirectionsPalette(): string { return this.getPalette(); }

  /**
   * game/terrain.cpp: Terrain::getVisionHide — forests, reefs, ruins and fog
   * conceal whatever stands on them. A concealed tile is only revealed to a
   * viewer standing next to it.
   */
  /** game/terrain.cpp: Terrain::startOfTurn — fires spread, volcanoes erupt. */
  startOfTurn(): void {
    try { this.map.registry[this.terrainID]?.startOfTurn?.(this, this.map); }
    catch (error) { console.warn(`${this.terrainID}.startOfTurn failed`, error); }
  }

  onDestroyed(): void {
    try { this.map.registry[this.terrainID]?.onDestroyed?.(this, this.map); }
    catch { /* optional */ }
  }

  getVisionHide(player?: unknown): boolean {
    const result = this.map.registry[this.terrainID]?.getVisionHide?.(this, player, this.map);
    return result === true;
  }

  /**
   * game/terrain.cpp: a tile can add a flat offence/defence modifier separate
   * from its defence stars — desert gives attackers -20. Dispatched on the
   * TERRAIN id, not getID(): buildings carry their own pair of these.
   */
  getOffensiveFieldBonus(
    action: unknown, attacker: Unit | null, atkPosition: QPoint,
    defender: Unit | null, defPosition: QPoint, isDefender: boolean, luckMode: number,
  ): number {
    const value = this.map.registry[this.terrainID]?.getOffensiveFieldBonus?.(
      this, attacker, atkPosition.x, atkPosition.y,
      defender, defPosition.x, defPosition.y, isDefender, action, luckMode, this.map);
    return typeof value === 'number' ? value : 0;
  }

  getDeffensiveFieldBonus(
    action: unknown, attacker: Unit | null, atkPosition: QPoint,
    defender: Unit | null, defPosition: QPoint, isAttacker: boolean, luckMode: number,
  ): number {
    const value = this.map.registry[this.terrainID]?.getDeffensiveFieldBonus?.(
      this, attacker, atkPosition.x, atkPosition.y,
      defender, defPosition.x, defPosition.y, isAttacker, action, luckMode, this.map);
    return typeof value === 'number' ? value : 0;
  }
}
