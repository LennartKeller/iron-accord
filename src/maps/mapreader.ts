import zlib from 'node:zlib';
import { QDataStreamReader } from './qdatastream.ts';

/**
 * Reads Commander Wars `.map` files.
 *
 * Ported field-for-field from the C++ `deserializer` methods; every `version >`
 * gate below mirrors one in the original, because the stream has no field tags
 * — miss one and everything after it desyncs.
 *
 *   game/gamemap.cpp    GameMap::readMapHeader / GameMap::deserializer
 *   game/terrain.cpp    Terrain::deserializer
 *   game/building.cpp   Building::deserializer
 *   game/unit.cpp       Unit::deserializer
 *   game/player.cpp     Player::deserializer
 *   game/co.cpp         CO::deserializer
 */

export interface MapHeader {
  version: number;
  mapName: string;
  mapAuthor: string;
  mapDescription: string;
  width: number;
  height: number;
  uniqueIdCounter: number;
  playerCount: number;
  mapFlags: bigint;
}

export interface MapUnit {
  unitID: string;
  hp: number;
  ammo1: number;
  ammo2: number;
  fuel: number;
  rank: number;
  playerID: number;
  hasMoved: boolean;
  capturePoints: number;
  hidden: boolean;
  transported: MapUnit[];
}

export interface MapBuilding {
  buildingID: string;
  playerID: number;
  hp: number;
  fireCount: number;
  buildingName: string;
}

export interface MapTile {
  x: number;
  y: number;
  terrainID: string;
  spriteName: string;
  fixedSprite: boolean;
  hp: number;
  palette: string;
  building: MapBuilding | null;
  unit: MapUnit | null;
  baseTerrain: MapTile | null;
}

export interface MapCO {
  coID: string;
  powerStars: number;
  superpowerStars: number;
  powerFilled: number;
  powerMode: number;
  perks: string[];
}

export interface MapPlayer {
  color: number;
  funds: number;
  fundsModifier: number;
  army: string;
  team: number;
  isDefeated: boolean;
  cos: Array<MapCO | null>;
  buildList: string[];
  controlType: number;
  playerNameId: string;
}

export interface CommanderWarsMap {
  header: MapHeader;
  players: MapPlayer[];
  currentPlayer: number;
  currentDay: number;
  tiles: MapTile[][];
  /**
   * Bytes after the tile grid that this reader deliberately does not parse:
   * game rules, the action recorder, map scripts, campaign data and script
   * variables. Non-zero is expected; it is NOT an error signal.
   */
  unparsedTailBytes: number;
}

/** coreengine/scriptvariables.cpp: ScriptVariables::deserializeObject */
function readScriptVariables(s: QDataStreamReader): void {
  s.int32();                      // version
  const size = s.int32();
  for (let i = 0; i < size; i++) {
    const varVersion = s.int32();
    s.string();                   // id
    s.filesupportByteArray();     // buffer
    if (varVersion > 1) s.bool(); // modified
  }
}

/** game/gamemap.cpp: GameMap::readMapHeader */
function readHeader(s: QDataStreamReader): MapHeader {
  const version = s.int32();
  if (version > 15) s.byteArray();  // MAP_MAGIC

  const mapName = version > 1 ? s.string() : '';
  let mapAuthor = '';
  let mapDescription = '';
  if (version > 4) {
    mapAuthor = s.string();
    mapDescription = s.string();
  }
  const width = s.int32();
  const height = s.int32();
  const uniqueIdCounter = version > 6 ? s.int32() : 0;
  const playerCount = s.int32();
  const mapFlags = version > 11 ? s.uint64() : 0n;

  return { version, mapName, mapAuthor, mapDescription, width, height, uniqueIdCounter, playerCount, mapFlags };
}

/** game/co.cpp: CO::deserializer */
function readCO(s: QDataStreamReader): MapCO {
  const version = s.int32();
  const coID = s.string();
  const powerStars = s.int32();
  const superpowerStars = s.int32();
  const powerFilled = version > 2 ? s.double() : s.float();
  const powerMode = s.int32();
  if (version > 1) readScriptVariables(s);
  if (version > 2) s.int32();                  // m_powerUsed (qint32, not a qreal)

  const perks: string[] = [];
  if (version > 3) {
    const size = s.int32();
    for (let i = 0; i < size; i++) perks.push(s.string());
  }
  if (version > 4) {
    // game/co.cpp: CO::readCoStyleFromStream — per entry a co id, a file, then a
    // colour table of `width` (colour, mask) QRgb pairs, then a flag.
    const styles = s.int32();
    for (let i = 0; i < styles; i++) {
      s.string();                              // co id
      s.string();                              // sprite file
      const width = s.int32();
      for (let x = 0; x < width; x++) { s.uint32(); s.uint32(); }
      s.bool();                                // useColorBox
    }
  }
  if (version > 5) s.bool();                   // coRangeEnabled
  if (version > 6) s.bool();                   // globalCoZone
  if (version > 7) s.bool();                   // alwaysShowCoRange

  return { coID, powerStars, superpowerStars, powerFilled, powerMode, perks };
}

/**
 * gameinput/basegameinputif.cpp: BaseGameInputIF::deserializeInterface
 *
 * The AI type decides whether a payload follows: createAi() returns nullptr for
 * Open/Closed slots, and deserializeObject is only called on a non-null input.
 */
const AI_HUMAN = 0;
const AI_PROXY = -1;
const AI_MOVE_PLANNER = -2;
const AI_DUMMY = -3;
const AI_CLOSED = 199;
const AI_OPEN = 200;

function readGameInput(s: QDataStreamReader, playerVersion: number): number {
  const aiType = s.int32();
  if (playerVersion <= 7) return aiType;

  // createAi() yields nullptr for these, so no object payload follows.
  if (aiType === AI_OPEN || aiType === AI_CLOSED) return aiType;

  const inputVersion = s.int32();
  if (aiType === AI_HUMAN) {
    // gameinput/humanplayerinput.cpp
    if (inputVersion === 2) s.string();
    return aiType;
  }
  if (aiType === AI_PROXY) {
    // ai/proxyai.cpp: a buffered-action queue follows the version.
    if (inputVersion > 1) {
      const buffered = s.int32();
      if (buffered > 0) {
        throw new Error(`ProxyAi carries ${buffered} buffered actions; GameAction parsing is not implemented`);
      }
    }
    if (inputVersion === 3) s.string();
    return aiType;
  }
  if (aiType === AI_MOVE_PLANNER || aiType === AI_DUMMY) {
    return aiType;
  }

  // VeryEasy / Normal* / Heavy all funnel through CoreAI::deserializeObjectVersion.
  readCoreAi(s, inputVersion);
  return aiType;
}

/** ai/coreai.cpp: CoreAI::deserializeObjectVersion */
function readCoreAi(s: QDataStreamReader, version: number): void {
  if (version > 1) s.bool();                      // enableNeutralTerrainAttack
  if (version > 2) {
    const size = s.int32();                       // building chance modifiers
    for (let i = 0; i < size; i++) { s.string(); s.float(); }
  }
  if (version > 3) {
    const size = s.int32();                       // move cost map
    for (let x = 0; x < size; x++) {
      const ysize = s.int32();
      for (let y = 0; y < ysize; y++) { s.int32(); s.bool(); }
    }
  }
  if (version > 4) {
    const size = s.int32();                       // ini file names
    for (let i = 0; i < size; i++) s.string();
  }
  if (version > 5) {
    const size = s.int32();                       // ini overrides
    for (let i = 0; i < size; i++) { s.string(); s.double(); }
  }
  if (version === 7) s.string();
  if (version > 8) readScriptVariables(s);
  if (version > 9) readProductionSystem(s);
}

/** ai/productionSystem/simpleproductionsystem.cpp: SimpleProductionSystem::deserializeObject */
function readProductionSystem(s: QDataStreamReader): void {
  const version = s.int32();
  s.bool();                                       // m_init

  let size = s.int32();                           // build distributions
  for (let i = 0; i < size; i++) {
    s.string();                                   // key
    const entries = s.int32();
    for (let k = 0; k < entries; k++) { s.string(); s.int32(); }
    s.int32();                                    // totalChance
    s.double();                                   // distribution
    s.double();                                   // maxUnitDistribution
    s.string();                                   // guardCondition
    s.int32();                                    // buildMode
  }

  size = s.int32();                               // initial production
  for (let i = 0; i < size; i++) {
    const ids = s.int32();
    for (let k = 0; k < ids; k++) s.string();
    s.int32();                                    // count
  }

  readScriptVariables(s);
  if (version > 0) s.int32();                     // currentTurnProducedUnitsCounter
  if (version > 1) {
    size = s.int32();                             // forced production
    for (let i = 0; i < size; i++) {
      s.int32(); s.int32();
      const ids = s.int32();
      for (let k = 0; k < ids; k++) s.string();
    }
    size = s.int32();                             // priority production
    for (let i = 0; i < size; i++) {
      s.int32(); s.int32(); s.bool();
      const ids = s.int32();
      for (let k = 0; k < ids; k++) s.string();
    }
  }
}

/** game/player.cpp: Player::deserializer */
function readPlayer(s: QDataStreamReader): MapPlayer {
  const version = s.int32();
  const color = s.uint32();

  const player: MapPlayer = {
    color, funds: 0, fundsModifier: 0, army: '', team: 0, isDefeated: false,
    cos: [null, null], buildList: [], controlType: 0, playerNameId: '',
  };
  if (version <= 1) return player;

  if (version < 3) s.int32();
  player.funds = s.int32();
  player.fundsModifier = version > 18 ? s.double() : s.float();
  player.army = s.string();

  for (let i = 0; i < 2; i++) {
    if (s.bool()) player.cos[i] = readCO(s);
  }
  if (version > 3) player.team = s.int32();
  if (version > 4) {
    player.isDefeated = s.bool();
    readGameInput(s, version);
  }
  if (version > 5) {
    const width = s.int32();
    const height = s.int32();
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        if (version > 10) s.int32();
        else if (version > 8) s.bool();
        else s.int32();
        s.int32();                    // duration
        if (version > 8) s.bool();    // directView
      }
    }
  }

  if (version > 17) player.buildList = s.stringList();
  else if (version > 6) player.buildList = s.stringList();
  if (version > 9) s.bool();          // buildlistChanged
  if (version > 11) readScriptVariables(s);

  if (version > 12 && version <= 14) {
    const width = s.int32();
    for (let x = 0; x < width; x++) s.uint32();
  }
  if (version > 13) s.bool();         // playerArmySelected (bool, not a string)
  if (version > 15) player.playerNameId = s.string();
  if (version > 16) player.controlType = s.int32();

  return player;
}

/** game/building.cpp: Building::deserializer */
function readBuilding(s: QDataStreamReader): MapBuilding {
  const version = s.int32();
  const buildingID = version > 3 ? s.string() : s.string();
  const playerID = s.int32();
  let hp = -1;
  let fireCount = 0;
  if (version > 1) {
    hp = s.int32();
    fireCount = s.int32();
  }
  if (version > 2) readScriptVariables(s);
  const buildingName = version > 4 ? s.string() : '';
  return { buildingID, playerID, hp, fireCount, buildingName };
}

/** game/unit.cpp: Unit::deserializer (map files are never savegames) */
function readUnit(s: QDataStreamReader): MapUnit {
  const version = s.int32();
  const unitID = s.string();
  const hp = version > 22 ? s.double() : s.float();
  const ammo1 = s.int32();
  const ammo2 = s.int32();
  const fuel = s.int32();
  const rank = s.int32();
  const playerID = s.uint32();

  const unit: MapUnit = {
    unitID, hp, ammo1, ammo2, fuel, rank, playerID,
    hasMoved: false, capturePoints: 0, hidden: false, transported: [],
  };

  if (version > 1) {
    unit.hasMoved = s.bool();
    const count = s.int32();
    for (let i = 0; i < count; i++) unit.transported.push(readUnit(s));
  }
  if (version > 2) unit.capturePoints = s.int32();
  if (version > 3) unit.hidden = s.bool();
  if (version > 4) readScriptVariables(s);
  if (version > 5) s.bool();          // ignoreUnitCollision (dummy outside savegames)
  if (version > 6) s.int32();         // aiMode
  if (version > 7) s.int32();         // uniqueID
  if (version > 8) s.uint8();         // modding flags

  if (version > 9) {
    const readPoints = () => { const n = s.int32(); for (let i = 0; i < n; i++) s.point(); };
    readPoints();                     // multi-turn path
    if (version > 11) {
      readPoints();                   // offensive bonus
      readPoints();                   // defensive bonus
      readPoints();                   // vision bonus
      readPoints();                   // movement bonus
      readPoints();                   // firerange bonus
    }
  }
  if (version > 12) {
    if (version > 18) { const n = s.int32(); for (let i = 0; i < n; i++) s.point(); }
    else s.int32();                   // cloak duration
  }
  if (version > 13) s.int32();        // vision high
  if (version > 14) s.string();       // custom name
  if (version > 15) { const n = s.int32(); for (let i = 0; i < n; i++) s.point(); }
  if (version > 16) {
    const n = s.int32();
    for (let i = 0; i < n; i++) { s.string(); s.int32(); s.int32(); s.int32(); s.int32(); }
  }
  if (version > 17) {
    s.string(); s.string();           // weapon ids (dummies outside savegames)
    for (let i = 0; i < 7; i++) s.int32();
    if (version > 21) s.string();     // movement type
  }
  if (version > 19) {
    const n = s.int32();
    for (let i = 0; i < n; i++) { s.string(); s.int32(); s.uint32(); }
  }
  if (version > 20) s.int32();        // cursor info range
  if (version > 23) { const n = s.int32(); for (let i = 0; i < n; i++) s.int32(); }
  if (version > 24) s.int32();        // ai priority

  return unit;
}

/** game/terrain.cpp: Terrain::deserializer */
function readTerrain(s: QDataStreamReader, x: number, y: number): MapTile {
  const version = s.int32();
  let spriteName = '';
  let fixedSprite = false;
  if (version > 3) {
    spriteName = s.string();
    fixedSprite = s.bool();
  }
  const terrainID = s.string();

  const tile: MapTile = {
    x, y, terrainID, spriteName, fixedSprite,
    hp: -1, palette: '', building: null, unit: null, baseTerrain: null,
  };

  if (s.bool()) tile.baseTerrain = readTerrain(s, x, y);
  if (s.bool()) tile.building = readBuilding(s);
  if (s.bool()) tile.unit = readUnit(s);
  if (version > 1) tile.hp = s.int32();
  if (version > 4) {
    s.string();                       // terrain name
    if (version > 10) s.bool();       // custom name flag
    s.string();                       // terrain description
  }
  if (version > 5 && version < 9) s.bool();
  if (version > 6) readScriptVariables(s);
  if (version > 7) {
    const size = s.int32();
    for (let i = 0; i < size; i++) {
      s.int32();                      // duration
      s.string();                     // resAnim
      s.float();                      // scale
      s.int32(); s.int32();           // offset x/y
      s.uint32();                     // colour
    }
  }
  if (version > 9) {
    if (s.bool()) {                   // fixed overlay sprites
      const size = s.int32();
      for (let i = 0; i < size; i++) {
        s.string();
        if (version > 13) s.string(); // palette
      }
    }
  }
  if (version > 11) tile.palette = s.string();
  if (version > 12) readScriptVariables(s);

  return tile;
}

/**
 * game/gamemap.cpp: GameMap::deserializer.
 * From version 17 the body after the header is a single qCompress'd blob.
 */
export function readMap(data: Uint8Array): CommanderWarsMap {
  const outer = new QDataStreamReader(data.buffer, data.byteOffset, data.byteLength);
  const header = readHeader(outer);

  let s = outer;
  if (header.version > 16) {
    const compressed = outer.byteArray();
    // qCompress prefixes zlib data with a 4-byte big-endian uncompressed size.
    const inflated = zlib.inflateSync(compressed.subarray(4));
    s = new QDataStreamReader(inflated.buffer, inflated.byteOffset, inflated.byteLength);
  }

  const players: MapPlayer[] = [];
  for (let i = 0; i < header.playerCount; i++) players.push(readPlayer(s));

  let currentPlayer = 0;
  let currentDay = 0;
  if (header.version > 1) {
    currentPlayer = s.int32();
    currentDay = s.int32();
  }

  const tiles: MapTile[][] = [];
  for (let y = 0; y < header.height; y++) {
    const row: MapTile[] = [];
    for (let x = 0; x < header.width; x++) row.push(readTerrain(s, x, y));
    tiles.push(row);
  }

  return { header, players, currentPlayer, currentDay, tiles, unparsedTailBytes: s.remaining };
}

/** Exposed for tests and format bisection, not part of the public surface. */
export const internals = { readHeader, readPlayer, readTerrain, readUnit, readBuilding, readScriptVariables, readCoreAi, readProductionSystem };
