import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import type { Unit } from '../src/host/unit.ts';
import { captureFeedback } from '../src/ui/action-feedback.ts';
import type { LiveUnit } from '../src/render/renderer.ts';

const { createMap, registry, animations, rng } = bootstrap();

function visible(unit: Unit): LiveUnit {
  return { uid: unit.uid, x: unit.x, y: unit.y, owner: unit.getOwner().getPlayerID(), id: unit.getUnitID(), hasMoved: unit.hasMoved, sprites: [] };
}

function setup() {
  const map = createMap(6, 1, 'PLAINS');
  const player = map.addPlayer('os');
  const enemy = map.addPlayer('bm');
  player.team = 0;
  enemy.team = 1;
  const game = new Game(map, registry, animations);
  const mover = map.addUnit('INFANTRY', player, 0, 0);
  return { map, player, enemy, game, mover };
}

describe('action feedback from resolved game actions', () => {
  it('reconstructs the travelled route while retaining the original sprite position', () => {
    const { game, mover } = setup();
    const sprite = visible(mover);
    const finish = captureFeedback(game, [sprite], mover, { x: 3, y: 0 });
    expect(game.performAction('ACTION_WAIT', mover, { x: 3, y: 0 })).toBe(true);
    expect(finish()).toEqual({
      movement: { uid: mover.uid, unit: sprite, path: [0, 1, 2, 3].map(x => ({ x, y: 0 })) },
      effects: [],
    });
    expect(sprite.x).toBe(0);
    expect(mover.x).toBe(3);
  });

  it('truncates an ambushed route before the hidden blocker and places TRAP at the stop', () => {
    const { game, mover, map, enemy } = setup();
    const blocker = map.addUnit('INFANTRY', enemy, 2, 0);
    blocker.setHidden(true);
    map.vision.update();
    const finish = captureFeedback(game, [visible(mover)], mover, { x: 3, y: 0 });
    expect(game.performAction('ACTION_WAIT', mover, { x: 3, y: 0 })).toBe(true);
    const feedback = finish();
    expect(feedback.movement?.path).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
    expect(feedback.effects).toEqual([{ x: 1, y: 0, text: 'TRAP!', color: '#ffc857' }]);
  });

  it('reports visible damage without exposing damage to an unseen unit', () => {
    const { game, mover, map, enemy } = setup();
    const unseen = map.addUnit('INFANTRY', enemy, 5, 0);
    const finish = captureFeedback(game, [visible(mover)], null, null);
    mover.setHp(7.5);
    unseen.setHp(3);
    expect(finish().effects).toEqual([{ x: 0, y: 0, text: '−2.5 HP', color: '#ff8a80' }]);
  });

  it('does not animate unseen movers or modify rules while capturing and sampling feedback', () => {
    const { game, mover } = setup();
    const before = { fuel: mover.fuel, hp: mover.getHp(), moved: mover.hasMoved, rng: rng.getState(), x: mover.x, y: mover.y };
    const visibleFinish = captureFeedback(game, [visible(mover)], mover, { x: 3, y: 0 });
    expect(visibleFinish()).toEqual({ movement: undefined, effects: [] });
    const finish = captureFeedback(game, [], mover, { x: 3, y: 0 });
    expect(finish()).toEqual({ movement: undefined, effects: [] });
    expect({ fuel: mover.fuel, hp: mover.getHp(), moved: mover.hasMoved, rng: rng.getState(), x: mover.x, y: mover.y }).toEqual(before);
    expect(game.performAction('ACTION_WAIT', mover, { x: 3, y: 0 })).toBe(true);
    expect(finish()).toEqual({ movement: undefined, effects: [] });
  });
});
