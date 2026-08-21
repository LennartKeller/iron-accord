import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import { GameEnvironment, enumerateActions, applyAction } from '../src/ai/index.ts';

const { registry, animations, rng } = bootstrap();

function loadGame(seed: number) {
  const map = loadIntoGameMap(
    readMap(fs.readFileSync(path.join(cwRoot(), 'maps/pre_deployed/Crosspaths.map'))), registry);
  const game = new Game(map, registry, animations);
  const env = new GameEnvironment(map, registry, { maxDays: 30, maxFieldChoices: 6, rng, seed }, game);
  env.reset(seed);
  return { game, env };
}

describe('explore', () => {
  it('puts the board back exactly', () => {
    const { game, env } = loadGame(5);
    const before = env.observe();
    env.explore(() => {
      for (const action of enumerateActions(game).slice(0, 5)) applyAction(game, action);
    });
    expect(Array.from(env.observe().planes)).toEqual(Array.from(before.planes));
  });

  it('puts destructible terrain back', () => {
    // ACTION_FIRE damages terrain in place (ACTION_FIRE.js:833) and walls,
    // meteors and destroyed pipes swap the tile outright. A rollback that
    // tracked only units and buildings left the planner demolishing the live
    // board just by thinking about shooting it — permanently, with no log, and
    // worse the longer it thought.
    const { game, env } = loadGame(5);
    const before = game.map.getTerrain(0, 0);
    before.setHp(10);
    const beforeID = before.getTerrainID();
    const other = beforeID === 'PLAINS' ? 'SEA' : 'PLAINS';

    env.explore(() => {
      game.map.getTerrain(0, 0).setHp(3);
      game.map.replaceTerrainOnly(other, 0, 0);
    });

    expect(game.map.getTerrain(0, 0).getTerrainID()).toBe(beforeID);
    expect(game.map.getTerrain(0, 0).getHp()).toBe(10);
  });

  it('does not spend the randomness the real game will use', () => {
    // A search agent simulates attacks to decide what to play. If exploring
    // consumed the shared luck stream, the outcome of the move it finally makes
    // would depend on how much it thought about it beforehand.
    const played = (think: boolean) => {
      const { game, env } = loadGame(5);
      if (think) {
        env.explore(() => {
          for (const action of enumerateActions(game).slice(0, 8)) applyAction(game, action);
        });
      }
      for (const action of enumerateActions(game).slice(0, 8)) applyAction(game, action);
      return game.map.units.map(u => `${u.getUnitID()}@${u.x},${u.y}:${u.getHp().toFixed(4)}`).sort();
    };
    expect(played(true)).toEqual(played(false));
  });

  it('rewinds the stream position itself', () => {
    const { env } = loadGame(11);
    const before = rng.getState();
    env.explore(() => { for (let i = 0; i < 20; i++) rng.next(); });
    expect(rng.getState()).toBe(before);
  });
});
