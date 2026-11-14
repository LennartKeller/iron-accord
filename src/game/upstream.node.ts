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
 * Before each action is performed it is also checked that this engine would
 * have OFFERED it — reachable, on the menu, same cost — since agreeing on an
 * action's effects says nothing about whether an agent could have chosen it.
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
  /** Which player-turn of the game this is; 0 is the opening turn. */
  index: number;
  day: number;
  player: number;
  /** The record's action indices performed this turn, inclusive. */
  firstAction: number;
  lastAction: number;
  /** Actions this engine would not perform. */
  refused: Array<{ index: number; actionID: string }>;
  /**
   * Actions the real game performed that this engine would not have OFFERED a
   * player or an agent: unreachable, missing from the menu, priced differently.
   * They are still performed as recorded, so the turn can be compared anyway.
   */
  unoffered: Difference[];
  /**
   * Differences between the board this engine rebuilt from upstream's snapshot
   * and that same snapshot — i.e. state the loader cannot represent. They are
   * not counted against the turn, but explain differences that follow.
   */
  loadDifferences: Difference[];
  differences: Difference[];
  /**
   * True when the board only matched under a different start-of-turn order
   * than this engine's. Commander Wars shuffles that order every turn, so such
   * a turn agrees with upstream as far as anything short of sharing its dice
   * can show; `differences` is then empty.
   */
  orderDependent: boolean;
}

export interface DifferentialReport {
  turns: TurnResult[];
  /** Turns with no refused action and no difference. */
  exact: number;
  /** Of those, the ones that needed another start-of-turn order to match. */
  orderDependent: number;
  actions: number;
  /** Occurrences per difference kind, across all turns. */
  kinds: Map<string, number>;
}

export interface DifferentialOptions {
  /** The fog mode the game was recorded under; the reader skips the rule block. */
  fog?: number;
  /**
   * Rules the recording was made under. A record stamps these when it is
   * trimmed; where it does not, the values are what tools/upstream/record.sh
   * has always used: special destruction left at Commander Wars' default (on),
   * the other two switched off.
   */
  specialDestruction?: boolean;
  moveVision?: boolean;
  transporterRefresh?: boolean;
}

function applyRules(map: ReturnType<typeof loadIntoGameMap>, options: DifferentialOptions): void {
  const rules = map.getGameRules();
  rules.setFogMode(options.fog ?? 0);
  rules.setSpecialDestruction(options.specialDestruction ?? true);
  rules.setMoveVision(options.moveVision ?? false);
  rules.setTransporterRefresh(options.transporterRefresh ?? false);
}

/** The settings a trimmed record carries, as options. */
export function recordedOptions(record: UpstreamRecord): DifferentialOptions {
  const stamped = (record.info.ironAccord ?? {}) as Record<string, unknown>;
  const flag = (key: string) => typeof stamped[key] === 'boolean' ? stamped[key] as boolean : undefined;
  return {
    fog: typeof stamped.fog === 'number' ? stamped.fog : 0,
    specialDestruction: flag('specialDestruction'),
    moveVision: flag('moveVision'),
    transporterRefresh: flag('transporterRefresh'),
  };
}

/** How many start-of-turn orders to try before a difference is taken as real. */
const ORDER_ATTEMPTS = 48;

/** A seeded Fisher-Yates over 0..n-1, so a report is the same every run. */
function shuffler(seed: number): (n: number) => number[] {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
  return n => {
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
  };
}

/** Upstream writes HP on a 0.01 grid; one step of slack absorbs the rounding. */
const HP_TOLERANCE = 0.0101;

function gameAt(runtime: Runtime, snapshot: RecordedSnapshot, options: DifferentialOptions): Game {
  const map = loadIntoGameMap(snapshot.map, runtime.registry);
  applyRules(map, options);
  // Temporary reveals (a flare, an ambush) are state, not something vision can
  // be recomputed from: carry the ones still running into the resumed game.
  snapshot.map.players.forEach((player, index) => {
    const vision = player.vision;
    if (!vision) return;
    for (let at = 0; at < vision.duration.length; at++) {
      if (vision.duration[at] <= 0) continue;
      map.players[index]?.addVisionField(at % vision.width, Math.floor(at / vision.width), vision.duration[at], vision.direct[at] === 1);
    }
  });
  // Under shroud, what each player has explored is state too.
  map.vision.importMemory(snapshot.map.players.map(player => player.vision?.type ?? []));
  return new Game(map, runtime.registry, runtime.animations, {
    resume: { day: snapshot.day, currentPlayer: snapshot.player },
  });
}

/**
 * The game as it starts. A record's first map is taken before anyone's first
 * turn has begun, so this goes through the ordinary constructor — which is the
 * point: the opening turn then also checks the first income and upkeep.
 */
function gameAtStart(runtime: Runtime, record: UpstreamRecord, options: DifferentialOptions): Game {
  const map = loadIntoGameMap(record.initial, runtime.registry);
  applyRules(map, options);
  return new Game(map, runtime.registry, runtime.animations);
}

/**
 * Would this engine have offered the action upstream performed?
 *
 * Performing a recorded action as given only shows that the EFFECTS agree. An
 * agent never gets that far unless the action is first reachable, on the menu
 * and priced the same — which is where the engine once let units fire from
 * tiles they could not reach. This asks the same questions the UI and the
 * action enumeration ask, before the action is performed.
 *
 * One-sided by nature: a record holds what Commander Wars allowed, never what
 * it refused, so this cannot show the engine offering too much.
 */
function offered(game: Game, recorded: RecordedAction): Difference | null {
  const { actionID, target } = recorded;
  // Not a choice: the engine substitutes ACTION_TRAP itself, and ending the
  // turn is always available.
  if (actionID === 'ACTION_NEXT_PLAYER' || actionID === 'ACTION_TRAP') return null;

  const { map } = game;
  const where = `${target.x},${target.y}`;
  const miss = (reason: string, expected: unknown, actual: unknown): Difference =>
    ({ kind: `offer.${reason}:${actionID}`, where, expected, actual });
  const input = new QDataStreamReader(recorded.buffer.buffer, recorded.buffer.byteOffset, recorded.buffer.byteLength);

  if (actionID === 'ACTION_BUILD_UNITS') {
    if (!game.canProduceAt(target.x, target.y)) return miss('site', 'can produce here', 'cannot');
    const unitID = input.string();
    const option = game.buildOptions(map.getTerrain(target.x, target.y).getBuilding()!).find(entry => entry.id === unitID);
    if (!option) return miss('unit', unitID, 'not on the build menu');
    if (option.cost !== recorded.costs) return miss('price', recorded.costs, option.cost);
    if (!option.affordable) return miss('funds', `can afford ${unitID}`, 'cannot');
    return null;
  }

  const unit = map.onMap(target.x, target.y) ? map.getUnitAt(target.x, target.y) : null;
  if (!unit || (recorded.path.length === 0 && !unit.getActionList().includes(actionID))) {
    // Nothing moves: an order given to a building.
    return game.probeBuildingAction(target, actionID).kind === 'invalid'
      ? miss('building', 'available', 'not available') : null;
  }

  const range = game.select(unit.x, unit.y);
  try {
    if (!range) return miss('control', 'unit can be ordered', 'cannot');
    const destination = recorded.path[0] ?? target;
    const tile = range.tiles.get(`${destination.x},${destination.y}`);
    if (!tile) return miss('reach', `reaches ${destination.x},${destination.y}`, 'unreachable');
    if (!tile.canAct) return miss('stop', `can act at ${destination.x},${destination.y}`, 'cannot');
    if (tile.cost !== recorded.costs) return miss('cost', recorded.costs, tile.cost);
    if (!game.availableActions(unit, destination).some(option => option.id === actionID)) {
      return miss('menu', 'on the action menu', 'missing');
    }
    if (actionID === 'ACTION_FIRE') {
      const aim = { x: input.int32(), y: input.int32() };
      if (!game.attackTargets(unit, destination).some(t => t.x === aim.x && t.y === aim.y)) {
        return miss('target', `can attack ${aim.x},${aim.y}`, 'not a target');
      }
    }
    return null;
  } finally {
    game.clearSelection();
  }
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

  // What each player can see. With fog off Commander Wars answers "everything"
  // without consulting the stored fields, so they carry nothing to compare.
  if (map.getGameRules().getFogMode() !== 0) {
    const names = ['shrouded', 'fogged', 'clear', 'mist'];
    snapshot.map.players.forEach((player, index) => {
      const theirs = player.vision;
      const ours = map.vision.gridFor(map.players[index]);
      if (!theirs || !ours || theirs.width !== map.width || theirs.height !== map.height) return;
      for (let at = 0; at < ours.length; at++) {
        if (theirs.type[at] === ours[at]) continue;
        out.push({
          kind: `vision:${names[theirs.type[at]] ?? theirs.type[at]}-seen-as-${names[ours[at]] ?? ours[at]}`,
          where: `player ${index} at ${at % map.width},${Math.floor(at / map.width)}`,
          expected: names[theirs.type[at]] ?? theirs.type[at], actual: names[ours[at]] ?? ours[at],
        });
      }
    });
  }

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

/**
 * Commander Wars writes a turn's opening snapshot as the first action of that
 * turn is submitted — after ActionPerformer::doTrapping has already run on it.
 * So when that first action is an ambush, the reveal of the ambusher's tile is
 * in the snapshot although the action has not been performed. Mirror it, or the
 * boards differ by one tile of vision that has nothing to do with the rules.
 */
function anticipateOpeningAmbush(game: Game, next: RecordedAction | undefined): void {
  if (next?.actionID !== 'ACTION_TRAP' || next.buffer.byteLength < 8) return;
  const input = new QDataStreamReader(next.buffer.buffer, next.buffer.byteOffset, next.buffer.byteLength);
  game.currentPlayer.addVisionField(input.int32(), input.int32(), 1, true);
}

/** Replays every player-turn of a record with this engine and reports where it departs. */
export function diffRecord(runtime: Runtime, record: UpstreamRecord, options: DifferentialOptions = {}): DifferentialReport {
  const report: DifferentialReport = { turns: [], exact: 0, orderDependent: 0, actions: record.actions.length, kinds: new Map() };

  // Turn 0 runs from the starting map to the first snapshot; turn k from
  // snapshot k-1 to snapshot k.
  for (let index = 0; index < record.snapshots.length; index++) {
    const from = index === 0 ? null : record.snapshots[index - 1];
    const to = record.snapshots[index];
    const game = from ? gameAt(runtime, from, options) : gameAtStart(runtime, record, options);
    // Commander Wars opens a match with ACTION_NEXT_PLAYER: the hand-over INTO
    // the first turn, which pays the first income. Constructing a Game does
    // exactly that, so the record's leading action is already accounted for.
    const firstAction = from ? from.actionCount
      : record.actions[0]?.actionID === 'ACTION_NEXT_PLAYER' ? 1 : 0;
    const turn: TurnResult = {
      index, day: game.day, player: game.currentPlayerIndex,
      firstAction, lastAction: to.actionCount - 1,
      refused: [], unoffered: [], loadDifferences: from ? compareWithSnapshot(game, from) : [], differences: [],
      orderDependent: false,
    };

    for (let i = firstAction; i < to.actionCount; i++) {
      const recorded = record.actions[i];
      if (!recorded) break;
      const missing = offered(game, recorded);
      if (missing) turn.unoffered.push({ ...missing, where: `action ${i} at ${missing.where}` });
      if (!perform(game, recorded)) turn.refused.push({ index: i, actionID: recorded.actionID });
    }
    anticipateOpeningAmbush(game, record.actions[to.actionCount]);
    turn.differences = compareWithSnapshot(game, to);

    // The turn ends by handing over, which runs the next player's start-of-turn
    // hooks in an order upstream shuffles. Before calling a difference real,
    // see whether another order produces upstream's board exactly.
    if (turn.differences.length > 0 && turn.refused.length === 0) {
      const shuffle = shuffler(0x9e3779b9 ^ index);
      for (let attempt = 0; attempt < ORDER_ATTEMPTS; attempt++) {
        const retry = from ? gameAt(runtime, from, options) : gameAtStart(runtime, record, options);
        retry.startOfTurnOrder = {
          rows: shuffle(retry.map.height), columns: shuffle(retry.map.width),
        };
        let performed = true;
        for (let i = firstAction; i < to.actionCount && performed; i++) performed = perform(retry, record.actions[i]);
        if (performed) anticipateOpeningAmbush(retry, record.actions[to.actionCount]);
        if (performed && compareWithSnapshot(retry, to).length === 0) {
          turn.differences = [];
          turn.orderDependent = true;
          report.orderDependent++;
          break;
        }
      }
    }

    if (turn.refused.length === 0 && turn.differences.length === 0 && turn.unoffered.length === 0) report.exact++;
    for (const difference of [...turn.differences, ...turn.unoffered]) {
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
    `${report.turns.length} player-turns, ${report.actions} actions: ${report.exact} turns reproduce exactly` +
      (report.orderDependent ? ` (${report.orderDependent} under another start-of-turn order)` : '') +
      `, ${report.turns.length - report.exact} differ`,
  ];
  if (report.kinds.size > 0) {
    lines.push('difference kinds: ' + [...report.kinds].sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${kind} x${n}`).join(', '));
  }
  let shown = 0;
  for (const turn of report.turns) {
    if (turn.refused.length === 0 && turn.differences.length === 0 && turn.unoffered.length === 0) continue;
    if (shown++ >= showTurns) break;
    const acts = new Set(record.actions.slice(turn.firstAction, turn.lastAction + 1).map(a => a.actionID.replace('ACTION_', '')));
    lines.push(`turn ${turn.index}: day ${turn.day} player ${turn.player}, actions ${turn.firstAction}..${turn.lastAction} (${[...acts].join(', ')})`);
    if (turn.loadDifferences.length > 0) {
      lines.push(`  already differs after loading the snapshot: ${[...new Set(turn.loadDifferences.map(d => d.kind))].join(', ')}`);
    }
    for (const refused of turn.refused.slice(0, 4)) lines.push(`  refused action ${refused.index} ${refused.actionID}`);
    for (const d of turn.unoffered.slice(0, 6)) {
      lines.push(`  not offered: ${d.where} ${d.kind}: Commander Wars ${JSON.stringify(d.expected)}, this engine ${JSON.stringify(d.actual)}`);
    }
    for (const d of turn.differences.slice(0, 8)) {
      lines.push(`  ${d.where} ${d.kind}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`);
    }
    if (turn.differences.length > 8) lines.push(`  ... ${turn.differences.length - 8} more`);
  }
  return lines.join('\n');
}
