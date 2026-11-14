import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { Game } from '../src/game/game.ts';
import { soundBus } from '../src/host/sound.ts';

const runtime = bootstrap();
const source = readMap(fs.readFileSync(path.join(cwRoot(), 'maps/pre_deployed/8-Bridge Isles.map')));

afterEach(() => { soundBus.sink = null; });

describe('sound requests from the rule scripts', () => {
  const moveSomething = (game: Game): boolean => {
    for (const unit of game.currentPlayer.units) {
      const range = game.select(unit.x, unit.y);
      const to = range && [...range.tiles.values()].find(tile => tile.canStop && tile.cost > 0);
      if (to) return game.performAction('ACTION_WAIT', unit, { x: to.x, y: to.y });
    }
    return false;
  };

  it('reach a listener while an action is performed', () => {
    const game = new Game(loadIntoGameMap(source, runtime.registry), runtime.registry, runtime.animations);
    const heard: string[] = [];
    soundBus.sink = file => { heard.push(file); };
    expect(moveSomething(game)).toBe(true);
    // The walking animation names the unit's engine or footstep noise.
    expect(heard.some(file => /^move.*\.wav$/.test(file))).toBe(true);
  });

  it('go nowhere when nothing is listening, which is how a search stays silent', () => {
    const game = new Game(loadIntoGameMap(source, runtime.registry), runtime.registry, runtime.animations);
    expect(soundBus.sink).toBeNull();
    expect(moveSomething(game)).toBe(true);
  });
});
