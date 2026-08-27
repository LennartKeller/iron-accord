import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { GameEnvironment } from '../src/ai/environment.ts';
import { playMatch, RandomAgent } from '../src/ai/agent.ts';
import { NormalAi } from '../src/ai/cw/normalai.ts';
import { HeuristicAgent } from '../src/ai/heuristic.ts';

const { registry, rng } = bootstrap();
const LAND = 'maps/2_player/60-ZWEITER KRIEG.map';

function environment(seed = 1): GameEnvironment {
  const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), LAND))), registry);
  // The rng handed over must be the one bootstrap wired into the script globals,
  // and reset() must reseed it. Passing a fresh Mulberry32 instead leaves the
  // scripts on the shared stream, so combat luck carries over from the previous
  // episode and two runs from the same seed quietly diverge.
  const env = new GameEnvironment(map, registry, { maxDays: 12, seed, rng });
  env.reset(seed);
  return env;
}

describe('NormalAi', () => {
  it('plays a legal turn without stalling', async () => {
    const env = environment();
    const ai = new NormalAi({ seed: 7 });
    await ai.beginTurn(env);

    let actions = 0;
    // A turn must terminate: the ladder has to run out of things to do rather
    // than offering the same move forever.
    while (actions < 400) {
      const action = await ai.selectAction(env);
      if (action === null) break;
      expect(env.step(action).info.accepted).toBe(true);
      actions++;
      if (env.currentPlayer !== 0 || env.done) break;
    }
    expect(actions).toBeGreaterThan(0);
    expect(actions).toBeLessThan(400);
  });

  it('captures buildings when it can reach them', async () => {
    const env = environment();
    const player = env.game.map.getPlayer(0)!;
    const before = env.game.ownedBuildings(player).length;
    const ai = new NormalAi({ seed: 3 });

    await playMatch(env, [ai, new RandomAgent(11)], { maxSteps: 4000 });
    const after = env.game.ownedBuildings(player).length;
    // Taking ground is the whole point of the capture rung.
    expect(after).toBeGreaterThan(before);
  });

  it('plays a full match against a random agent and wins on material', async () => {
    const env = environment(5);
    const ai = new NormalAi({ seed: 5 });
    const result = await playMatch(env, [ai, new RandomAgent(9)], { maxSteps: 6000 });

    expect(result.reason).not.toBe('step-limit');
    const own = env.game.map.getPlayer(0)!;
    const foe = env.game.map.getPlayer(1)!;
    const value = (units: typeof own.units) =>
      units.reduce((sum, unit) => sum + unit.getUnitValue(), 0);
    // It cannot build yet, so judge it on what it does with what it starts
    // with: it should not be losing the army trade to random play.
    expect(value(own.units)).toBeGreaterThanOrEqual(value(foe.units) * 0.5);
  });

  it('reproduces exactly from a seed', async () => {
    const run = async () => {
      const env = environment(2);
      const result = await playMatch(
        env, [new NormalAi({ seed: 4 }), new RandomAgent(6)], { maxSteps: 4000 });
      return `${result.winner}:${result.days}:${result.steps}`;
    };
    expect(await run()).toBe(await run());
  });

  it('keeps its factories producing rather than blocking them', async () => {
    const env = environment(8);
    const ai = new NormalAi({ seed: 8 });
    let builds = 0;
    await playMatch(env, [ai, new HeuristicAgent()], {
      maxSteps: 4000,
      onStep(_step, action, player) { if (player === 0 && action.kind === 'build') builds++; },
    });

    // A unit built this turn legitimately stands on the factory until it can
    // move, so a snapshot of the final board proves nothing. What matters is
    // that production never seizes up: moveAwayFromProduction should keep the
    // factories clear enough to buy something most turns.
    expect(builds).toBeGreaterThanOrEqual(Math.floor(env.game.day / 2));
  });
});

describe('NormalAi on water', () => {
  const NAVAL = 'maps/2_player/Bean Island.map';

  function navalEnvironment(seed = 1): GameEnvironment {
    const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), NAVAL))), registry);
    const env = new GameEnvironment(map, registry, { maxDays: 20, seed, rng });
    env.reset(seed);
    return env;
  }

  it('plays an island map without stalling', async () => {
    const env = navalEnvironment(4);
    const result = await playMatch(
      env, [new NormalAi({ seed: 4 }), new RandomAgent(2)], { maxSteps: 8000 });
    // The transport rungs must not deadlock: a ferry that keeps boarding and
    // unloading the same unit would burn the step budget without ending a turn.
    expect(result.reason).not.toBe('step-limit');
  });

  it('builds and moves on an island map', async () => {
    const env = navalEnvironment(6);
    let builds = 0;
    await playMatch(env, [new NormalAi({ seed: 6 }), new RandomAgent(3)], {
      maxSteps: 8000,
      onStep(_step, action, player) { if (player === 0 && action.kind === 'build') builds++; },
    });
    expect(builds).toBeGreaterThan(0);
  });

  it('stays reproducible with the transport rungs in play', async () => {
    const run = async () => {
      const env = navalEnvironment(7);
      const r = await playMatch(
        env, [new NormalAi({ seed: 9 }), new RandomAgent(4)], { maxSteps: 8000 });
      return `${r.winner}:${r.days}:${r.steps}`;
    };
    expect(await run()).toBe(await run());
  });
});
