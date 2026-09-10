import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { snapshot } from '../src/game/snapshot.ts';
import { GameEnums } from '../src/host/index.ts';
import { GameEnvironment } from '../src/ai/environment.ts';
import { NormalAi } from '../src/ai/cw/normalai.ts';
import type { MoveUnitData } from '../src/ai/cw/unitdata.ts';
import type { InfluenceFrontMap } from '../src/ai/cw/influencefrontmap.ts';
import { BuildingHost } from '../src/host/building.ts';
import { CoreAI } from '../src/ai/cw/coreai.ts';
import { NORMAL_AI_DEFAULTS } from '../src/ai/cw/config.ts';
import { computeMovementRange } from '../src/game/pathfinding.ts';
import { getAttackTargets, getAttackTargetsFast, getBestTarget } from '../src/ai/cw/targets.ts';

const { registry, createMap, animations, rng } = bootstrap();
interface Cache {
  enemyUnits: MoveUnitData[];
  influence: InfluenceFrontMap;
}

function battlefield(enemyX: number, fog: number, statusHidden = false) {
  const map = createMap(21, 9);
  const player = map.addPlayer('os');
  const foe = map.addPlayer('bm');
  foe.team = 1;
  const actor = map.addUnit('INFANTRY', player, 10, 4);
  const enemy = map.addUnit('LIGHT_TANK', foe, enemyX, 4);
  enemy.setHidden(statusHidden);
  map.rules.fogMode = fog;
  const game = new Game(map, registry, animations);
  rng.reseed(3);
  const env = new GameEnvironment(map, registry, { rng }, game);
  const ai = new NormalAi({ seed: 7 });
  ai.beginTurn(env);
  const cache = ai as unknown as Cache;
  const visibleBoard = () => ({
    vision: [...map.vision.gridFor(player)!],
    units: map.units.filter(unit => !unit.isStealthed(player))
      .map(unit => ({ id: unit.getUnitID(), owner: unit.getOwner().getPlayerID(), x: unit.x, y: unit.y, hp: unit.hp })),
  });
  return { map, game, player, actor, enemy, env, ai, cache, visibleBoard };
}

describe('NormalAi visible-information boundary', () => {
  it.each([
    { name: 'fog of war', fog: GameEnums.Fog_OfWar, hidden: false },
    { name: 'shroud', fog: GameEnums.Fog_OfShroud, hidden: false },
    { name: 'status stealth with fog off', fog: GameEnums.Fog_Off, hidden: true },
  ])('makes the same decision when only a hidden tank moves under $name', async ({ fog, hidden }) => {
    const left = battlefield(2, fog, hidden);
    expect(left.enemy.isStealthed(left.player)).toBe(true);
    const visible = left.visibleBoard();
    const beforeLeft = snapshot(left.game);
    const randomBeforeLeft = rng.getState();
    const leftAction = await left.ai.selectAction(left.env);
    expect(snapshot(left.game)).toEqual(beforeLeft);
    expect(rng.getState()).toBe(randomBeforeLeft);
    expect(left.cache.enemyUnits).toEqual([]);
    expect(left.cache.influence.getInfluenceInfo(left.actor.x, left.actor.y).getEnemyInfluence()).toBe(0);

    const right = battlefield(18, fog, hidden);
    expect(right.enemy.isStealthed(right.player)).toBe(true);
    expect(right.visibleBoard()).toEqual(visible);
    const beforeRight = snapshot(right.game);
    const randomBeforeRight = rng.getState();
    const rightAction = await right.ai.selectAction(right.env);
    expect(snapshot(right.game)).toEqual(beforeRight);
    expect(rng.getState()).toBe(randomBeforeRight);
    expect(right.cache.enemyUnits).toEqual([]);
    expect(rightAction).toEqual(leftAction);
    // Baseline selected WAIT(9,3) versus WAIT(11,3), despite identical visible boards.
  });

  it('reacquires a revealed enemy instead of permanently excluding its UID', async () => {
    const { game, player, enemy, env, ai, cache } = battlefield(2, GameEnums.Fog_OfWar);
    await ai.selectAction(env);
    expect(cache.enemyUnits).toEqual([]);
    player.addVisionField(enemy.x, enemy.y, 1, true);
    expect(enemy.isStealthed(player)).toBe(false);
    // Begin another decision pass on the now-revealed board.
    ai.beginTurn(env);
    const revealed = snapshot(game);
    await ai.selectAction(env);
    expect(cache.enemyUnits.map(data => data.unit.uid)).toContain(enemy.uid);
    expect(cache.enemyUnits.find(data => data.unit === enemy)?.range).not.toBeNull();
    expect(cache.influence.getInfluenceInfo(enemy.x, enemy.y).getEnemyInfluence()).toBeGreaterThan(0);
    expect(snapshot(game)).toEqual(revealed);
  });

  it('makes the same decision when only a shrouded factory changes position', async () => {
    const run = async (factoryX: number) => {
      const state = battlefield(0, GameEnums.Fog_OfShroud);
      const factory = new BuildingHost(state.map, 'FACTORY', state.enemy.getOwner());
      factory.setTerrain(state.map.getTerrain(factoryX, 4));
      state.map.getTerrain(factoryX, 4).building = factory;
      factory.init();
      state.map.vision.update();
      expect(state.player.getFieldVisibleType(factoryX, 4)).toBe(GameEnums.VisionType_Shrouded);
      const visible = state.visibleBoard();
      const before = snapshot(state.game);
      const action = await state.ai.selectAction(state.env);
      expect(snapshot(state.game)).toEqual(before);
      expect(state.cache.influence.getInfluenceInfo(10, 4).getEnemyInfluence()).toBe(0);
      return { visible, action };
    };
    // Baseline chased the hidden factory: WAIT(7,4) versus WAIT(13,4).
    expect(await run(2)).toEqual(await run(18));
  });

  it('keeps firing candidates and fast support estimates unchanged by a hidden occupant', () => {
    const run = (hiddenX: number, hiddenY: number) => {
      const map = createMap(12, 7);
      const player = map.addPlayer('os');
      const enemy = map.addPlayer('bm');
      enemy.team = 1;
      const actor = map.addUnit('INFANTRY', player, 2, 3);
      const target = map.addUnit('LIGHT_TANK', enemy, 5, 3);
      const hidden = map.addUnit('INFANTRY', enemy, hiddenX, hiddenY);
      hidden.setHidden(true);
      const game = new Game(map, registry, animations);
      expect(target.isStealthed(player)).toBe(false);
      expect(hidden.isStealthed(player)).toBe(true);
      const core = new CoreAI(game, player, { ...NORMAL_AI_DEFAULTS });
      const range = computeMovementRange(map, actor);
      const options = { ...NORMAL_AI_DEFAULTS, enableNeutralTerrainAttack: true };
      const before = snapshot(game);
      const attacks = getAttackTargets(game, core.predictor, actor, range, options);
      const best = getBestTarget(game, core.predictor, actor, range, options);
      const fast = getAttackTargetsFast(game, core.predictor, actor, range, options.ownUnitValue, 1, 1);
      // (4,3) is the only firing tile reachable this turn next to the visible tank.
      expect(attacks.moveTargetFields).toContainEqual({ x: 4, y: 3, z: 1 });
      expect(fast.some(candidate => candidate.x === hiddenX && candidate.y === hiddenY)).toBe(false);
      expect(snapshot(game)).toEqual(before);
      return { attacks, best, fast };
    };
    expect(run(4, 3)).toEqual(run(10, 0));
  });
});
