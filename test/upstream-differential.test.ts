import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { readRecord, trimRecord } from '../src/maps/recreader.ts';
import { diffRecord, RecordedGameAction } from '../src/game/upstream.node.ts';
import { Game } from '../src/game/game.ts';
import { gridFloor, HP_PRECISION } from '../src/host/precision.ts';

const runtime = bootstrap();
const FIXTURES = path.resolve(import.meta.dirname, 'fixtures/upstream');
const fixtures = fs.readdirSync(FIXTURES).filter(name => name.endsWith('.rec.gz')).sort();
const load = (name: string) => zlib.gunzipSync(fs.readFileSync(path.join(FIXTURES, name)));

/**
 * Differences from the real Commander Wars that are understood and accepted,
 * per fixture, as `turn:kind`. Anything not listed fails the test — and so does
 * a listed entry that no longer occurs, so this cannot quietly go stale.
 */
const KNOWN: Record<string, Record<string, string>> = {
  'Agitated-fog0-ai2.rec.gz': {
    // game/gamemap.cpp: GameMap::startOfTurnPlayer walks the tiles in an order
    // drawn from the RNG. Here an APC resupplies the cannonboat beside it: when
    // upstream happened to burn the boat's daily fuel first and resupply
    // second it ended full; this engine scans in a fixed order and does the
    // reverse. Reproducing it needs Qt's random stream, not a rules change.
    '36:unit.fuel:CANNONBOAT': 'start-of-turn hook order is random upstream',
  },
};

describe('differential replay against Commander Wars', () => {
  it('has fixtures to check', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
  });

  // Each fixture is a game the real Commander Wars played, recorded with
  // tools/upstream/record.sh. Every player-turn is replayed from upstream's own
  // board and must end on upstream's next board.
  it.each(fixtures)('%s', name => {
    const record = readRecord(load(name));
    const settings = (record.info.ironAccord ?? {}) as { fog?: number };
    const report = diffRecord(runtime, record, { fog: settings.fog ?? 0 });

    expect(record.truncated).toBe(false);
    expect(report.turns.length).toBeGreaterThan(10);

    const observed = new Map<string, string>();
    for (const turn of report.turns) {
      for (const refused of turn.refused) observed.set(`${turn.index}:refused:${refused.actionID}`, `action ${refused.index}`);
      for (const d of turn.differences) {
        observed.set(`${turn.index}:${d.kind}`,
          `${d.where}: Commander Wars has ${JSON.stringify(d.expected)}, this engine ${JSON.stringify(d.actual)}`);
      }
    }
    const known = KNOWN[name] ?? {};
    const unexpected = [...observed].filter(([key]) => !(key in known)).map(([key, detail]) => `${key} (${detail})`);
    const stale = Object.keys(known).filter(key => !observed.has(key));

    expect(unexpected, 'this engine departs from the real Commander Wars; ' +
      `inspect with: node tools/upstream-diff.ts test/fixtures/upstream/${name}`).toEqual([]);
    expect(stale, 'listed as a known difference but no longer occurs — remove it from KNOWN').toEqual([]);
  });
});

describe('record reader', () => {
  const bytes = load(fixtures[0]);

  it('reads actions and one snapshot per player-turn', () => {
    const record = readRecord(bytes);
    expect(record.actions.length).toBeGreaterThan(50);
    expect(record.snapshots.length).toBeGreaterThan(10);
    expect(record.actions.map(action => action.index)).toEqual(record.actions.map((_, i) => i));
    // Snapshots are written as each turn starts, so their counts only grow.
    const counts = record.snapshots.map(snapshot => snapshot.actionCount);
    expect([...counts].sort((a, b) => a - b)).toEqual(counts);
    // The turn before each snapshot ends with the hand-over.
    for (const snapshot of record.snapshots.slice(1)) {
      expect(record.actions[snapshot.actionCount - 1].actionID).toBe('ACTION_NEXT_PLAYER');
    }
  });

  it('trims to the same game, and trimming again changes nothing', () => {
    const once = trimRecord(bytes, { ironAccord: { fog: 0 } });
    const twice = trimRecord(once, { ironAccord: { fog: 0 } });
    expect(Buffer.from(twice).equals(Buffer.from(once))).toBe(true);
    const a = readRecord(bytes);
    const b = readRecord(once);
    expect(b.actions.length).toBe(a.actions.length);
    expect(b.snapshots.length).toBe(a.snapshots.length);
    expect(b.actions.at(-1)).toEqual(a.actions.at(-1));
  });

  it('stops cleanly at a record that was cut off mid-write', () => {
    const whole = readRecord(bytes);
    const cut = readRecord(bytes.subarray(0, bytes.byteLength - 40));
    expect(cut.truncated).toBe(true);
    expect(cut.actions.length + cut.snapshots.length).toBe(whole.actions.length + whole.snapshots.length - 1);
  });

  it('hands an action script its inputs in the order it asks for them', () => {
    const map = runtime.createMap(4, 4);
    const action = new RecordedGameAction(map, 'ACTION_FIRE');
    // int32 7, QString "AB", int32 -1 — as QDataStream writes them.
    action.setRecordedBuffer(new Uint8Array([0, 0, 0, 7, 0, 0, 0, 4, 0, 65, 0, 66, 255, 255, 255, 255]));
    action.startReading();
    expect(action.readDataInt32()).toBe(7);
    expect(action.readDataString()).toBe('AB');
    expect(action.readDataInt32()).toBe(-1);
    action.startReading();
    expect(action.readDataInt32()).toBe(7);
  });
});

// Each of these was found by the differential replay; the fixtures above cover
// them end to end, and these pin the individual rule so a failure names it.
describe('rules corrected against Commander Wars', () => {
  const source = readMap(fs.readFileSync(path.join(cwRoot(), 'maps/pre_deployed/8-Bridge Isles.map')));
  const newGame = () => {
    const map = loadIntoGameMap(source, runtime.registry);
    return new Game(map, runtime.registry, runtime.animations);
  };

  it('readies a player\'s units when their turn ends, not when the next begins', () => {
    const game = newGame();
    const mine = game.map.players[0].units[0];
    mine.hasMoved = true;
    game.endTurn();
    // game/gamemap.cpp: GameMap::endOfTurn -> enableUnits. During the
    // opponent's turn nothing on the board reads as spent.
    expect(game.currentPlayerIndex).toBe(1);
    expect(mine.hasMoved).toBe(false);
    expect(game.map.units.every(unit => !unit.hasMoved)).toBe(true);
  });

  it('keeps hit points on the 0.01 grid', () => {
    // coreengine/precisiongrid.h. Residue below a cent is not life...
    expect(gridFloor(1.1102230246251565e-16, HP_PRECISION)).toBe(0);
    // ...a value that is a grid point up to rounding error stays on it...
    expect(gridFloor(8.399999999999999, HP_PRECISION)).toBe(8.4);
    expect(gridFloor(0.1 + 0.2, HP_PRECISION)).toBe(0.3);
    // ...and anything genuinely between two points goes down.
    expect(gridFloor(8.396, HP_PRECISION)).toBe(8.39);

    const unit = newGame().map.units[0];
    unit.setHp(1.1102230246251565e-16);
    expect(unit.getHp()).toBe(0);
    unit.setHp(5.678);
    expect(unit.getHp()).toBe(5.67);
    unit.setHp(99);
    expect(unit.getHp()).toBe(10);
  });

  it('gives a unit without a fuel tank fuel -1, and fills the others', () => {
    const game = newGame();
    const owner = game.map.players[0];
    // watermine.js calls setFuel(0) then setMaxFuel(0); Unit::setFuel only
    // assigns when there is a tank, so the mine keeps the -1 it was born with.
    const mine = game.map.addUnit('WATERMINE', owner, 0, 0);
    expect([mine.getFuel(), mine.getMaxFuel(), mine.getAmmo1()]).toEqual([-1, 0, 0]);
    const infantry = game.map.addUnit('INFANTRY', owner, 1, 0);
    expect([infantry.getFuel(), infantry.getAmmo1(), infantry.getAmmo2()]).toEqual([100, 10, 0]);
    infantry.setFuel(500);
    expect(infantry.getFuel()).toBe(100);
    infantry.setFuel(-3);
    expect(infantry.getFuel()).toBe(-3);
    infantry.setAmmo1(-3);
    expect(infantry.getAmmo1()).toBe(0);
  });

  it('runs a unit\'s own hook when it is built, so a submarine leaves the yard dived', () => {
    const game = newGame();
    const owner = game.map.players[0];
    const submarine = game.map.addUnit('SUBMARINE', owner, 0, 0);
    expect(submarine.hidden).toBe(false);
    owner.buildedUnit(submarine);
    expect(submarine.hidden).toBe(true);
    const infantry = game.map.addUnit('INFANTRY', owner, 1, 0);
    owner.buildedUnit(infantry);
    expect(infantry.hidden).toBe(false);
  });

  it('moves an ambushed unit onto the last free tile of a one-step route', () => {
    // GameAnimationWalk::onFinished places the unit; Unit::moveUnit does not,
    // because ActionPerformer::doTrapping leaves the starting tile off the route.
    const game = newGame();
    const unit = game.map.players[0].units.find(candidate => {
      const { x, y } = candidate;
      return game.map.onMap(x + 1, y) && !game.map.getUnitAt(x + 1, y)
        && candidate.getBaseMovementCosts(x + 1, y, x, y) > 0;
    })!;
    const from = { x: unit.x, y: unit.y };
    const action = new RecordedGameAction(game.map, 'ACTION_TRAP');
    // The trap sign: two int32 coordinates.
    action.setRecordedBuffer(new Uint8Array([0, 0, 0, from.x + 2, 0, 0, 0, from.y]));
    action.setTargetUnit(unit);
    action.setMovepath([{ x: from.x + 1, y: from.y }], 1);
    expect(game.performRecorded(action)).toBe(true);
    expect([unit.x, unit.y]).toEqual([from.x + 1, from.y]);
    expect(unit.hasMoved).toBe(true);
  });
});
