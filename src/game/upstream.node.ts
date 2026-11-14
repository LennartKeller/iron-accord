/**
 * Differential replay against the real Commander Wars.
 *
 * The golden replays (src/ai/golden.node.ts) pin what this engine does. They
 * cannot say whether that is RIGHT: a month of self-play ran on an engine that
 * let units walk through enemies, and every test passed. This is the other
 * half — an outside referent.
 *
 * A Commander Wars record holds every action the real game performed and the
 * full board at the start of every player-turn. So each player-turn is an
 * independent test: load upstream's board, perform upstream's actions with this
 * engine, and compare with upstream's next board. Starting every turn from
 * upstream's own state keeps one disagreement from cascading into the rest of
 * the game, and an attack carries its rolled damage in the action, so no dice
 * have to match.
 *
 * What it cannot see: anything the map reader does not carry (unit script
 * variables, timed bonuses, cloak timers, fog vision fields) is rebuilt from
 * defaults at the top of each turn, and rules upstream has that this engine
 * does not (weather, unit ranks, COs) must be switched off when recording.
 * See docs/upstream-differential.md.
 *
 * Node-only: reads records through the map reader.
 */
import { GameAction } from '../host/gameaction.ts';
import type { Unit } from '../host/unit.ts';
import { QDataStreamReader } from '../maps/qdatastream.ts';
import { loadIntoGameMap } from '../maps/loadmap.ts';
import type { MapUnit } from '../maps/mapreader.ts';
import type { RecordedAction, RecordedSnapshot, UpstreamRecord } from '../maps/recreader.ts';
import type { Bootstrapped } from './bootstrap.node.ts';
import { Game } from './game.ts';

type Runtime = Pick<Bootstrapped, 'registry' | 'animations'>;

/**
 * A GameAction whose input buffer is upstream's raw bytes.
 *
 * Commander Wars types the buffer only by the order an action script reads it
 * in, so the bytes cannot be decoded ahead of time — the script that performs
 * the action is the only thing that knows an int32 from a string. Reading them
 * lazily, as the script asks, needs no per-action knowledge here at all.
 */
export class RecordedGameAction extends GameAction {
  private raw: Uint8Array = new Uint8Array(0);
  private rawReader: QDataStreamReader | null = null;

  setRecordedBuffer(bytes: Uint8Array): void {
    this.raw = bytes;
    this.rawReader = null;
  }

  private reader(): QDataStreamReader {
    this.rawReader ??= new QDataStreamReader(this.raw.buffer, this.raw.byteOffset, this.raw.byteLength);
    return this.rawReader;
  }

  startReading(): void { this.rawReader = null; }
  readDataInt32(): number { return this.reader().int32(); }
  readDataString(): string { return this.reader().string(); }
  readDataFloat(): number { return this.reader().float(); }
}

/** One thing that differs between upstream's board and ours. */
export interface Difference {
  /**
   * What kind of disagreement this is, stable across games: `unit.fuel:APC`,
   * `building.owner:TOWN`, `funds`. Known differences are tracked by kind.
   */
  kind: string;
  where: string;
  expected: unknown;
  actual: unknown;
}

export interface TurnResult {
  /** Index of the snapshot this turn starts from. */
  index: number;
  day: number;
  player: number;
  /** The record's action indices performed this turn, inclusive. */
  firstAction: number;
  lastAction: number;
  /** Actions this engine would not perform. */
  refused: Array<{ index: number; actionID: string }>;
  /**
   * Differences between the board this engine rebuilt from upstream's snapshot
   * and that same snapshot — i.e. state the loader cannot represent. They are
   * not counted against the turn, but explain differences that follow.
   */
  loadDifferences: Difference[];
  differences: Difference[];
}

export interface DifferentialReport {
  turns: TurnResult[];
  /** Turns with no refused action and no difference. */
  exact: number;
  actions: number;
  /** Occurrences per difference kind, across all turns. */
  kinds: Map<string, number>;
}

export interface DifferentialOptions {
  /** The fog mode the game was recorded under; the reader skips the rule block. */
  fog?: number;
}

/** Upstream writes HP on a 0.01 grid; one step of slack absorbs the rounding. */
const HP_TOLERANCE = 0.0101;

function gameAt(runtime: Runtime, snapshot: RecordedSnapshot, options: DifferentialOptions): Game {
  const map = loadIntoGameMap(snapshot.map, runtime.registry);
  map.getGameRules().setFogMode(options.fog ?? 0);
  return new Game(map, runtime.registry, runtime.animations, {
    resume: { day: snapshot.day, currentPlayer: snapshot.player },
  });
}

function perform(game: Game, recorded: RecordedAction): boolean {
  if (recorded.actionID === 'ACTION_NEXT_PLAYER') {
    game.endTurn();
    return true;
  }
  const { map } = game;
  const action = new RecordedGameAction(map, recorded.actionID);
  action.setRecordedBuffer(recorded.buffer);
  // GameAction::getTargetUnit is simply "the unit on the target tile".
  const unit = map.onMap(recorded.target.x, recorded.target.y)
    ? map.getUnitAt(recorded.target.x, recorded.target.y) : null;
  if (unit) action.setTargetUnit(unit);
  action.setTarget(recorded.target);
  action.setMovepath([...recorded.path].reverse(), recorded.costs);
  action.setInputStep(recorded.inputStep);
  return game.performRecorded(action);
}

function compareUnit(where: string, expected: MapUnit | null, actual: Unit | null, out: Difference[]): void {
  if (!expected && !actual) return;
  if (!expected || !actual) {
    out.push(expected
      ? { kind: `unit.missing:${expected.unitID}`, where, expected: expected.unitID, actual: null }
      : { kind: `unit.extra:${actual!.getUnitID()}`, where, expected: null, actual: actual!.getUnitID() });
    return;
  }
  const id = expected.unitID;
  if (id !== actual.getUnitID()) {
    out.push({ kind: `unit.id:${id}`, where, expected: id, actual: actual.getUnitID() });
    return;
  }
  const check = (field: string, e: unknown, a: unknown, same = e === a) => {
    if (!same) out.push({ kind: `unit.${field}:${id}`, where, expected: e, actual: a });
  };
  check('owner', expected.playerID, actual.getOwner().getPlayerID());
  check('hp', expected.hp, actual.getHp(), Math.abs(expected.hp - actual.getHp()) <= HP_TOLERANCE);
  check('ammo1', expected.ammo1, actual.getAmmo1());
  check('ammo2', expected.ammo2, actual.getAmmo2());
  check('fuel', expected.fuel, actual.getFuel());
  check('moved', expected.hasMoved, actual.hasMoved);
  check('capture', expected.capturePoints, actual.getCapturePoints());
  check('hidden', expected.hidden, actual.hidden);
  check('cargo', expected.transported.length, actual.loaded.length);
  if (expected.transported.length === actual.loaded.length) {
    expected.transported.forEach((carried, i) => compareUnit(`${where} cargo ${i}`, carried, actual.loaded[i], out));
  }
}

/** Everything in which this engine's board disagrees with an upstream snapshot. */
export function compareWithSnapshot(game: Game, snapshot: RecordedSnapshot): Difference[] {
  const out: Difference[] = [];
  const { map } = game;

  if (game.day !== snapshot.day || game.currentPlayerIndex !== snapshot.player) {
    out.push({ kind: 'turn', where: 'game',
      expected: `day ${snapshot.day} player ${snapshot.player}`,
      actual: `day ${game.day} player ${game.currentPlayerIndex}` });
  }
  snapshot.map.players.forEach((player, index) => {
    const ours = map.players[index];
    if (player.funds !== ours.funds) out.push({ kind: 'funds', where: `player ${index}`, expected: player.funds, actual: ours.funds });
    if (player.isDefeated !== ours.isDefeated) {
      out.push({ kind: 'defeated', where: `player ${index}`, expected: player.isDefeated, actual: ours.isDefeated });
    }
  });

  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const where = `${x},${y}`;
      const tile = snapshot.map.tiles[y][x];
      const terrain = map.getTerrain(x, y);
      if (tile.terrainID !== terrain.getTerrainID()) {
        out.push({ kind: `terrain:${tile.terrainID}`, where, expected: tile.terrainID, actual: terrain.getTerrainID() });
      }

      const building = terrain.getBuilding();
      if (!tile.building !== !building) {
        out.push({ kind: `building.present:${tile.building?.buildingID ?? building?.getBuildingID()}`, where,
          expected: tile.building?.buildingID ?? null, actual: building?.getBuildingID() ?? null });
      } else if (tile.building && building) {
        const id = tile.building.buildingID;
        const owner = building.getOwner()?.getPlayerID() ?? -1;
        if (id !== building.getBuildingID()) out.push({ kind: `building.id:${id}`, where, expected: id, actual: building.getBuildingID() });
        if (tile.building.playerID !== owner) out.push({ kind: `building.owner:${id}`, where, expected: tile.building.playerID, actual: owner });
        if (tile.building.fireCount !== building.fireCount) {
          out.push({ kind: `building.fireCount:${id}`, where, expected: tile.building.fireCount, actual: building.fireCount });
        }
      }

      compareUnit(where, tile.unit, map.getUnitAt(x, y), out);
    }
  }
  return out;
}

/** Replays every player-turn of a record with this engine and reports where it departs. */
export function diffRecord(runtime: Runtime, record: UpstreamRecord, options: DifferentialOptions = {}): DifferentialReport {
  const report: DifferentialReport = { turns: [], exact: 0, actions: record.actions.length, kinds: new Map() };

  for (let index = 0; index + 1 < record.snapshots.length; index++) {
    const from = record.snapshots[index];
    const to = record.snapshots[index + 1];
    const game = gameAt(runtime, from, options);
    const turn: TurnResult = {
      index, day: from.day, player: from.player,
      firstAction: from.actionCount, lastAction: to.actionCount - 1,
      refused: [], loadDifferences: compareWithSnapshot(game, from), differences: [],
    };

    for (let i = from.actionCount; i < to.actionCount; i++) {
      const recorded = record.actions[i];
      if (!recorded) break;
      if (!perform(game, recorded)) turn.refused.push({ index: i, actionID: recorded.actionID });
    }
    turn.differences = compareWithSnapshot(game, to);

    if (turn.refused.length === 0 && turn.differences.length === 0) report.exact++;
    for (const difference of turn.differences) {
      report.kinds.set(difference.kind, (report.kinds.get(difference.kind) ?? 0) + 1);
    }
    for (const refused of turn.refused) {
      const kind = `refused:${refused.actionID}`;
      report.kinds.set(kind, (report.kinds.get(kind) ?? 0) + 1);
    }
    report.turns.push(turn);
  }
  return report;
}

export function describeReport(report: DifferentialReport, record: UpstreamRecord, showTurns = 5): string {
  const lines = [
    `${report.turns.length} player-turns, ${report.actions} actions: ${report.exact} turns reproduce exactly, ` +
      `${report.turns.length - report.exact} differ`,
  ];
  if (report.kinds.size > 0) {
    lines.push('difference kinds: ' + [...report.kinds].sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${kind} x${n}`).join(', '));
  }
  let shown = 0;
  for (const turn of report.turns) {
    if (turn.refused.length === 0 && turn.differences.length === 0) continue;
    if (shown++ >= showTurns) break;
    const acts = new Set(record.actions.slice(turn.firstAction, turn.lastAction + 1).map(a => a.actionID.replace('ACTION_', '')));
    lines.push(`turn ${turn.index}: day ${turn.day} player ${turn.player}, actions ${turn.firstAction}..${turn.lastAction} (${[...acts].join(', ')})`);
    if (turn.loadDifferences.length > 0) {
      lines.push(`  already differs after loading the snapshot: ${[...new Set(turn.loadDifferences.map(d => d.kind))].join(', ')}`);
    }
    for (const refused of turn.refused.slice(0, 4)) lines.push(`  refused action ${refused.index} ${refused.actionID}`);
    for (const d of turn.differences.slice(0, 8)) {
      lines.push(`  ${d.where} ${d.kind}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`);
    }
    if (turn.differences.length > 8) lines.push(`  ... ${turn.differences.length - 8} more`);
  }
  return lines.join('\n');
}
