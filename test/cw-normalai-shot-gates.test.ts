import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { snapshot } from '../src/game/snapshot.ts';
import { GameEnvironment } from '../src/ai/environment.ts';
import { applyAction, type ActionDescriptor } from '../src/ai/actions.ts';
import { NormalAi, type NormalAiOptions } from '../src/ai/cw/normalai.ts';
import { createUnitData, type MoveUnitData } from '../src/ai/cw/unitdata.ts';
import type { CoreAI } from '../src/ai/cw/coreai.ts';
import { getBestAttacksFromField, type TargetScoringOptions } from '../src/ai/cw/targets.ts';

const { registry, createMap, animations, rng } = bootstrap();
interface ShotInternals {
  core: CoreAI;
  targetOptions(): TargetScoringOptions;
  bestShotFrom(game: Game, unit: MoveUnitData, from: { x: number; y: number }): ActionDescriptor | null;
}

function battle(enemyX: number, config: NormalAiOptions['config'] = {}) {
  const map = createMap(7, 5);
  const player = map.addPlayer('os');
  const enemy = map.addPlayer('bm');
  enemy.team = 1;
  const actor = map.addUnit('INFANTRY', player, 2, 2);
  actor.hp = 2;
  map.addUnit('LIGHT_TANK', enemy, enemyX, 2);
  const game = new Game(map, registry, animations);
  const ai = new NormalAi({ config: { minSuicideDamage: 0, minHpDamage: -10, ...config } });
  ai.beginTurn(new GameEnvironment(map, registry, { rng }, game));
  const shots = ai as unknown as ShotInternals;
  const data = createUnitData(actor, false, 1, [], 0, true);
  return { actor, game, shots, data };
}

describe('NormalAi follow-up shot health gates', () => {
  it('declines a moving shot at the low-HP threshold even when the target is legal', () => {
    const { actor, game, shots, data } = battle(4);
    const from = { x: 3, y: 2 };
    expect(game.attackTargets(actor, from)).toHaveLength(1);
    const before = snapshot(game);
    expect(shots.bestShotFrom(game, data, from)).toBeNull();
    expect(snapshot(game)).toEqual(before);
  });

  it('allows a stationary locked unit to fire below the normal funds floor', () => {
    const { actor, game, shots, data } = battle(3);
    const best = getBestAttacksFromField(game, shots.core.predictor, actor, actor, shots.targetOptions());
    expect(best.targets[0].z).toBeLessThan(0);
    const action = shots.bestShotFrom(game, data, actor);
    expect(action).toMatchObject({ kind: 'unit', actionId: 'ACTION_FIRE', target: { x: 3, y: 2 } });
    expect(applyAction(game, action!)).toBe(true);
  });

  it('retains the funds floor when the unit does not qualify as locked', () => {
    const { actor, game, shots, data } = battle(3, { lockedUnitHp: 0, noMoveAttackHp: 0 });
    expect(shots.bestShotFrom(game, data, actor)).toBeNull();
  });
});
