import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import {
  GameEnvironment, HeuristicAgent, playMatch, applyAction, type ActionDescriptor,
} from '../src/ai/index.ts';

const { registry, animations, rng } = bootstrap();
const MAP = 'maps/pre_deployed/8-Bridge Isles.map';

function newGame(seed: number) {
  const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), MAP))), registry);
  const game = new Game(map, registry, animations);
  map.vision.update();
  const env = new GameEnvironment(
    map, registry, { maxDays: 20, maxFieldChoices: 6, rng, seed }, game);
  env.reset(seed);
  return { game, env };
}

/** Everything that must be identical after a faithful replay. */
const fingerprint = (game: Game) =>
  [game.day, game.currentPlayerIndex, game.map.players.map(p => p.funds).join(),
    game.map.units.map(u => `${u.getUnitID()}@${u.x},${u.y}:${u.getHp().toFixed(4)}`).sort().join('|'),
  ].join('/');

describe('replays', () => {
  it('reproduce the game they recorded, luck included', () => {
    // Self-play data is stored as replays rather than encoded positions, which
    // only works if replaying is exact. Combat rolls luck, so this also covers
    // the RNG being reseeded rather than carried over from whatever ran before.
    const recorded: Array<{ player: number; action: ActionDescriptor }> = [];
    const first = newGame(7);
    const original = playMatch(first.env, [new HeuristicAgent(), new HeuristicAgent()], {
      maxSteps: 4000,
      onStep: (_s, action, player) => { recorded.push({ player, action }); },
    });

    return original.then(result => {
      const expected = fingerprint(first.game);
      expect(recorded.length).toBeGreaterThan(20);

      const second = newGame(7);
      let refused = 0;
      for (const step of recorded) {
        if (step.action.kind === 'endTurn') second.game.endTurn();
        else if (!applyAction(second.game, step.action)) refused++;
      }

      expect(refused).toBe(0);
      expect(fingerprint(second.game)).toBe(expected);
      expect(second.game.over?.winner ?? null).toBe(result.winner);
    });
  });
});
