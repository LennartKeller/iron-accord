import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game, fogViewerIndex, nextObserverSeat } from '../src/game/game.ts';
import type { GameMap } from '../src/host/index.ts';

const { registry, animations } = bootstrap();
const source = readMap(fs.readFileSync(path.join(cwRoot(), 'maps/3_player/Power Balance.map')));

function newGame(): { map: GameMap; game: Game } {
  const map = loadIntoGameMap(source, registry);
  return { map, game: new Game(map, registry, animations) };
}

/**
 * Counts calls to one terrain tile's startOfTurn. The neutral sweep is what
 * spreads fires and grows plasma, and a missed sweep produces no log and no
 * throw — just a board where nothing burns any more — so the hook itself is
 * the only thing worth observing.
 */
function countNeutralSweeps(map: GameMap): { calls(): number; reset(): void } {
  const terrain = map.getTerrain(0, 0);
  let calls = 0;
  const original = terrain.startOfTurn.bind(terrain);
  terrain.startOfTurn = () => { calls += 1; original(); };
  return { calls: () => calls, reset: () => { calls = 0; } };
}

describe('turn order', () => {
  it('rolls the day over past a defeated player 0 and keeps their seat skipped', () => {
    const { map, game } = newGame();
    expect(map.players).toHaveLength(3);

    map.getPlayer(0)!.defeatPlayer(null);

    game.endTurn();                              // day 1: seat 0 hands to seat 1
    expect(game.currentPlayerIndex).toBe(1);
    game.endTurn();
    expect(game.currentPlayerIndex).toBe(2);
    expect(game.day).toBe(1);

    game.endTurn();                              // wraps past the dead seat 0
    expect(game.currentPlayerIndex).toBe(1);
    expect(game.day).toBe(2);
  });

  it('runs the neutral start-of-turn once per day even with player 0 defeated', () => {
    const { map, game } = newGame();
    const sweeps = countNeutralSweeps(map);

    map.getPlayer(0)!.defeatPlayer(null);
    sweeps.reset();

    game.endTurn();                              // day 1: seat 1
    game.endTurn();                              // day 1: seat 2
    expect(sweeps.calls()).toBe(0);              // day 1's sweep already ran at game start

    // Day 2 opens on seat 1 — the rotation never lands on index 0 again, and
    // fires and plasma must not care.
    game.endTurn();
    expect(game.day).toBe(2);
    expect(game.currentPlayerIndex).toBe(1);
    expect(sweeps.calls()).toBe(1);

    game.endTurn();                              // day 2: seat 2 — no second sweep
    expect(sweeps.calls()).toBe(1);

    game.endTurn();                              // day 3: seat 1 again
    expect(sweeps.calls()).toBe(2);
  });

  it('runs the neutral start-of-turn exactly once per day with everyone alive', () => {
    const { game, map } = newGame();
    const sweeps = countNeutralSweeps(map);
    sweeps.reset();

    game.endTurn();                              // day 1: seat 1
    game.endTurn();                              // day 1: seat 2
    expect(sweeps.calls()).toBe(0);
    game.endTurn();                              // day 2: seat 0
    expect(sweeps.calls()).toBe(1);
  });
});

describe('fog viewer seat', () => {
  const human = (...seats: number[]) => (seat: number) => seats.includes(seat);
  const nobodyDefeated = () => false;

  it('shows a human turn through that player\'s own eyes', () => {
    expect(fogViewerIndex(0, 3, human(0, 1, 2), nobodyDefeated)).toBe(0);
    expect(fogViewerIndex(2, 3, human(0, 2), nobodyDefeated)).toBe(2);
  });

  it('keeps a human\'s fog on screen while an AI seat plays', () => {
    // Watching the machine's turn through the machine's eyes would print its
    // whole intelligence picture — its own hidden units included — onto the
    // human's screen, every round.
    expect(fogViewerIndex(1, 2, human(0), nobodyDefeated)).toBe(0);
    // The next human in turn order is who is holding the device.
    expect(fogViewerIndex(1, 3, human(0, 2), nobodyDefeated)).toBe(2);
  });

  it('skips defeated humans and spectates all-AI games as the current seat', () => {
    expect(fogViewerIndex(2, 3, human(0, 1), seat => seat === 1)).toBe(0);
    expect(fogViewerIndex(1, 2, () => false, nobodyDefeated)).toBe(1);
  });
});

describe('observer view', () => {
  const alive = () => false;

  it('cycles omniscient through every living seat and back', () => {
    expect(nextObserverSeat(null, 2, alive)).toBe(0);
    expect(nextObserverSeat(0, 2, alive)).toBe(1);
    expect(nextObserverSeat(1, 2, alive)).toBe(null);
  });

  it('skips defeated seats, whose vision has stopped updating', () => {
    const defeated = (seat: number) => seat === 1;
    expect(nextObserverSeat(null, 3, defeated)).toBe(0);
    expect(nextObserverSeat(0, 3, defeated)).toBe(2);
    expect(nextObserverSeat(2, 3, defeated)).toBe(null);
  });

  it('stays omniscient when every seat is defeated', () => {
    expect(nextObserverSeat(null, 2, () => true)).toBe(null);
  });
});
