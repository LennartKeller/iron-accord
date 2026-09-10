import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { GameEnvironment } from '../src/ai/environment.ts';
import { NormalAi } from '../src/ai/cw/normalai.ts';
import type { ActionDescriptor } from '../src/ai/actions.ts';

const { createMap, registry, rng } = bootstrap();

function crossing(loaded: boolean) {
  const map = createMap(10, 3, 'SEA');
  const own = map.addPlayer('os'), enemy = map.addPlayer('bm');
  own.team = 0;
  enemy.team = 1;
  for (const [x, y, terrain] of [[0, 0, 'PLAINS'], [0, 1, 'BEACH'],
    [6, 1, 'BEACH'], [7, 1, 'PLAINS'], [8, 1, 'PLAINS'], [9, 1, 'PLAINS']] as const) {
    map.setTerrainID(x, y, terrain);
  }
  map.getTerrain(7, 1).loadBuilding('TOWN');
  const carrier = map.addUnit('LANDER', own, 0, 1);
  const infantry = map.addUnit('INFANTRY', own, 0, 0);
  if (loaded) {
    map.removeUnit(infantry);
    carrier.loaded.push(infantry);
  }
  map.addUnit('INFANTRY', enemy, 9, 1);
  const env = new GameEnvironment(map, registry, { rng });
  return { env, carrier, infantry };
}

async function turn(env: GameEnvironment, ai: NormalAi) {
  ai.beginTurn(env);
  const actions: ActionDescriptor[] = [];
  for (let i = 0; i < 60; i++) {
    const action = await ai.selectAction(env);
    if (!action || action.kind === 'endTurn') return actions;
    expect(env.step(action).info.accepted, JSON.stringify(action)).toBe(true);
    actions.push(action);
  }
  throw new Error('Transport turn did not finish');
}

describe('NormalAi transport sequence', () => {
  it('loads an isolated infantry and ferries it across to an objective', async () => {
    const { env, carrier, infantry } = crossing(false);
    const ai = new NormalAi({ seed: 3 });
    const actions = await turn(env, ai);
    expect(actions).toContainEqual(expect.objectContaining({ actionId: 'ACTION_LOAD', uid: infantry.uid }));
    expect(actions).toContainEqual(expect.objectContaining({ actionId: 'ACTION_UNLOAD', uid: carrier.uid }));
    expect(carrier.x).toBe(6);
    expect(carrier.loaded).toHaveLength(0);
    expect(infantry.x).toBe(7);
    expect(env.game.map.getUnitAt(infantry.x, infantry.y)).toBe(infantry);
  });

  it('moves an already loaded ferry and plans its drop at the destination', async () => {
    const { env, carrier, infantry } = crossing(true);
    const ai = new NormalAi({ seed: 3 });
    const actions = await turn(env, ai);
    expect(actions[0]).toEqual(expect.objectContaining({
      actionId: 'ACTION_UNLOAD', uid: carrier.uid, to: { x: 6, y: 1 }, steps: [{ x: 7, y: 1 }, 'ACTION_WAIT'],
    }));
    expect(infantry.x).toBe(7);
    expect(carrier.loaded).toHaveLength(0);
    // A fresh day resets the transport pass and lets the landed infantry capture.
    env.game.endTurn();
    env.game.endTurn();
    const next = await turn(env, ai);
    expect(next).toContainEqual(expect.objectContaining({ actionId: 'ACTION_CAPTURE', uid: infantry.uid }));
  });

  it('drops multiple passengers on distinct destination fields in one committed action', async () => {
    const { env, carrier, infantry } = crossing(true);
    env.game.map.setTerrainID(6, 0, 'PLAINS');
    const other = env.game.map.addUnit('INFANTRY', carrier.getOwner(), 0, 0);
    env.game.map.removeUnit(other);
    carrier.loaded.push(other);
    const actions = await turn(env, new NormalAi({ seed: 3 }));
    expect(actions[0]).toEqual(expect.objectContaining({
      actionId: 'ACTION_UNLOAD', uid: carrier.uid,
      steps: ['0', { x: 7, y: 1 }, '1', { x: 6, y: 0 }, 'ACTION_WAIT'],
    }));
    expect(carrier.loaded).toHaveLength(0);
    expect(infantry.x).toBe(7);
    expect(other.x).toBe(6);
    expect(env.game.map.getUnitAt(other.x, other.y)).toBe(other);
  });

});
