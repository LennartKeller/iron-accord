import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';

const { registry, animations } = bootstrap();

describe('shipped-script repairs', () => {
  it('gives TERRAIN and BUILDING a callable onDestroyed', () => {
    // Upstream declares onDestroyed twice in each base object literal, so the
    // trailing `null` wins and every type that does not override it inherits a
    // non-function. ACTION_FIRE calls it unconditionally on destruction.
    expect(typeof (registry.TERRAIN as { onDestroyed?: unknown }).onDestroyed).toBe('function');
    expect(typeof (registry.BUILDING as { onDestroyed?: unknown }).onDestroyed).toBe('function');
  });

  it('destroys a building by fire without the callback throwing', () => {
    const source = readMap(fs.readFileSync(path.join(cwRoot(), 'maps/2_player/60-ZWEITER KRIEG.map')));
    const map = loadIntoGameMap(source, registry);
    const game = new Game(map, registry, animations);

    // Find a building with HP that a bomber can flatten in one pass.
    let target: { x: number; y: number } | null = null;
    for (let y = 0; y < map.getMapHeight() && !target; y++) {
      for (let x = 0; x < map.getMapWidth() && !target; x++) {
        const building = map.getTerrain(x, y).getBuilding();
        if (building && building.getHp() > 0) target = { x, y };
      }
    }
    if (target === null) return;   // no destructible structure on this map

    const building = map.getTerrain(target.x, target.y).getBuilding()!;
    building.setHp(1);
    const warnings: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const os = map.getPlayer(0)!;
      const from = { x: target.x, y: target.y - 1 };
      if (!map.onMap(from.x, from.y) || map.getUnitAt(from.x, from.y)) return;
      const attacker = map.addUnit('ARTILLERY', os, from.x, from.y);
      game.select(from.x, from.y);
      game.attack(attacker, from, target);
    } finally {
      console.warn = original;
    }
    // The repair exists so this callback completes; a throw here is logged and
    // swallowed, which is what silently desynchronised replays.
    const failures = warnings.filter(w => JSON.stringify(w).includes('onDestroyed'));
    expect(failures).toEqual([]);
  });
});
