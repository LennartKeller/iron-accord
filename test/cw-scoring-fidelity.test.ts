import { describe, expect, it, vi } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { snapshot } from '../src/game/snapshot.ts';
import { computeMovementRange } from '../src/game/pathfinding.ts';
import { CoreAI } from '../src/ai/cw/coreai.ts';
import { NORMAL_AI_DEFAULTS } from '../src/ai/cw/config.ts';
import { InfluenceFrontMap } from '../src/ai/cw/influencefrontmap.ts';
import { createUnitData } from '../src/ai/cw/unitdata.ts';
import { getAttackTargetsFast, getBestAttacksFromField } from '../src/ai/cw/targets.ts';
import { calculateCounterDamage, getMapInfluenceModifier, getBestAttackTarget, getOwnSupportDamage, type ScoringContext } from '../src/ai/cw/scoring.ts';

const { registry, createMap, animations } = bootstrap();

function battlefield() {
  const map = createMap(7, 7);
  const player = map.addPlayer('os');
  const enemy = map.addPlayer('bm');
  enemy.team = 1;
  const game = new Game(map, registry, animations);
  const config = { ...NORMAL_AI_DEFAULTS, influenceMultiplier: 0 };
  const ai = new CoreAI(game, player, config);
  const context: ScoringContext = {
    ai, ownUnits: [], enemyUnits: [], influence: new InfluenceFrontMap(map, ai.islandMaps),
    targetOptions: { ...config, enableNeutralTerrainAttack: true },
  };
  return { map, game, player, enemy, context, ai };
}

describe('Commander Wars attack scoring', () => {
  it('keeps the threat premium finite when a destination has no friendly influence', () => {
    const { map, player, context, ai } = battlefield();
    const actor = map.addUnit('LIGHT_TANK', player, 0, 0);
    const info = context.influence.getInfluenceInfo(3, 3);
    vi.spyOn(info, 'getEnemyInfluence').mockReturnValue(7000);
    vi.spyOn(info, 'getOwnInfluence').mockReturnValue(0);
    ai.config.influenceMultiplier = 0.8;
    expect(getMapInfluenceModifier(context, actor, 3, 3)).toBe(actor.getCoUnitValue() * 0.8);
    ai.config.influenceMultiplier = 0;
    expect(getMapInfluenceModifier(context, actor, 3, 3)).toBe(0);
  });

  it('uses the fast counter approximation and net HP for supporting infantry', () => {
    const { map, game, player, enemy, context, ai } = battlefield();
    const actor = map.addUnit('INFANTRY', player, 2, 3);
    const friend = map.addUnit('INFANTRY', player, 2, 2);
    const defender = map.addUnit('INFANTRY', enemy, 3, 3);
    context.ownUnits = [actor, friend].map(unit => createUnitData(unit, false, 2, [], 0, true));
    const before = snapshot(game);
    const fast = ai.predictor.calcUnitDamageFast(friend, defender);
    expect(fast.x).toBe(55);
    expect(fast.width).toBe(55);
    const targets = getAttackTargetsFast(game, ai.predictor, friend, context.ownUnits[1].range!, 1, 1, 1);
    expect(targets.filter(target => target.x === defender.x && target.y === defender.y))
      .toEqual(expect.arrayContaining([expect.objectContaining({ fundsDamage: 0, hpDamage: 0, hpDamageDifference: 0 })]));
    // The full battle forecast would credit 232.8 funds and 4.32 HP of support.
    expect(getOwnSupportDamage(context, actor, actor, defender)).toEqual({ supportDamage: 0, hpDamage: 0 });
    expect(snapshot(game)).toEqual(before);
  });

  it('includes allied occupied tiles in support alternatives without offering them as real attacks', () => {
    const { map, game, player, enemy, ai, context } = battlefield();
    const actor = map.addUnit('INFANTRY', player, 2, 2);
    map.addUnit('INFANTRY', player, 2, 3);
    map.addUnit('INFANTRY', enemy, 3, 2);
    const targets = getAttackTargetsFast(game, ai.predictor, actor, computeMovementRange(map, actor), 1, 1, 1, 0);
    expect(targets.map(target => [target.x, target.y])).toContainEqual([2, 3]);
    expect(getBestAttacksFromField(game, ai.predictor, actor, actor, context.targetOptions).targets)
      .not.toContainEqual(expect.objectContaining({ x: 2, y: 3 }));
  });

  it('uses whole-fund ties before the defender-terrain tie break', () => {
    const { map, player, context } = battlefield();
    const actor = map.addUnit('INFANTRY', player, 0, 0);
    map.setTerrainID(1, 0, 'FOREST');
    const data = createUnitData(actor, false, 1, [], 0, true);
    const chosen = getBestAttackTarget(context, data, [
      { x: 1, y: 0, fundsDamage: 100.1, hpDamage: 1, hpDamageDifference: 0 },
      { x: 2, y: 0, fundsDamage: 100.9, hpDamage: 1, hpDamageDifference: 0 },
    ], [{ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 1 }], [], []);
    expect(chosen).toBe(0);
  });

  it('truncates normalized cached damage before applying it to a second same-type attacker', () => {
    const { map, player, enemy, context, ai } = battlefield();
    const defender = map.addUnit('INFANTRY', player, 3, 3);
    const first = map.addUnit('INFANTRY', enemy, 2, 3);
    first.hp = 7.5;
    const second = map.addUnit('INFANTRY', enemy, 4, 3);
    context.enemyUnits = [first, second].map(unit => createUnitData(unit, true, 1, [], 0, true));
    const predict = vi.spyOn(ai.predictor, 'calcVirtualUnitDamage')
      .mockReturnValue({ x: 55.125, y: 0, width: -1, height: 0 });
    try {
      const damage = calculateCounterDamage(context, createUnitData(defender, false, 1, [], 0, true),
        defender, null, 0, [], [], true);
      // First attacker: floor(551.25). Cached base: floor(55.125*10/7.5)=73.
      // The full-health second attacker contributes 730, not 735.
      expect(damage).toBe(1281);
      expect(predict).toHaveBeenCalledTimes(1);
    } finally { predict.mockRestore(); }
  });

  it('applies the HP-trade floor to a shot from a specific tile', () => {
    const { map, game, player, enemy, ai, context } = battlefield();
    const actor = map.addUnit('INFANTRY', player, 2, 2);
    map.addUnit('LIGHT_TANK', enemy, 3, 2);
    const allowed = getBestAttacksFromField(game, ai.predictor, actor, actor,
      { ...context.targetOptions, minHpDamage: -10 });
    expect(allowed.targets).toHaveLength(1);
    expect(getBestAttacksFromField(game, ai.predictor, actor, actor,
      { ...context.targetOptions, minHpDamage: 0 }).targets).toEqual([]);
  });
});
