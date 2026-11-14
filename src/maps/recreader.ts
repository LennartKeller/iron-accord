/**
 * Reader for Commander Wars replay records (`.rec`).
 *
 * A record is what the real game writes while it plays
 * (game/gamerecording/replayrecorder.cpp): the starting map, every action, and
 * a full map at the start of every player-turn. That makes it ground truth for
 * this project's engine — see src/game/upstream.node.ts, which replays the
 * actions here and compares against those maps.
 *
 * Layout, all QDataStream big-endian:
 *
 *   qint32 version (3) · QString "CoWRecord" · QByteArray info JSON
 *   qint64 streamStart
 *   qint32 size + that many bytes   the script environment, qCompressed
 *   QStringList mods · qint32 winnerTeam · qint32 actionCount
 *   the starting map                GameMap::serializeObject, as in a .map
 *   --- streamStart ---
 *   records: qint32 version · qint32 type · qint64 nextSeekPos · payload
 *     type 0  a GameAction
 *     type 1  qint32 day · qint32 player · qint32 actionCount · a map
 *
 * `nextSeekPos` is an absolute file offset, written after the payload — so a
 * record cut off mid-write (the game was killed) carries a zero there and is
 * where reading stops.
 *
 * Node-only, like mapreader.ts: maps are zlib-compressed.
 */
import { QDataStreamReader } from './qdatastream.ts';
import { readMap, type CommanderWarsMap } from './mapreader.ts';

const MARKER = 'CoWRecord';
const TYPE_ACTION = 0;
const TYPE_MAP = 1;
/** version + type + nextSeekPos. */
const RECORD_HEADER = 16;

export interface RecordedAction {
  /** Position in the record's action sequence. */
  index: number;
  actionID: string;
  /** Where the acting unit (or building) stands when the action starts. */
  target: { x: number; y: number };
  /**
   * The route as Commander Wars stores it: DESTINATION FIRST, start last.
   * iron-accord's host keeps paths start-first; reverse before handing over.
   */
  path: Array<{ x: number; y: number }>;
  inputStep: number;
  /** Fuel for a move, funds for a purchase — the action script decides which. */
  costs: number;
  /**
   * The action's input buffer, raw. Its fields are typed only by the order the
   * action script reads them in, so it stays bytes until a script reads it.
   */
  buffer: Uint8Array;
  seed: number;
}

export interface RecordedSnapshot {
  day: number;
  player: number;
  /** How many actions had been performed when this map was written. */
  actionCount: number;
  map: CommanderWarsMap;
}

export interface UpstreamRecord {
  version: number;
  /** The record's own description: map name, size, players. */
  info: Record<string, unknown>;
  mods: string[];
  winnerTeam: number;
  /** The map before anyone's first turn began (no income paid yet). */
  initial: CommanderWarsMap;
  actions: RecordedAction[];
  /** One per player-turn, taken after that turn's start-of-turn processing. */
  snapshots: RecordedSnapshot[];
  /** True when the file ended inside a record. */
  truncated: boolean;
}

interface Header {
  version: number;
  infoJson: Uint8Array;
  streamStart: number;
  mods: string[];
  winnerTeam: number;
  count: number;
  mapStart: number;
}

function readerAt(data: Uint8Array, offset: number): QDataStreamReader {
  return new QDataStreamReader(data.buffer, data.byteOffset + offset, data.byteLength - offset);
}

function readHeader(data: Uint8Array): Header {
  const s = readerAt(data, 0);
  const version = s.int32();
  const marker = s.string();
  if (marker !== MARKER) throw new Error(`not a Commander Wars record: marker "${marker.slice(0, 20)}"`);
  if (version < 3) throw new Error(`record version ${version} is older than this reader supports (3)`);
  const infoJson = s.byteArray();
  const streamStart = Number(s.uint64());
  s.skip(s.int32());                      // the script environment
  const mods = s.stringList();
  const winnerTeam = s.int32();
  const count = s.int32();
  return { version, infoJson, streamStart, mods, winnerTeam, count, mapStart: s.position };
}

/** Walks the record headers; stops at the first one that was never finished. */
function* recordSpans(data: Uint8Array, start: number): Generator<{ type: number; version: number; start: number; end: number }> {
  let position = start;
  while (position + RECORD_HEADER <= data.byteLength) {
    const s = readerAt(data, position);
    const version = s.int32();
    const type = s.int32();
    const end = Number(s.uint64());
    if (end <= position || end > data.byteLength) return;
    yield { type, version, start: position, end };
    position = end;
  }
}

function readAction(s: QDataStreamReader, index: number): RecordedAction {
  s.int32();                              // GameAction version
  const actionID = s.string();
  const target = s.point();
  const path: Array<{ x: number; y: number }> = [];
  for (let n = s.int32(); n > 0; n--) path.push(s.point());
  const inputStep = s.int32();
  const costs = s.int32();
  const size = s.int32();
  const buffer = new Uint8Array(size);
  for (let i = 0; i < size; i++) buffer[i] = s.uint8();
  const seed = s.uint32();
  // The multi-turn path, sync counter, timer and map hash follow; none of them
  // affects what the action does.
  return { index, actionID, target, path, inputStep, costs, buffer, seed };
}

export function readRecord(data: Uint8Array): UpstreamRecord {
  const header = readHeader(data);
  const info = JSON.parse(new TextDecoder().decode(header.infoJson) || '{}') as Record<string, unknown>;
  const initial = readMap(data.subarray(header.mapStart, header.streamStart));

  const actions: RecordedAction[] = [];
  const snapshots: RecordedSnapshot[] = [];
  let consumed = header.streamStart;
  for (const span of recordSpans(data, header.streamStart)) {
    const s = readerAt(data, span.start + RECORD_HEADER);
    if (span.type === TYPE_ACTION) {
      actions.push(readAction(s, actions.length));
    } else if (span.type === TYPE_MAP) {
      const day = s.int32();
      const player = s.int32();
      const actionCount = s.int32();
      snapshots.push({ day, player, actionCount, map: readMap(data.subarray(span.start + RECORD_HEADER + 12, span.end)) });
    }
    consumed = span.end;
  }

  return {
    version: header.version, info, mods: header.mods, winnerTeam: header.winnerTeam,
    initial, actions, snapshots, truncated: consumed < data.byteLength,
  };
}

// --- writing ---------------------------------------------------------------

class Writer {
  private chunks: Uint8Array[] = [];
  length = 0;

  raw(bytes: Uint8Array): void { this.chunks.push(bytes); this.length += bytes.byteLength; }
  int32(value: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, value, false);
    this.raw(b);
  }
  int64(value: number): void {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, BigInt(value), false);
    this.raw(b);
  }
  string(value: string): void {
    this.int32(value.length * 2);
    const b = new Uint8Array(value.length * 2);
    const view = new DataView(b.buffer);
    for (let i = 0; i < value.length; i++) view.setUint16(i * 2, value.charCodeAt(i), false);
    this.raw(b);
  }
  byteArray(value: Uint8Array): void { this.int32(value.byteLength); this.raw(value); }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
    return out;
  }
}

/**
 * A record with everything this project does not read removed, for committing
 * as a fixture.
 *
 * A fresh record is a quarter script environment (a compressed copy of every
 * rule script, there so the game can refuse to replay under different rules)
 * and can carry a minimap image. Neither is read here. `extra` is merged into
 * the info JSON — it is where the recording settings that the map's unparsed
 * rule block would otherwise hide (fog mode, the AI that played) are kept.
 *
 * Offsets are absolute, so every record's `nextSeekPos` is rewritten; an
 * unfinished final record is dropped.
 */
export function trimRecord(data: Uint8Array, extra: Record<string, unknown> = {}): Uint8Array {
  const header = readHeader(data);
  const info = JSON.parse(new TextDecoder().decode(header.infoJson) || '{}') as Record<string, unknown>;
  delete info.minimapData;
  const infoJson = new TextEncoder().encode(JSON.stringify({ ...info, ...extra }));
  const spans = [...recordSpans(data, header.streamStart)];
  const map = data.subarray(header.mapStart, header.streamStart);

  const w = new Writer();
  w.int32(header.version);
  w.string(MARKER);
  w.byteArray(infoJson);
  // streamStart: this field, the empty environment, the mod list, two counters, the map.
  const modBytes = header.mods.reduce((sum, mod) => sum + 4 + mod.length * 2, 4);
  const streamStart = w.length + 8 + 4 + modBytes + 4 + 4 + map.byteLength;
  w.int64(streamStart);
  w.int32(0);
  w.int32(header.mods.length);
  for (const mod of header.mods) w.string(mod);
  w.int32(header.winnerTeam);
  w.int32(spans.filter(span => span.type === TYPE_ACTION).length);
  w.raw(map);
  if (w.length !== streamStart) throw new Error('record trim: header size miscounted');

  for (const span of spans) {
    const payload = data.subarray(span.start + RECORD_HEADER, span.end);
    w.int32(span.version);
    w.int32(span.type);
    w.int64(w.length + 8 + payload.byteLength);
    w.raw(payload);
  }
  return w.bytes();
}
