import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { Game } from '../src/game/game.ts';
import { GameEnums } from '../src/host/index.ts';
import { GameEnvironment, NormalAi, playMatch, type ActionDescriptor } from '../src/ai/index.ts';

const runtime = bootstrap();
const load = (file: string) => loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), file))), runtime.registry);

describe('map filter flags', () => {
  it('survive loading, so the AI can ask what kind of map this is', () => {
    const naval = load('maps/2_player/Agitated.map');
    expect(naval.hasMapFlags(GameEnums.MapFilterFlags_Naval)).toBe(true);
    expect(naval.hasMapFlags(GameEnums.MapFilterFlags_Ground)).toBe(true);
    expect(naval.hasMapFlags(GameEnums.MapFilterFlags_Air)).toBe(false);
    const land = load('maps/2_player/Amber Valley.map');
    expect(land.hasMapFlags(GameEnums.MapFilterFlags_Naval)).toBe(false);
  });

  it('make the Commander Wars AI build a navy on a naval map', async () => {
    // Agitated's two sides meet only by sea. The real AI builds ships there from
    // its harbours; with the flags dropped this port built none, and both land
    // armies sat on their own shore for the rest of the match.
    const map = load('maps/2_player/Agitated.map');
    const game = new Game(map, runtime.registry, runtime.animations);
    const env = new GameEnvironment(map, runtime.registry, { maxDays: 14, maxFieldChoices: 6, rng: runtime.rng, seed: 5 }, game);
    env.reset(5);
    const built: string[] = [];
    await playMatch(env, [new NormalAi({ seed: 11 }), new NormalAi({ seed: 12 })], {
      maxSteps: 4000,
      onStep: (_step, action: ActionDescriptor) => { if (action.kind === 'build') built.push(action.unitId); },
    });
    const ships = built.filter(id => runtime.registry[id]?.getUnitType?.() === GameEnums.UnitType_Naval);
    expect(ships.length).toBeGreaterThan(5);
  });
});
