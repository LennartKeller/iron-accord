import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { defaultConfig } from '../src/game/config.ts';
import { gameMapFromScene } from '../src/game/fromscene.ts';
import { Game } from '../src/game/game.ts';
import { createSave, isSavedGame, readSave, restoreSave, SAVE_KEY, writeSave, type SaveStorage } from '../src/game/save.ts';
import { snapshot } from '../src/game/snapshot.ts';
import type { Scene } from '../src/maps/scene.ts';

const { registry, animations, rng } = bootstrap();
const scene: Scene = {
  id: 'save-test', name: 'Save test', author: '', description: '', category: 'test', width: 5, height: 2,
  players: ['os', 'bm'].map((army, team) => ({ army, team, funds: 0, color: '#ffffff', colorTable: '' })),
  spriteIds: [], terrainIds: ['PLAINS'], tables: [], terrain: [Array(5).fill(0), Array(5).fill(0)],
  tileSprites: Array.from({ length: 10 }, () => []), buildings: [],
  units: [{ x: 0, y: 0, id: 'APC', owner: 0, hp: 10, sprites: [] },
    { x: 4, y: 0, id: 'INFANTRY', owner: 1, hp: 10, sprites: [] }],
};
const config = defaultConfig(2, ['os', 'bm']);
const fresh = () => new Game(gameMapFromScene(scene, registry, config), registry, animations);
function storage(): SaveStorage {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}

describe('autosave', () => {
  it('round-trips cargo, action state, temporary vision, terrain, funds and the next combat RNG draw', () => {
    const game = fresh();
    const carrier = game.map.units[0];
    const cargo = game.map.addUnit('INFANTRY', game.map.players[0], 1, 0);
    game.map.removeUnit(cargo);
    carrier.loaded.push(cargo);
    carrier.hasMoved = true;
    cargo.capturePoints = 7;
    carrier.offensiveBonus.push({ value: 15, duration: 2 });
    game.map.players[0].funds = 2345;
    game.map.players[0].visionFields.push({ x: 3, y: 0, duration: 1, directView: true, visionType: 0 });
    game.map.setTerrainID(2, 1, 'FOREST');
    rng.reseed(99);
    rng.next();
    const save = createSave(game, scene, config, rng, scene.id, 123);
    save.agentStates = { '0': { infantryBuilt: 4 } };
    const next = rng.next();
    const disk = storage();
    expect(writeSave(disk, save)).toBe(true);
    const loaded = readSave(disk);
    expect(loaded.status).toBe('ready');
    if (loaded.status !== 'ready') throw new Error('save not readable');
    const resumed = fresh();
    restoreSave(resumed, rng, loaded.save);
    expect(snapshot(resumed)).toEqual(save.state);
    expect(rng.next()).toBe(next);
    expect(loaded.save.agentStates).toEqual(save.agentStates);
    expect(resumed.map.players[0].funds).toBe(2345);
    expect(resumed.map.units[0].hasMoved).toBe(true);
  });

  it.each([
    (v: any) => { v.version = 999; },
    (v: any) => { v.state.units[0].owner = 8; },
    (v: any) => { v.state.terrain.pop(); },
    (v: any) => { v.state.units.push(v.state.units[0]); },
    (v: any) => { v.state.units[0].loaded = null; },
    (v: any) => { v.scene.terrain[0][0] = 99; },
    (v: any) => { v.config.seats = []; },
    (v: any) => { v.state.currentPlayerIndex = -1; },
    (v: any) => { v.rngState = 0.5; },
  ])('rejects corrupt or incompatible payloads before restore (%#)', mutate => {
    const save = createSave(fresh(), scene, config, rng);
    mutate(save);
    const disk = storage();
    disk.setItem(SAVE_KEY, JSON.stringify(save));
    expect(readSave(disk).status).toBe('invalid');
  });

  it('keeps the previous save when a storage write fails and tolerates blocked storage', () => {
    const disk = storage();
    const save = createSave(fresh(), scene, config, rng);
    expect(writeSave(disk, save)).toBe(true);
    const before = disk.getItem(SAVE_KEY);
    disk.setItem = () => { throw new Error('quota'); };
    expect(writeSave(disk, save)).toBe(false);
    expect(disk.getItem(SAVE_KEY)).toBe(before);
    disk.getItem = () => { throw new Error('denied'); };
    expect(readSave(disk).status).toBe('unavailable');
  });

  it('distinguishes an empty slot from invalid JSON without removing either', () => {
    const disk = storage();
    expect(readSave(disk).status).toBe('empty');
    disk.setItem(SAVE_KEY, '{');
    expect(readSave(disk).status).toBe('invalid');
    expect(disk.getItem(SAVE_KEY)).toBe('{');
  });

  it('detaches configuration and scene and rejects missing scripts before altering the game', () => {
    const game = fresh();
    const save = createSave(game, scene, config, rng);
    expect(isSavedGame(save)).toBe(true);
    save.config.seats[0].army = 'changed';
    expect(config.seats[0].army).toBe('os');
    save.scene.name = 'changed';
    expect(scene.name).toBe('Save test');
    const before = snapshot(game);
    save.state.units[0].unitID = 'MISSING_SAVE_SCRIPT';
    expect(() => restoreSave(game, rng, save)).toThrow('missing script');
    expect(snapshot(game)).toEqual(before);
  });
});
