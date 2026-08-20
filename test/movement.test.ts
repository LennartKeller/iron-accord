import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { computeMovementRange, stoppableTiles, pathTo, key } from '../src/game/pathfinding.ts';
import { Game } from '../src/game/game.ts';
import type { GameMap } from '../src/host/index.ts';

const { registry } = bootstrap();
const mapFile = path.join(cwRoot(), 'maps/2_player/60-ZWEITER KRIEG.map');
const source = readMap(fs.readFileSync(mapFile));

function freshMap(): GameMap {
  return loadIntoGameMap(source, registry);
}

describe('movement rules', () => {
  let map: GameMap;
  beforeEach(() => { map = freshMap(); });

  it('gives each player their own team so opponents are enemies', () => {
    // The file stores team 0 for both; Commander Wars assigns team = index at
    // game start (gamemap.cpp:2996) and so do we.
    expect(map.getPlayer(0)!.team).toBe(0);
    expect(map.getPlayer(1)!.team).toBe(1);
    expect(map.getPlayer(0)!.isEnemy(map.getPlayer(1)!)).toBe(true);
  });

  it('takes movement points from the unit script, capped by fuel', () => {
    const os = map.getPlayer(0)!;
    const infantry = map.addUnit('INFANTRY', os, 3, 8);
    expect(infantry.getMovementType()).toBe('MOVE_FEET');
    expect(infantry.getMovementpoints()).toBe(3);

    infantry.fuel = 2;
    expect(infantry.getMovementpoints()).toBe(2);
  });

  it('costs come from the movement table script', () => {
    const os = map.getPlayer(0)!;
    const infantry = map.addUnit('INFANTRY', os, 3, 8);
    expect(infantry.getMovementCosts(3, 7, 3, 8)).toBe(1);

    // A tank cannot cross a mountain; infantry can, at a higher cost.
    const tank = map.addUnit('LIGHT_TANK', os, 3, 8);
    const mountain = findTerrain(map, 'MOUNTAIN');
    expect(mountain).not.toBeNull();
    expect(tank.getMovementCosts(mountain!.x, mountain!.y, mountain!.x, mountain!.y)).toBeLessThan(0);
    expect(infantry.getMovementCosts(mountain!.x, mountain!.y, mountain!.x, mountain!.y)).toBe(2);
  });

  it('range grows with movement points', () => {
    const os = map.getPlayer(0)!;
    const sizes = ['MECH', 'INFANTRY', 'LIGHT_TANK'].map(id => {
      const unit = map.addUnit(id, os, 3, 8);
      const size = computeMovementRange(map, unit).tiles.size;
      map.removeUnit(unit);
      return size;
    });
    expect(sizes[0]).toBeLessThan(sizes[1]);
    expect(sizes[1]).toBeLessThan(sizes[2]);
  });

  it('blocks movement through enemies but not allies', () => {
    const os = map.getPlayer(0)!;
    const bm = map.getPlayer(1)!;
    const infantry = map.addUnit('INFANTRY', os, 3, 8);
    const open = computeMovementRange(map, infantry).tiles.size;

    const enemy = map.addUnit('INFANTRY', bm, 4, 8);
    const blocked = computeMovementRange(map, infantry);
    expect(blocked.tiles.has(key(4, 8))).toBe(false);
    expect(blocked.tiles.size).toBeLessThan(open);
    map.removeUnit(enemy);

    map.addUnit('INFANTRY', os, 4, 8);
    const withAlly = computeMovementRange(map, infantry);
    // Passable, but the unit may not finish its move on top of a friend.
    expect(withAlly.tiles.has(key(4, 8))).toBe(true);
    expect(withAlly.tiles.get(key(4, 8))!.canStop).toBe(false);
    expect(withAlly.tiles.has(key(5, 8))).toBe(true);
    expect(stoppableTiles(withAlly).some(t => t.x === 4 && t.y === 8)).toBe(false);
  });

  it('builds a contiguous path within budget', () => {
    const os = map.getPlayer(0)!;
    const infantry = map.addUnit('INFANTRY', os, 3, 8);
    const range = computeMovementRange(map, infantry);
    const target = stoppableTiles(range).sort((a, b) => b.cost - a.cost)[0];
    const route = pathTo(range, target.x, target.y);

    expect(route[0]).toMatchObject({ x: 3, y: 8, cost: 0 });
    expect(route.at(-1)).toMatchObject({ x: target.x, y: target.y });
    expect(target.cost).toBeLessThanOrEqual(infantry.getMovementpoints());
    for (let i = 1; i < route.length; i++) {
      const step = Math.abs(route[i].x - route[i - 1].x) + Math.abs(route[i].y - route[i - 1].y);
      expect(step).toBe(1);
    }
  });
});

function findTerrain(map: GameMap, id: string): { x: number; y: number } | null {
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (map.getTerrain(x, y).getTerrainID() === id) return { x, y };
    }
  }
  return null;
}

describe('turn structure', () => {
  let map: GameMap;
  let game: Game;

  beforeEach(() => {
    map = freshMap();
    game = new Game(map, registry);
    map.addUnit('INFANTRY', map.getPlayer(0)!, 3, 8);
    map.addUnit('INFANTRY', map.getPlayer(1)!, 15, 8);
    // The units above were added after beginTurn, so refresh them by hand.
    for (const unit of map.units) unit.hasMoved = false;
  });

  it('only lets the current player move their own unmoved units', () => {
    expect(game.select(3, 8)).not.toBeNull();
    expect(game.select(15, 8)).toBeNull();   // enemy unit
    expect(game.select(0, 0)).toBeNull();    // empty tile
  });

  it('moves a unit, spends fuel and marks it done', () => {
    const unit = game.unitAt(3, 8)!;
    const fuelBefore = unit.fuel;
    game.select(3, 8);

    const result = game.moveSelected(3, 6);
    expect(result.moved).toBe(true);
    expect(result.cost).toBe(2);
    expect(unit.x).toBe(3);
    expect(unit.y).toBe(6);
    expect(unit.fuel).toBe(fuelBefore - 2);
    expect(unit.hasMoved).toBe(true);
    expect(game.unitAt(3, 8)).toBeNull();
    expect(game.select(3, 6)).toBeNull();    // already moved this turn
  });

  it('refuses unreachable and occupied destinations', () => {
    map.addUnit('INFANTRY', map.getPlayer(0)!, 4, 8);
    game.select(3, 8);
    expect(game.moveSelected(3, 0).reason).toBe('unreachable');
    expect(game.moveSelected(4, 8).reason).toBe('occupied');
    expect(game.unitAt(3, 8)).not.toBeNull();
  });

  it('advances players, rolls the day over and refreshes units', () => {
    game.select(3, 8);
    game.moveSelected(3, 6);
    expect(game.pendingUnits()).toHaveLength(0);

    game.endTurn();
    expect(game.currentPlayerIndex).toBe(1);
    expect(game.day).toBe(1);

    game.endTurn();
    expect(game.currentPlayerIndex).toBe(0);
    expect(game.day).toBe(2);
    expect(game.pendingUnits()).toHaveLength(1);  // moved unit is available again
  });

  it('pays building income at the start of a turn', () => {
    const player = map.getPlayer(0)!;
    const income = game.calcIncome(player);
    expect(income).toBeGreaterThan(0);

    const before = player.funds;
    game.endTurn();  // to P2
    game.endTurn();  // back to P1
    expect(player.funds).toBe(before + income);
  });
});
