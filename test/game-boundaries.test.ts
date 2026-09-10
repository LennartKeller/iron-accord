import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { cwRoot } from '../src/cw/resources.node.ts';

const { registry, animations } = bootstrap();
const source = readMap(fs.readFileSync(path.join(cwRoot(), 'maps/2_player/60-ZWEITER KRIEG.map')));
function setup() {
  const map = loadIntoGameMap(source, registry);
  const game = new Game(map, registry, animations);
  const unit = map.addUnit('INFANTRY', game.currentPlayer, 3, 8);
  return { game, map, unit };
}

describe('game action boundaries', () => {
  it('rejects unreachable moves without spending the unit or fuel', () => {
    const { game, unit } = setup();
    const fuel = unit.fuel;
    game.select(unit.x, unit.y);
    expect(game.performAction('ACTION_WAIT', unit, { x: 15, y: 8 })).toBe(false);
    expect(game.beginAction('ACTION_WAIT', unit, { x: 15, y: 8 }).kind).toBe('invalid');
    expect([unit.x, unit.y, unit.fuel, unit.hasMoved]).toEqual([3, 8, fuel, false]);
  });

  it('charges movement fuel even when the caller has not selected a unit', () => {
    const { game, unit } = setup();
    const fuel = unit.fuel;
    expect(game.performAction('ACTION_WAIT', unit, { x: 4, y: 8 })).toBe(true);
    expect([unit.x, unit.y, unit.hasMoved]).toEqual([4, 8, true]);
    expect(unit.fuel).toBe(fuel - 1);
  });

  it('rejects enemy, spent and removed units', () => {
    const { game, map, unit } = setup();
    const enemy = map.addUnit('INFANTRY', map.getPlayer(1)!, 4, 8);
    expect(game.performAction('ACTION_WAIT', enemy, enemy.getPosition())).toBe(false);
    unit.hasMoved = true;
    expect(game.performAction('ACTION_WAIT', unit, unit.getPosition())).toBe(false);
    unit.hasMoved = false;
    map.removeUnit(unit);
    expect(game.canControl(unit)).toBe(false);
    expect(game.beginAction('ACTION_WAIT', unit, unit.getPosition()).kind).toBe('invalid');
  });

  it('rejects an out-of-range attack even when another enemy is in range', () => {
    const { game, map, unit } = setup();
    map.addUnit('INFANTRY', map.getPlayer(1)!, 4, 8);
    const distant = map.addUnit('INFANTRY', map.getPlayer(1)!, 8, 8);
    map.vision.update();
    expect(game.attack(unit, unit.getPosition(), distant.getPosition())).toBe(false);
    expect(distant.getHp()).toBe(10);
    expect(unit.hasMoved).toBe(false);
  });

  it('rejects off-board production coordinates without throwing', () => {
    const { game, map } = setup();
    for (const [x, y] of [[0, -1], [0, map.height], [NaN, 0], [0.5, 0]]) {
      expect(game.canProduceAt(x, y)).toBe(false);
      expect(game.buildUnit(x, y, 'INFANTRY')).toBe(false);
    }
  });

  it('rejects the wrong input type and off-board missile targets without consuming the step', () => {
    const { game, map, unit } = setup();
    const tiles = Array.from({ length: map.height }, (_, y) =>
      Array.from({ length: map.width }, (_, x) => map.getTerrain(x, y))).flat();
    const silo = tiles.find(t => t.getBuilding()?.getBuildingID() === 'SILO_ROCKET')!;
    unit.moveUnitToField(silo.x, silo.y);
    expect(game.beginAction('ACTION_MISSILE', unit, unit.getPosition()).kind).toBe('field');
    const count = game.pending!.action.getVariableCount();
    expect(game.provideMenu('INFANTRY').kind).toBe('invalid');
    expect(game.provideField(-1, 0).kind).toBe('invalid');
    expect(game.pending!.action.getVariableCount()).toBe(count);
    expect(game.provideField(10, 7).kind).toBe('done');
    expect(unit.hasMoved).toBe(true);
  });

  it('uses menu prices supplied by the script and rejects unknown choices', () => {
    const { game, unit } = setup();
    // A menu fixture exercises the same generic driver used by support actions.
    const id = 'ACTION_DEBUG_MENU';
    const original = unit.getActionList.bind(unit);
    unit.getActionList = () => [...original(), id];
    let charged = 0;
    registry[id] = {
      canBePerformed: () => true,
      isFinalStep: (action: { getInputStep(): number }) => action.getInputStep() === 1,
      getStepInputType: () => 'MENU',
      getStepData: (_action: unknown, data: { addData(...args: unknown[]): void }) => data.addData('Choice', 'choice', '', 500, true),
      perform: (action: { getCosts(): number }) => { charged = action.getCosts(); },
    };
    try {
      expect(game.beginAction(id, unit, unit.getPosition()).kind).toBe('menu');
      expect(game.provideMenu('unknown').kind).toBe('invalid');
      expect(game.provideMenu('choice', -999).kind).toBe('done');
      expect(charged).toBe(500);
    } finally { delete registry[id]; }
  });
});

it('rolls back a provisional unload before handing the turn to another player', () => {
  const { game, map, unit } = setup();
  const transport = map.addUnit('APC', game.currentPlayer, 4, 8);
  transport.loadUnit(unit);
  const fuel = transport.fuel;
  expect(game.moveForUnload(transport, 4, 7)).toBe(true);
  expect(game.moveForUnload(transport, 4, 6)).toBe(false);
  game.endTurn();
  expect([transport.x, transport.y, transport.fuel]).toEqual([4, 8, fuel]);
  expect(game.cancelUnloadMove()).toBe(false);
});

it('spends a transport when unloading through the engine API', () => {
  const { game, map, unit } = setup();
  const transport = map.addUnit('APC', game.currentPlayer, 4, 8);
  transport.loadUnit(unit);
  expect(game.unloadUnit(transport, 0, 3, 8)).toBe(true);
  expect(transport.hasMoved).toBe(true);
  expect(unit.hasMoved).toBe(true);
  expect(game.moveForUnload(transport, 4, 7)).toBe(false);
});
