import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { snapshot } from '../src/game/snapshot.ts';
import { defaultReward, GameEnvironment } from '../src/ai/environment.ts';

const { createMap, registry, animations } = bootstrap();

function scenario() {
  const map = createMap(5, 3, 'PLAINS');
  for (let i = 0; i < 3; i++) {
    const player = map.addPlayer('os');
    player.team = i === 2 ? 1 : 0;
    map.addUnit('INFANTRY', player, i * 2, 1);
  }
  return new Game(map, registry, animations);
}

describe('game environment', () => {
  it('penalizes allied damage and rewards enemy damage', () => {
    const game = scenario();
    const before = snapshot(game);
    game.map.getPlayer(1)!.units[0].setHp(5);
    expect(defaultReward(before, snapshot(game), 0)).toBeCloseTo(-0.05);
    game.map.getPlayer(1)!.units[0].setHp(10);
    game.map.getPlayer(2)!.units[0].setHp(5);
    expect(defaultReward(before, snapshot(game), 0)).toBeCloseTo(0.05);
  });

  it('offers no actions and preserves the board after the day limit', () => {
    const game = scenario();
    const env = new GameEnvironment(game.map, registry, { maxDays: 1 }, game);
    game.day = 2;
    const before = snapshot(game);
    expect(env.done).toBe(true);
    expect(env.legalActions()).toEqual([]);
    const result = env.step({ kind: 'endTurn' });
    expect(result.done).toBe(true);
    expect(result.info.accepted).toBe(false);
    expect(snapshot(game)).toEqual(before);
  });
});
