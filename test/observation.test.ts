import { describe, it, expect } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { ObservationEncoder } from '../src/ai/observation.ts';
import { vocabulary } from '../src/scripts/vocabulary.ts';
import { GameEnums } from '../src/host/index.ts';

const { registry, animations, createMap } = bootstrap();

function scenario(fog: number) {
  const map = createMap(15, 5, 'PLAINS');
  map.addPlayer('os');
  map.addPlayer('bm');
  map.getPlayer(0)!.team = 0;
  map.getPlayer(1)!.team = 1;
  map.getGameRules().setFogMode(fog);
  return map;
}

/** Total activation across the channels that name a unit type. */
function unitMass(planes: Float32Array, encoder: ObservationEncoder): number {
  const { terrain, units } = vocabulary(registry);
  const planeSize = encoder.spec.width * encoder.spec.height;
  let mass = 0;
  for (let c = terrain.length; c < terrain.length + units.length; c++) {
    for (let i = 0; i < planeSize; i++) mass += planes[c * planeSize + i];
  }
  return mass;
}

describe('observation encoding', () => {
  it('uses one channel layout for every map', () => {
    // A learned model needs a fixed input spec; per-map vocabularies gave a
    // different channel count on every board.
    const board = (w: number, h: number) => {
      const map = createMap(w, h, 'PLAINS');
      map.addPlayer('os');
      map.addPlayer('bm');
      return new Game(map, registry, animations);
    };
    const small = board(5, 5);
    const large = board(24, 17);
    const a = ObservationEncoder.fromGame(small);
    const b = ObservationEncoder.fromGame(large);

    expect(a.spec.channels).toBe(b.spec.channels);
    expect(a.spec.channelNames).toEqual(b.spec.channelNames);
    expect(a.spec.width).not.toBe(b.spec.width);   // the board still varies
  });

  it('never encodes a unit the viewer cannot see', () => {
    // The whole point of a fog-capable value net: train it on ground truth and
    // it learns to use information it will not have when it plays.
    const map = scenario(GameEnums.Fog_OfWar);
    map.addUnit('INFANTRY', map.getPlayer(0)!, 0, 2);
    map.addUnit('LIGHT_TANK', map.getPlayer(1)!, 14, 2);   // far away, unseen
    map.vision.update();
    const game = new Game(map, registry, animations);
    const encoder = ObservationEncoder.fromGame(game);

    const mine = encoder.encode(game, 0);
    // Only our own infantry should appear — one tile of unit activation.
    expect(unitMass(mine.planes, encoder)).toBe(1);

    // With fog off the same board shows both.
    map.getGameRules().setFogMode(GameEnums.Fog_Off);
    map.vision.update();
    expect(unitMass(encoder.encode(game, 0).planes, encoder)).toBe(2);
  });

  it('shows the board from the acting player\'s side', () => {
    const map = scenario(GameEnums.Fog_Off);
    map.addUnit('INFANTRY', map.getPlayer(0)!, 1, 2);
    map.addUnit('INFANTRY', map.getPlayer(1)!, 2, 2);
    map.vision.update();
    const game = new Game(map, registry, animations);
    const encoder = ObservationEncoder.fromGame(game);

    // "mine" and "theirs" must swap with the viewer, so one network serves
    // both seats without a flip.
    const p1 = encoder.encode(game, 0).planes;
    const p2 = encoder.encode(game, 1).planes;
    const mineChannel = encoder.spec.channelNames.indexOf('unit:mine');
    const planeSize = encoder.spec.width * encoder.spec.height;
    const at = (planes: Float32Array, x: number, y: number) =>
      planes[mineChannel * planeSize + y * encoder.spec.width + x];

    expect(at(p1, 1, 2)).toBe(1);
    expect(at(p1, 2, 2)).toBe(0);
    expect(at(p2, 1, 2)).toBe(0);
    expect(at(p2, 2, 2)).toBe(1);
  });
});
