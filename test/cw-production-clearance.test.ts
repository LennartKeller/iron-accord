import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { snapshot } from '../src/game/snapshot.ts';
import { BuildingHost } from '../src/host/building.ts';
import { GameEnvironment } from '../src/ai/environment.ts';
import { NormalAi } from '../src/ai/cw/normalai.ts';
import { applyAction, type ActionDescriptor } from '../src/ai/actions.ts';

const { registry, createMap, animations, rng } = bootstrap();
function battle(buildingId = 'FACTORY', unitId = 'HEAVY_TANK', enemyId = 'FIGHTER', width = 12, height = 7) {
  const map = createMap(width, height);
  const player = map.addPlayer('os');
  const foe = map.addPlayer('bm');
  foe.team = 1;
  const base = new BuildingHost(map, buildingId, player);
  base.setTerrain(map.getTerrain(0, 0));
  map.getTerrain(0, 0).building = base;
  base.init();
  const unit = map.addUnit(unitId, player, 0, 0);
  map.addUnit(enemyId, foe, width - 1, height - 1);
  const game = new Game(map, registry, animations);
  player.funds = 30_000;
  const env = new GameEnvironment(map, registry, { rng }, game);
  const ai = new NormalAi({ seed: 3 });
  ai.beginTurn(env);
  return { map, game, player, base, unit, env, ai };
}

describe('NormalAi production clearance', () => {
  it('vacates a healthy idle factory before spending its turn and then builds there', async () => {
    const { map, game, base, unit, env, ai } = battle();
    const before = snapshot(game);
    const clearance = await ai.selectAction(env);
    expect(clearance).toMatchObject({ kind: 'unit', uid: unit.uid, actionId: 'ACTION_WAIT' });
    expect(clearance!.kind === 'unit' && (clearance!.to.x !== 0 || clearance!.to.y !== 0)).toBe(true);
    expect(snapshot(game)).toEqual(before);
    expect(applyAction(game, clearance!)).toBe(true);
    expect(map.getUnitAt(0, 0)).toBeNull();
    let built: ActionDescriptor | null = null;
    for (let i = 0; i < 30; i++) {
      const action = await ai.selectAction(env);
      if (!action || action.kind === 'endTurn') break;
      expect(applyAction(game, action)).toBe(true);
      if (action.kind === 'build' && action.at.x === base.getX() && action.at.y === base.getY()) {
        built = action;
        break;
      }
    }
    expect(built).not.toBeNull();
    expect(map.getUnitAt(0, 0)).not.toBe(unit);
    expect(map.getUnitAt(0, 0)).not.toBeNull();
  });

  it('also frees an airport occupied by an idle, fully healthy fighter', async () => {
    const { game, unit, env, ai } = battle('AIRPORT', 'FIGHTER', 'INFANTRY');
    const action = await ai.selectAction(env);
    expect(action).toMatchObject({ kind: 'unit', uid: unit.uid, actionId: 'ACTION_WAIT' });
    expect(action!.kind === 'unit' && (action!.to.x !== 0 || action!.to.y !== 0)).toBe(true);
    expect(applyAction(game, action!)).toBe(true);
  });

  it.each(['wounded', 'low fuel', 'low ammo', 'no funds', 'unit cap'] as const)('keeps a unit on its base when %s', async reason => {
    const { game, player, unit, env, ai } = battle();
    if (reason === 'wounded') unit.hp = 6;
    if (reason === 'low fuel') unit.fuel = 1;
    if (reason === 'low ammo') unit.ammo1 = 0;
    if (reason === 'no funds') player.funds = 0;
    if (reason === 'unit cap') game.map.rules.unitLimit = 1;
    const before = snapshot(game);
    const action = await ai.selectAction(env);
    expect(snapshot(game)).toEqual(before);
    if (action && action.kind === 'unit') {
      expect(action.to).toMatchObject({ x: 0, y: 0 });
      expect(applyAction(game, action)).toBe(true);
    }
    expect(unit.x).toBe(0);
    expect(unit.y).toBe(0);
  });

  it('does not clear an unarmed transport into the only tile threatened by a megatank', async () => {
    const { game, unit, env, ai } = battle('FACTORY', 'APC', 'MEGATANK', 3, 1);
    const action = await ai.selectAction(env);
    if (action && action.kind === 'unit') {
      expect(action.to).toMatchObject({ x: 0, y: 0 });
      expect(applyAction(game, action)).toBe(true);
    }
    expect(unit.x).toBe(0);
  });

  it('retains capture priority for a factory that is not owned yet', async () => {
    const { base, game, unit, env, ai } = battle('FACTORY', 'INFANTRY', 'FIGHTER');
    base.setOwner(null);
    const action = await ai.selectAction(env);
    expect(action).toMatchObject({ kind: 'unit', uid: unit.uid, actionId: 'ACTION_CAPTURE', to: { x: 0, y: 0 } });
    expect(applyAction(game, action!)).toBe(true);
    expect(unit.capturePoints).toBeGreaterThan(0);
  });
});
