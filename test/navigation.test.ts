import { describe, it, expect } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Navigator, distanceField, fieldAt, UNREACHABLE } from '../src/ai/navigation.ts';

const { createMap } = bootstrap();

/** A land strip, a channel of sea, then another strip. */
function islands() {
  const map = createMap(9, 3, 'PLAINS');
  map.addPlayer('os');
  map.addPlayer('bm');
  map.getPlayer(0)!.team = 0;
  map.getPlayer(1)!.team = 1;
  for (let y = 0; y < 3; y++) {
    for (const x of [3, 4, 5]) map.setTerrainID(x, y, 'SEA');
  }
  return map;
}

describe('navigation', () => {
  it('knows an island is unreachable on foot', () => {
    // The bug this exists to prevent: straight-line distance says the far
    // island is six tiles away, so infantry march to the shore and stop there
    // for the rest of the game.
    const map = islands();
    const infantry = map.addUnit('INFANTRY', map.getPlayer(0)!, 0, 1);
    const field = distanceField(map, infantry, [{ x: 8, y: 1 }]);

    expect(fieldAt(map, field, 8, 1)).toBe(0);
    expect(fieldAt(map, field, 7, 1)).toBeLessThan(UNREACHABLE);
    expect(fieldAt(map, field, 0, 1)).toBe(UNREACHABLE);   // our side of the water
    expect(fieldAt(map, field, 2, 1)).toBe(UNREACHABLE);   // even at the shore
  });

  it('routes a ship through the water the infantry cannot cross', () => {
    const map = islands();
    const lander = map.addUnit('LANDER', map.getPlayer(0)!, 3, 1);
    const field = distanceField(map, lander, [{ x: 5, y: 1 }]);
    expect(fieldAt(map, field, 3, 1)).toBeLessThan(UNREACHABLE);
  });

  it('measures cost, not tiles', () => {
    // Rough ground costs a foot unit more than plains, so the shorter route in
    // tiles is not always the nearer one.
    const map = createMap(7, 1, 'PLAINS');
    map.addPlayer('os');
    const infantry = map.addUnit('INFANTRY', map.getPlayer(0)!, 0, 0);
    map.setTerrainID(3, 0, 'MOUNTAIN');

    const field = distanceField(map, infantry, [{ x: 6, y: 0 }]);
    const throughMountain = fieldAt(map, field, 0, 0);
    expect(throughMountain).toBeGreaterThan(6);   // 6 tiles, but the peak costs extra
  });

  it('shares one field per movement type', () => {
    const map = islands();
    const a = map.addUnit('INFANTRY', map.getPlayer(0)!, 0, 0);
    const b = map.addUnit('INFANTRY', map.getPlayer(0)!, 0, 2);
    const navigator = new Navigator(map, [{ x: 8, y: 1 }]);
    expect(navigator.for(a)).toBe(navigator.for(b));
    expect(navigator.canReachGoal(a)).toBe(false);
  });

  it('reports no goals as unreachable rather than zero', () => {
    const map = islands();
    const infantry = map.addUnit('INFANTRY', map.getPlayer(0)!, 0, 1);
    const navigator = new Navigator(map, []);
    expect(navigator.distance(infantry, 0, 1)).toBe(UNREACHABLE);
  });
});
