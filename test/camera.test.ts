import { describe, it, expect } from 'vitest';
import { Camera } from '../src/render/camera.ts';

const viewport = { width: 800, height: 600 };

describe('Camera', () => {
  it('round-trips screen and world coordinates', () => {
    const camera = new Camera(viewport);
    camera.x = 120; camera.y = 80; camera.scale = 3;
    for (const [sx, sy] of [[0, 0], [400, 300], [799, 599]] as Array<[number, number]>) {
      const world = camera.screenToWorld(sx, sy);
      const back = camera.worldToScreen(world.x, world.y);
      expect(back.x).toBeCloseTo(sx, 6);
      expect(back.y).toBeCloseTo(sy, 6);
    }
  });

  it('draws the camera centre at the viewport centre', () => {
    const camera = new Camera(viewport);
    camera.x = 50; camera.y = 25;
    const centre = camera.worldToScreen(50, 25);
    expect(centre.x).toBeCloseTo(400, 6);
    expect(centre.y).toBeCloseTo(300, 6);
  });

  it('keeps the point under the cursor fixed while zooming', () => {
    const camera = new Camera(viewport);
    camera.x = 100; camera.y = 100; camera.scale = 2;
    const anchor = { x: 610, y: 130 };
    const before = camera.screenToWorld(anchor.x, anchor.y);
    camera.zoomAt(anchor.x, anchor.y, 1.75);
    const after = camera.screenToWorld(anchor.x, anchor.y);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('clamps zoom to its configured range', () => {
    const camera = new Camera(viewport);
    for (let i = 0; i < 50; i++) camera.zoomAt(400, 300, 2);
    expect(camera.scale).toBe(camera.maxScale);
    for (let i = 0; i < 50; i++) camera.zoomAt(400, 300, 0.5);
    expect(camera.scale).toBe(camera.minScale);
  });

  it('pans by screen distance divided by scale', () => {
    const camera = new Camera(viewport);
    camera.x = 0; camera.y = 0; camera.scale = 4;
    camera.panBy(40, -20);
    expect(camera.x).toBeCloseTo(-10, 6);
    expect(camera.y).toBeCloseTo(5, 6);
  });

  it('fits a map inside the viewport', () => {
    const camera = new Camera(viewport);
    camera.fit(30 * 16, 20 * 16);
    expect(camera.x).toBeCloseTo(240, 6);
    expect(camera.y).toBeCloseTo(160, 6);
    // The whole map must be on screen at the fitted scale.
    expect(30 * 16 * camera.scale).toBeLessThanOrEqual(viewport.width);
    expect(20 * 16 * camera.scale).toBeLessThanOrEqual(viewport.height);
  });

  it('clamps panning to near the map bounds', () => {
    const camera = new Camera(viewport);
    camera.scale = 8;
    camera.x = 100_000; camera.y = -100_000;
    camera.clampTo(480, 320);
    expect(camera.x).toBeLessThanOrEqual(480 + 240);
    expect(camera.y).toBeGreaterThanOrEqual(-160);
  });
});
