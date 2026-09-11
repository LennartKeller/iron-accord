import { describe, expect, it, vi } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { snapshot } from '../src/game/snapshot.ts';
import { BuildingHost, GameEnums } from '../src/host/index.ts';
import { GameEnvironment } from '../src/ai/environment.ts';
import { applyAction } from '../src/ai/actions.ts';
import { CoordinatedAi } from '../src/ai/coordinated.ts';
import { planOffensive } from '../src/ai/coordinated-planner.ts';
import { DamagePredictor } from '../src/ai/cw/damage.ts';

const { registry, createMap, animations, rng } = bootstrap();

function battlefield() {
  const map = createMap(12, 7, 'PLAINS');
  const player = map.addPlayer('os'), enemy = map.addPlayer('bm');
  enemy.team = 1;
  const first = map.addUnit('ARTILLERY', player, 1, 3);
  const second = map.addUnit('ARTILLERY', player, 2, 2);
  const target = map.addUnit('LIGHT_TANK', enemy, 4, 3);
  map.addUnit('INFANTRY', enemy, 11, 6);
  const game = new Game(map, registry, animations);
  rng.reseed(3);
  const env = new GameEnvironment(map, registry, { rng }, game);
  return { map, player, enemy, first, second, target, game, env };
}

describe('experimental coordinated offensives', () => {
  it('plans and executes distinct attacks that jointly destroy the objective without mutating during search', () => {
    const { map, game, target } = battlefield();
    const before = snapshot(game), randomBefore = rng.getState();
    const plan = planOffensive(game);
    expect(snapshot(game)).toEqual(before);
    expect(rng.getState()).toBe(randomBefore);
    expect(plan).not.toBeNull();
    expect(plan!.targetUid).toBe(target.uid);
    expect(plan!.actions).toHaveLength(2);
    expect(plan!.score).toBeGreaterThan(0);
    expect(plan!.evaluatedSequences).toBeGreaterThan(0);
    expect(new Set(plan!.actions.map(action => action.kind === 'unit' && action.uid)).size).toBe(2);
    expect(applyAction(game, plan!.actions[0])).toBe(true);
    expect(map.getUnitByUid(target.uid)).not.toBeNull();
    expect(applyAction(game, plan!.actions[1])).toBe(true);
    expect(map.getUnitByUid(target.uid)).toBeNull();
  });

  it.each(['spent', 'empty ammunition'] as const)('does not promise support from a unit with %s', restriction => {
    const { game, second } = battlefield();
    if (restriction === 'spent') second.setHasMoved(true);
    else { second.setAmmo1(0); second.setAmmo2(0); }
    expect(planOffensive(game)).toBeNull();
  });

  it('does not count two shooters competing for the same firing tile', () => {
    const map = createMap(7, 1, 'PLAINS');
    const player = map.addPlayer('os'), enemy = map.addPlayer('bm'); enemy.team = 1;
    map.addUnit('INFANTRY', player, 0, 0);
    map.addUnit('INFANTRY', player, 1, 0);
    map.addUnit('INFANTRY', enemy, 4, 0);
    const game = new Game(map, registry, animations);
    expect(planOffensive(game)).toBeNull();
  });

  it('excludes a cancelled target from a fresh offensive', () => {
    const { game, target } = battlefield();
    expect(planOffensive(game, { excludedTargets: new Set([target.uid]) })).toBeNull();
  });

  it('does not spend a second unit when one equally safe shot already wins', () => {
    const { game, target } = battlefield();
    target.setHp(5);
    expect(planOffensive(game)).toBeNull();
    expect(planOffensive(game, { targetUid: target.uid, minParticipants: 1 })?.actions).toHaveLength(1);
  });

  it('orders the group so its forecast follow-up remains worth executing', () => {
    const { game, first, second, target } = battlefield();
    // A strong free shot followed by a costly small shot has a positive total,
    // but leaves a finisher costing 1200G against only 700G of remaining HP.
    // Taking the costly shot first leaves a worthwhile free finisher instead.
    const forecast = vi.spyOn(DamagePredictor.prototype, 'calcVirtualUnitDamage')
      .mockImplementation(attacker => ({ x: attacker === first ? 90 : 20,
        y: 0, width: attacker === second ? 20 : 0, height: 0 }));
    try {
      const plan = planOffensive(game);
      expect(plan?.actions[0]).toMatchObject({ uid: second.uid });
      expect(plan?.actions[1]).toMatchObject({ uid: first.uid });
      target.setHp(8); second.setHasMoved(true);
      expect(planOffensive(game, { targetUid: target.uid, minParticipants: 1 })?.actions[0])
        .toMatchObject({ uid: first.uid });
    } finally { forecast.mockRestore(); }
  });

  it('prices retaliation from other visible enemies before committing the group', () => {
    const { game, map, enemy, target } = battlefield();
    map.addUnit('ROCKETTHROWER', enemy, 0, 0);
    expect(planOffensive(game, { targetUid: target.uid })).toBeNull();
  });

  it('leaves a capturing participant to the ordinary capture order', async () => {
    const map = createMap(7, 5, 'PLAINS');
    const player = map.addPlayer('os'), enemy = map.addPlayer('bm'); enemy.team = 1;
    const actor = map.addUnit('INFANTRY', player, 1, 1);
    map.addUnit('INFANTRY', player, 2, 2);
    map.addUnit('INFANTRY', enemy, 3, 1).setHp(7);
    const game = new Game(map, registry, animations);
    expect(planOffensive(game)).not.toBeNull();
    const city = new BuildingHost(map, 'TOWN', null);
    city.setTerrain(map.getTerrain(1, 1)); map.getTerrain(1, 1).building = city; city.init();
    expect(planOffensive(game)).toBeNull();
    const env = new GameEnvironment(map, registry, { rng }, game);
    const action = await new CoordinatedAi().selectAction(env);
    expect(action).toMatchObject({ uid: actor.uid, actionId: 'ACTION_CAPTURE' });
    expect(applyAction(game, action!)).toBe(true);
  });

  it('keeps apparent firing positions unchanged by a hidden occupant', () => {
    const run = (x: number, y: number) => {
      const map = createMap(12, 7, 'PLAINS');
      const player = map.addPlayer('os'), enemy = map.addPlayer('bm'); enemy.team = 1;
      map.addUnit('LIGHT_TANK', player, 2, 2);
      map.addUnit('LIGHT_TANK', player, 3, 1);
      map.addUnit('LIGHT_TANK', player, 2, 4);
      map.addUnit('LIGHT_TANK', enemy, 4, 3);
      const hidden = map.addUnit('INFANTRY', enemy, x, y); hidden.setHidden(true);
      const game = new Game(map, registry, animations);
      expect(hidden.isStealthed(player)).toBe(true);
      const plan = planOffensive(game);
      expect(plan).not.toBeNull();
      return plan;
    };
    expect(run(4, 2)).toEqual(run(10, 0));
  });

  it('bounds sequence evaluation and damage prediction on a crowded front', () => {
    const map = createMap(16, 10, 'PLAINS');
    const player = map.addPlayer('os'), enemy = map.addPlayer('bm'); enemy.team = 1;
    for (let y = 0; y < 10; y += 2) {
      for (let x = 1; x <= 5; x += 2) map.addUnit('LIGHT_TANK', player, x, y);
      for (let x = 8; x <= 12; x += 2) map.addUnit('LIGHT_TANK', enemy, x, y);
    }
    const game = new Game(map, registry, animations);
    const forecast = vi.spyOn(DamagePredictor.prototype, 'calcVirtualUnitDamage');
    try {
      const result = planOffensive(game);
      expect(forecast.mock.calls.length).toBeGreaterThan(0);
      expect(forecast.mock.calls.length).toBeLessThanOrEqual(12000);
      if (result) expect(result.evaluatedSequences).toBeLessThanOrEqual(2000);
    } finally { forecast.mockRestore(); }
  });

  it('continues against the actual remaining HP and preserves the objective on save/resume', async () => {
    const { game, env, map, target } = battlefield();
    const ai = new CoordinatedAi({ seed: 7 });
    ai.beginTurn(env);
    const first = await ai.selectAction(env);
    expect(first?.kind).toBe('unit');
    expect(applyAction(game, first!)).toBe(true);
    const saved = JSON.parse(JSON.stringify(ai.saveState()));
    const before = snapshot(game), randomBefore = rng.getState();
    const resumed = new CoordinatedAi({ seed: 99 });
    resumed.loadState(saved);
    resumed.beginTurn(env);
    const uninterrupted = await ai.selectAction(env);
    expect(await resumed.selectAction(env)).toEqual(uninterrupted);
    expect(snapshot(game)).toEqual(before);
    expect(rng.getState()).toBe(randomBefore);
    expect(uninterrupted).toMatchObject({ actionId: 'ACTION_FIRE', target: { x: target.x, y: target.y } });
    expect(applyAction(game, uninterrupted!)).toBe(true);
    expect(map.getUnitByUid(target.uid)).toBeNull();
  });

  it('abandons an interrupted attack instead of repeatedly issuing its reserved shot', async () => {
    const { game, env, target } = battlefield();
    const ai = new CoordinatedAi(); ai.beginTurn(env);
    const first = await ai.selectAction(env);
    expect(first).toMatchObject({ actionId: 'ACTION_FIRE' });
    // A caller rejected the action, so the selected unit remains unspent.
    const next = await ai.selectAction(env);
    expect(ai.saveState()).toMatchObject({ pending: null, blockedTargets: [target.uid] });
    if (next) expect(applyAction(game, next)).toBe(true);
  });

  it('cancels a continuation if the objective is no longer visible', async () => {
    const { game, env, target } = battlefield();
    const ai = new CoordinatedAi(); ai.beginTurn(env);
    expect(applyAction(game, (await ai.selectAction(env))!)).toBe(true);
    target.setHidden(true);
    const action = await ai.selectAction(env);
    expect(ai.saveState()).toMatchObject({ pending: null });
    if (action?.kind === 'unit' && action.actionId === 'ACTION_FIRE') {
      expect(action.target).not.toEqual({ x: target.x, y: target.y });
    }
  });

  it('cancels the reserved objective after an actual hidden-enemy ambush', async () => {
    const map = createMap(12, 7, 'PLAINS');
    const player = map.addPlayer('os'), enemy = map.addPlayer('bm'); enemy.team = 1;
    map.addUnit('LIGHT_TANK', player, 2, 2);
    map.addUnit('LIGHT_TANK', player, 3, 1);
    map.addUnit('LIGHT_TANK', player, 2, 4);
    const target = map.addUnit('LIGHT_TANK', enemy, 4, 3);
    const game = new Game(map, registry, animations);
    const env = new GameEnvironment(map, registry, { rng }, game);
    const ai = new CoordinatedAi(); ai.beginTurn(env);
    const action = await ai.selectAction(env);
    expect(action).toMatchObject({ kind: 'unit', actionId: 'ACTION_FIRE' });
    if (action?.kind !== 'unit') throw new Error('Expected coordinated shot');
    const blocker = map.addUnit('INFANTRY', enemy, action.to.x, action.to.y);
    blocker.setHidden(true);
    expect(blocker.isStealthed(player)).toBe(true);
    expect(applyAction(game, action)).toBe(true);
    expect(map.getUnitByUid(action.uid)?.getHasMoved()).toBe(true);
    expect(target.getHp()).toBe(10);
    await ai.selectAction(env);
    expect(ai.saveState()).toMatchObject({ blockedTargets: [target.uid] });
  });

  it.each([GameEnums.Fog_Off, GameEnums.Fog_OfWar, GameEnums.Fog_OfShroud])(
    'does not change a visible plan when hidden enemies move (fog mode %s)', fog => {
      const run = (x: number, y: number) => {
        const { map, game, enemy, player, target } = battlefield();
        const hidden = map.addUnit('ROCKETTHROWER', enemy, x, y);
        hidden.setHidden(true);
        map.rules.fogMode = fog;
        map.vision.update();
        player.addVisionField(target.x, target.y, 1, true);
        expect(hidden.isStealthed(player)).toBe(true);
        expect(target.isStealthed(player)).toBe(false);
        const before = snapshot(game);
        const result = planOffensive(game);
        expect(snapshot(game)).toEqual(before);
        expect(result).not.toBeNull();
        return result;
      };
      expect(run(0, 0)).toEqual(run(10, 0));
    });

  it('ignores malformed persisted objectives and rebuilds on a new turn', async () => {
    const { env } = battlefield();
    const ai = new CoordinatedAi();
    ai.loadState({ version: 1, day: 1, player: 0, searches: 1,
      pending: { targetUid: 'invalid', actorUid: {}, to: null }, blockedTargets: [null, -2] });
    expect(ai.saveState()).toMatchObject({ pending: null, blockedTargets: [] });
    ai.beginTurn(env);
    expect(await ai.selectAction(env)).toMatchObject({ actionId: 'ACTION_FIRE' });
  });
});
