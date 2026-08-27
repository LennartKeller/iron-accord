import { GameRules } from './gamerules.ts';
import { Player } from './player.ts';
import { Terrain } from './terrain.ts';
import { Unit } from './unit.ts';
import { VisionMap } from './vision.ts';
import type { ScriptRegistry } from '../scripts/types.ts';

export interface SpriteIndex {
  has(spriteID: string): boolean;
}

/**
 * Per-movement-type cost cache, one entry per movement table.
 *
 * The movement tables declare through getSupportsFastPfs() whether their cost
 * for a tile is a pure function of the tile — the desktop engine keys its own
 * fast pathfinding on the same promise. Only tables that make it are cached;
 * MOVE_HOVERCRAFT answers false (its cost depends on the tile being left) and
 * always goes to the script. See Unit.getBaseMovementCosts for the tiles that
 * are excluded even on fast tables.
 */
interface MoveCostEntry {
  /** The movement table script object, e.g. registry.MOVE_FEET. */
  table: any;
  /** True when the table's costs may be cached per tile. */
  fast: boolean;
  /** Rule value baked into the cached costs; a change discards the entry. */
  shipBridges: boolean;
  /** Cost per tile index; NaN = not yet computed, Infinity = never cache. */
  costs: Float64Array;
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

  /**
   * The uid counter, so `explore()` can rewind it with everything else.
   *
   * Simulating production inside the search hands out uids, and restoring the
   * units afterwards puts their identities back but left the counter advanced.
   * The next unit the game really built then got a uid inflated by however many
   * the search had imagined — invisible during play, and fatal afterwards: the
   * recorded actions referenced uids a replay never assigns, so planner games
   * could not be reproduced from their own replays at all.
   */
  getUnitUidCounter(): number { return this.unitUidCounter; }
  setUnitUidCounter(value: number): void { this.unitUidCounter = value; }
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

  // --- derived-state caches ----------------------------------------------
  // Everything below is a pure accelerator: discarding it at any moment must
  // never change behaviour, only speed. Correctness rests on invalidation:
  //
  //  * boardVersion is bumped by the Terrain setters (terrainID, building,
  //    baseTerrain) and by setTerrain below, so ANY change to what a tile is —
  //    including a snapshot restore rebuilding a tile, and including tiles
  //    constructed for this map anywhere — discards the movement-cost cache.
  //  * The unit index is a dirty flag plus a length check: every host-side
  //    board mutation (addUnit/removeUnit/reAddUnit and the Unit.x/y setters)
  //    marks it dirty, and snapshot restore's direct `units.length = 0`
  //    truncation is caught by comparing units.length against the length the
  //    index was built from — the follow-up addUnit calls mark dirty anyway.

  /** Bumped whenever a tile's identity changes; see the note above. */
  boardVersion = 0;
  private moveCostVersion = -1;
  private readonly moveCostEntries = new Map<string, MoveCostEntry>();
  /** Movement type per unit id; every unit script answers with a constant. */
  private readonly movementTypes = new Map<string, string>();
  private unitIndexDirty = true;
  private unitIndexLength = -1;
  private readonly unitIndex = new Map<number, Unit>();

  /** Invalidates the per-tile unit index; cheap, rebuilt lazily on read. */
  markUnitsDirty(): void { this.unitIndexDirty = true; }

  /**
   * The (possibly cached) movement-cost entry for a movement type. Discards
   * all entries when the board changed, and this one when the ship-bridges
   * rule it was built under changed.
   */
  moveCostEntry(movementType: string): MoveCostEntry {
    if (this.moveCostVersion !== this.boardVersion) {
      this.moveCostEntries.clear();
      this.lastMoveCostEntry = null;
      this.moveCostVersion = this.boardVersion;
    }
    const shipBridges = this.rules.getShipBridges();
    // Consecutive lookups come in runs of one movement type (a pathfinding
    // expansion asks for one unit); a one-slot memo skips the Map on those.
    const last = this.lastMoveCostEntry;
    if (last && this.lastMoveCostType === movementType && last.shipBridges === shipBridges) {
      return last;
    }
    let entry = this.moveCostEntries.get(movementType);
    if (!entry || entry.shipBridges !== shipBridges) {
      const table = this.registry[movementType];
      entry = {
        table,
        fast: typeof table?.getMovementpoints === 'function'
          && typeof table?.getSupportsFastPfs === 'function'
          && table.getSupportsFastPfs() === true,
        shipBridges,
        costs: new Float64Array(this.width * this.height).fill(NaN),
      };
      this.moveCostEntries.set(movementType, entry);
    }
    this.lastMoveCostType = movementType;
    this.lastMoveCostEntry = entry;
    return entry;
  }

  private lastMoveCostType = '';
  private lastMoveCostEntry: MoveCostEntry | null = null;

  /**
   * A unit type's action list, memoised: the scripts declare it as a literal
   * on the constructor and never touch it again, so one registry crossing per
   * unit id serves the whole map. Callers get a fresh copy, as before.
   */
  private readonly actionLists = new Map<string, readonly string[]>();
  actionListOf(unitID: string): readonly string[] {
    let list = this.actionLists.get(unitID);
    if (list === undefined) {
      const raw = this.registry[unitID]?.actionList;
      list = Array.isArray(raw) ? [...raw] : [];
      this.actionLists.set(unitID, list);
    }
    return list;
  }

  /**
   * Movement type of a unit, memoised per unit id: every unit script's
   * getMovementType returns a string literal (verified across units/*.js), so
   * one script call per id is enough for the lifetime of the map.
   */
  movementTypeOf(unit: Unit): string {
    let type = this.movementTypes.get(unit.unitID);
    if (type === undefined) {
      type = unit.getMovementType();
      this.movementTypes.set(unit.unitID, type);
    }
    return type;
  }

  /**
   * resource_management/unitspritemanager.h: getMovementType(unitId).
   *
   * The same answer without needing an instance, which is what the AI wants
   * when it is reasoning about a unit it has not built yet. Asks the unit
   * script directly rather than spawning a probe, so it issues no uid.
   */
  movementTypeOfId(unitID: string): string {
    let type = this.movementTypes.get(unitID);
    if (type === undefined) {
      const result = this.registry[unitID]?.getMovementType?.();
      type = typeof result === 'string' ? result : '';
      this.movementTypes.set(unitID, type);
    }
    return type;
  }

  /**
   * Rebuilds the tile→unit index in units-array order, first unit winning a
   * contested tile — exactly what the linear `find` this replaces returned.
   * Keyed x-major so off-map coordinates stay distinct instead of aliasing a
   * real tile.
   */
  private rebuildUnitIndex(): void {
    this.unitIndex.clear();
    for (const unit of this.units) {
      const key = unit.x * 65536 + unit.y;
      if (!this.unitIndex.has(key)) this.unitIndex.set(key, unit);
    }
    this.unitIndexDirty = false;
    this.unitIndexLength = this.units.length;
  }

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
  setTerrain(x: number, y: number, terrain: Terrain): void {
    this.fields[y][x] = terrain;
    // The object being placed may have been built (and bumped the version)
    // long before it lands on the board; bump again so caches built in between
    // cannot survive the swap.
    this.boardVersion++;
  }
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
    // Length check catches snapshot restore's direct `units.length = 0`
    // truncation, which no dirty mark can see.
    if (this.unitIndexDirty || this.unitIndexLength !== this.units.length) {
      this.rebuildUnitIndex();
    }
    return this.unitIndex.get(x * 65536 + y) ?? null;
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
    this.unitIndexDirty = true;
    return unit;
  }

  /** game/gamemap.cpp: GameMap::spawnUnit — the signature scripts expect. */
  spawnUnit(x: number, y: number, unitID: string, owner: Player, _range = 0): Unit {
    return this.addUnit(unitID, owner, x, y);
  }

  /** Returns a previously carried unit to the board, keeping its identity. */
  reAddUnit(unit: Unit): void {
    this.unitIndexDirty = true;
    if (!this.units.includes(unit)) this.units.push(unit);
    const owner = unit.getOwner();
    if (!owner.units.includes(unit)) owner.units.push(unit);
  }

  removeUnit(unit: Unit): void {
    this.unitIndexDirty = true;
    const mapIdx = this.units.indexOf(unit);
    if (mapIdx >= 0) this.units.splice(mapIdx, 1);
    const ownerIdx = unit.getOwner().units.indexOf(unit);
    if (ownerIdx >= 0) unit.getOwner().units.splice(ownerIdx, 1);
  }
}
