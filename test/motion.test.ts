import { describe, expect, it, vi } from 'vitest';
import { movementDuration, sampleRoute, visibleMotionTile } from '../src/render/motion.ts';
import { SceneRenderer } from '../src/render/renderer.ts';
import type { SpriteStore } from '../src/render/sprites.ts';

describe('presentation movement', () => {
  const path = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];

  it('follows route corners and clamps times outside the animation', () => {
    expect(sampleRoute(path, 0.25)?.position).toEqual({ x: 0.5, y: 0 });
    expect(sampleRoute(path, 0.75)?.position).toEqual({ x: 1, y: 0.5 });
    expect(sampleRoute(path, -1)?.position).toEqual(path[0]);
    expect(sampleRoute(path, 2)?.position).toEqual(path[2]);
    expect(path).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]);
  });

  it('finishes playback without changing game unit state and supports reduced motion', () => {
    const ctx = { setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn() };
    const canvas = { getContext: () => ctx, clientWidth: 100, clientHeight: 100 } as unknown as HTMLCanvasElement;
    const renderer = new SceneRenderer(canvas, {} as SpriteStore);
    const unit = { uid: 1, x: 1, y: 1, owner: 0, id: 'INFANTRY', sprites: [], hasMoved: true };
    renderer.liveUnits = [unit];
    expect(renderer.animateMove(1, path, undefined, 0)).toBe(220);
    expect(renderer.isAnimating).toBe(true);
    renderer.render(221);
    expect(renderer.isAnimating).toBe(false);
    expect(renderer.liveUnits).toEqual([unit]);
    renderer.reducedMotion = true;
    expect(renderer.animateMove(1, path, undefined, 0)).toBe(0);
    expect(renderer.isAnimating).toBe(false);
    renderer.addEffect(1, 1, 'TRAP!', '#fff', 200, 0);
    renderer.render(899);
    expect(renderer.isAnimating).toBe(true);
    renderer.render(900);
    expect(renderer.isAnimating).toBe(false);
  });

  it('clears pending motion and effects together when resetting presentation', () => {
    const canvas = { getContext: () => ({}), clientWidth: 100, clientHeight: 100 } as unknown as HTMLCanvasElement;
    const renderer = new SceneRenderer(canvas, {} as SpriteStore);
    renderer.animateMove(2, path, { uid: 2, x: 0, y: 0, owner: 0, id: 'INFANTRY', sprites: [], hasMoved: false }, 0);
    renderer.addEffect(1, 1, '-3', '#fff', 200, 0);
    expect(renderer.isAnimating).toBe(true);
    renderer.clearAnimations();
    expect(renderer.isAnimating).toBe(false);
  });

  it('handles empty routes and caps long movement playback', () => {
    expect(sampleRoute([], 0)).toBeNull();
    expect(movementDuration([])).toBe(0);
    expect(movementDuration([path[0]])).toBe(0);
    expect(movementDuration(path)).toBe(220);
    expect(movementDuration(Array.from({ length: 100 }, (_, x) => ({ x, y: 0 })))).toBe(1000);
  });

  it('does not expose movement on fogged, shrouded, or out-of-bounds tiles', () => {
    const fog = new Uint8Array([2, 1, 0]);
    expect(visibleMotionTile({ x: 0, y: 0 }, fog, 3)).toBe(true);
    expect(visibleMotionTile({ x: 1, y: 0 }, fog, 3)).toBe(false);
    expect(visibleMotionTile({ x: 2, y: 0 }, fog, 3)).toBe(false);
    expect(visibleMotionTile({ x: 3, y: 0 }, fog, 3)).toBe(false);
    expect(visibleMotionTile({ x: 1, y: 0 }, null, 3)).toBe(true);
  });
});
