import { afterEach, describe, expect, it, vi } from 'vitest';
import { SceneRenderer } from '../src/render/renderer.ts';
import type { SpriteStore, LoadedSprite } from '../src/render/sprites.ts';
import type { Scene } from '../src/maps/scene.ts';

function scene(id: string, width = 1): Scene {
  return {
    id, name: id, author: '', description: '', category: '', width, height: 1,
    players: [], spriteIds: [id], terrainIds: [], tables: [], terrain: [[]],
    tileSprites: [], buildings: [], units: [],
  };
}

function setup(preload: (ids: string[]) => Promise<void>, get = vi.fn()) {
  const ctx = {
    drawImage: vi.fn(), setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(),
    save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(),
  };
  const makeCanvas = () => ({
    width: 0, height: 0, clientWidth: 800, clientHeight: 600,
    getContext: () => ctx, getBoundingClientRect: () => ({ width: 800, height: 600 }),
  });
  vi.stubGlobal('document', { createElement: makeCanvas });
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  const sprites = { preload, get } as unknown as SpriteStore;
  const renderer = new SceneRenderer(makeCanvas() as unknown as HTMLCanvasElement, sprites);
  return { renderer, ctx };
}

afterEach(() => vi.unstubAllGlobals());

describe('renderer scene loading', () => {
  it('clears live units and old terrain while the new map loads', async () => {
    let release!: () => void;
    const { renderer, ctx } = setup(async ids => {
      if (ids[0] === 'new') await new Promise<void>(resolve => { release = resolve; });
    });
    await renderer.load(scene('old'));
    renderer.liveUnits = [{ x: 0, y: 0, id: 'INFANTRY', owner: 0, hasMoved: false, sprites: [] }];
    const loading = renderer.load(scene('new'));
    expect(renderer.liveUnits).toBeNull();
    ctx.drawImage.mockClear();
    renderer.render();
    expect(ctx.drawImage).not.toHaveBeenCalled();
    release();
    await loading;
  });

  it('ignores an older preload finishing after a newer scene', async () => {
    let release!: () => void;
    const { renderer, ctx } = setup(async ids => {
      if (ids[0] === 'old') await new Promise<void>(resolve => { release = resolve; });
    });
    const older = renderer.load(scene('old'));
    await renderer.load(scene('new', 3));
    release();
    await older;
    renderer.render();
    expect(renderer.scene?.id).toBe('new');
    expect(ctx.drawImage.mock.calls.at(-1)?.[0].width).toBe(48);
  });

  it('ignores an older terrain bake finishing after a newer scene', async () => {
    let release!: (sprite: LoadedSprite) => void;
    let started!: () => void;
    const baking = new Promise<void>(resolve => { started = resolve; });
    const get = vi.fn(() => new Promise<LoadedSprite>(resolve => { release = resolve; started(); }));
    const { renderer, ctx } = setup(async () => {}, get);
    const old = scene('old');
    old.tileSprites = [[[0, -1]]];
    const older = renderer.load(old);
    await baking;
    await renderer.load(scene('new', 3));
    release({ image: {} as CanvasImageSource, width: 16, height: 16, frameWidth: 16, frameHeight: 16, cols: 1, rows: 1 });
    await older;
    ctx.drawImage.mockClear();
    renderer.render();
    expect(renderer.scene?.id).toBe('new');
    expect(ctx.drawImage.mock.calls[0][0].width).toBe(48);
  });
});
