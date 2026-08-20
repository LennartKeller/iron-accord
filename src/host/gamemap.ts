import { GameRules } from './gamerules.ts';
import { Player } from './player.ts';
import { Terrain } from './terrain.ts';
import { Unit } from './unit.ts';
import { VisionMap } from './vision.ts';
import type { ScriptRegistry } from '../scripts/types.ts';

export interface SpriteIndex {
  has(spriteID: string): boolean;
}

export class GameMap {
  readonly rules = new GameRules();
  /** Optional resource index; terrain scripts branch on sprite existence. */
  spriteIndex: SpriteIndex | null = null;
  readonly vision: VisionMap = new VisionMap(this);
  /** Set by Game; scripts ask the map whose turn it is. */
  currentPlayerIndex = 0;
  private unitUidCounter = 0;
  currentDay = 1;

  /** Hands out stable unit identities; see Unit.uid. */
  nextUnitUid(): number { return ++this.unitUidCounter; }
  getUnitByUid(uid: number): Unit | null {
    return this.units.find(unit => unit.uid === uid) ?? null;
  }
  /** Restores a unit's previous identity when rebuilding from a snapshot. */
  assignUnitUid(unit: Unit, uid: number): void {
    unit.uid = uid;
    if (uid > this.unitUidCounter) this.unitUidCounter = uid;
  }
  readonly players: Player[] = [];
  readonly units: Unit[] = [];
  private readonly fields: Terrain[][] = [];

  readonly width: number;
  readonly height: number;
  readonly registry: ScriptRegistry;

  constructor(width: number, height: number, defaultTerrain: string, registry: ScriptRegistry) {
    this.width = width;
    this.height = height;
    this.registry = registry;
    for (let y = 0; y < height; y++) {
      const row: Terrain[] = [];
      for (let x = 0; x < width; x++) row.push(new Terrain(this, x, y, defaultTerrain));
      this.fields.push(row);
    }
  }

  getMapWidth(): number { return this.width; }
  getMapHeight(): number { return this.height; }
  getImageSize(): number { return 24; }
  getGameRules(): GameRules { return this.rules; }
  getTerrain(x: number, y: number): Terrain { return this.fields[y][x]; }
  setTerrainID(x: number, y: number, id: string): void { this.fields[y][x].terrainID = id; }
  setTerrain(x: number, y: number, terrain: Terrain): void { this.fields[y][x] = terrain; }
  onMap(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  getPlayerCount(): number { return this.players.length; }
  getPlayer(index: number): Player | undefined { return this.players[index]; }
  addPlayer(army: string): Player {
    const player = new Player(this, army, this.players.length);
    this.players.push(player);
    return player;
  }

  /** game/terrain.cpp: Terrain::existsResAnim, routed through the index. */
  spriteExists(spriteID: string): boolean {
    return this.spriteIndex ? this.spriteIndex.has(spriteID) : false;
  }

  getCurrentPlayer(): Player | undefined { return this.players[this.currentPlayerIndex]; }
  getCurrentDay(): number { return this.currentDay; }
  setCurrentDay(day: number): void { this.currentDay = day; }

  /** Every unit id the script registry knows about. */
  getAllUnitIDs(): string[] {
    return Object.keys(this.registry).filter(key =>
      /^[A-Z][A-Z0-9_]*$/.test(key)
      && this.registry[key]
      && typeof this.registry[key] === 'object'
      && typeof this.registry[key].getBaseCost === 'function'
      && this.registry[key] !== this.registry.UNIT);
  }

  /**
   * game/gamemap.cpp: GameMap::replaceTerrainOnly — swaps a tile's terrain in
   * place. Walls, meteors and destroyed pipes all rely on it; without it the
   * obstacle dies but the tile never changes.
   */
  replaceTerrainOnly(
    terrainID: string, x: number, y: number,
    useTerrainAsBaseTerrain = false, removeUnit = false, palette = '',
  ): void {
    if (!this.onMap(x, y)) return;
    const previous = this.fields[y][x];
    const terrain = new Terrain(this, x, y, terrainID);
    terrain.palette = palette || previous.getPalette();
    if (useTerrainAsBaseTerrain) terrain.baseTerrain = previous;
    else terrain.baseTerrain = previous.baseTerrain;
    terrain.building = previous.building;
    if (terrain.building) terrain.building.setTerrain(terrain);
    this.fields[y][x] = terrain;
    try { this.registry[terrainID]?.init?.(terrain, this); } catch { /* optional */ }
    if (removeUnit) {
      const unit = this.getUnitAt(x, y);
      if (unit) this.removeUnit(unit);
    }
  }

  nextTurn(): void {}
  /** Without a separate spectator, the viewing player is the active one. */
  getCurrentViewPlayer(): Player | undefined { return this.getCurrentPlayer(); }
  /**
   * The game recorder is pure bookkeeping for replays and statistics, and the
   * scripts call a wide scatter of methods on it. A permissive no-op proxy is
   * safer than enumerating them: a missing name would otherwise throw mid-action
   * and abandon the action half-applied.
   */
  private readonly recorder = new Proxy({}, { get: () => () => undefined });
  getGameRecorder(): Record<string, (...args: unknown[]) => void> {
    return this.recorder as Record<string, (...args: unknown[]) => void>;
  }

  getUnitAt(x: number, y: number): Unit | null {
    return this.units.find(u => u.x === x && u.y === y) ?? null;
  }

  /**
   * Our own spawn helper. Deliberately NOT called spawnUnit: the scripts call
   * `map.spawnUnit(x, y, unitID, owner)` with the coordinates first, and having
   * two same-named methods whose first two arguments differ in meaning is a
   * mistake waiting to happen.
   */
  addUnit(unitID: string, owner: Player, x: number, y: number): Unit {
    const unit = new Unit(this, unitID, owner, x, y);
    this.units.push(unit);
    owner.units.push(unit);
    return unit;
  }

  /** game/gamemap.cpp: GameMap::spawnUnit — the signature scripts expect. */
  spawnUnit(x: number, y: number, unitID: string, owner: Player, _range = 0): Unit {
    return this.addUnit(unitID, owner, x, y);
  }

  /** Returns a previously carried unit to the board, keeping its identity. */
  reAddUnit(unit: Unit): void {
    if (!this.units.includes(unit)) this.units.push(unit);
    const owner = unit.getOwner();
    if (!owner.units.includes(unit)) owner.units.push(unit);
  }

  removeUnit(unit: Unit): void {
    const mapIdx = this.units.indexOf(unit);
    if (mapIdx >= 0) this.units.splice(mapIdx, 1);
    const ownerIdx = unit.getOwner().units.indexOf(unit);
    if (ownerIdx >= 0) unit.getOwner().units.splice(ownerIdx, 1);
  }
}
