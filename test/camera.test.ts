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

  it('centres on the map when fitting', () => {
    const camera = new Camera(viewport);
    camera.fit(30 * 16, 20 * 16);
    expect(camera.x).toBeCloseTo(240, 6);
    expect(camera.y).toBeCloseTo(160, 6);
  });

  it('shows a small map whole', () => {
    const camera = new Camera(viewport);
    // A 10x10 board fits comfortably, so nothing is clipped.
    camera.fit(10 * 16, 10 * 16);
    expect(10 * 16 * camera.scale).toBeLessThanOrEqual(viewport.width);
    expect(10 * 16 * camera.scale).toBeLessThanOrEqual(viewport.height);
  });

  it('never fits so far out that tiles become untappable', () => {
    const camera = new Camera(viewport);
    // A 70x40 map would otherwise fit at scale ~1, making each tile 16 CSS px —
    // roughly 4mm on a tablet, and less than two drag thresholds wide, so taps
    // turn into pans. Big maps start zoomed in and pannable instead.
    camera.fit(70 * 16, 40 * 16);
    expect(camera.scale).toBeGreaterThanOrEqual(camera.minFitScale);
    expect(16 * camera.scale).toBeGreaterThanOrEqual(32);
  });

  it('still allows pinching out past the fit floor', () => {
    const camera = new Camera(viewport);
    camera.fit(70 * 16, 40 * 16);
    for (let i = 0; i < 20; i++) camera.zoomAt(400, 300, 0.7);
    expect(camera.scale).toBe(camera.minScale);
    expect(camera.minScale).toBeLessThan(camera.minFitScale);
  });

  it('holds the camera inside a map larger than the viewport', () => {
    const camera = new Camera(viewport);
    camera.scale = 4;                       // 200x150 world units visible
    const world = { w: 2000, h: 1500 };
    camera.x = 100_000; camera.y = -100_000;
    camera.clampTo(world.w, world.h);

    // The visible rectangle must lie entirely within the board — no void.
    expect(camera.x - 100).toBeGreaterThanOrEqual(0);
    expect(camera.x + 100).toBeLessThanOrEqual(world.w);
    expect(camera.y - 75).toBeGreaterThanOrEqual(0);
    expect(camera.y + 75).toBeLessThanOrEqual(world.h);
  });

  it('centres a map smaller than the viewport instead of letting it drift', () => {
    const camera = new Camera(viewport);
    camera.scale = 8;                       // 100x75 world units visible
    camera.x = 5000; camera.y = -5000;
    camera.clampTo(60, 50);                 // smaller than the view on both axes
    expect(camera.x).toBeCloseTo(30, 6);
    expect(camera.y).toBeCloseTo(25, 6);
  });

  it('clamps and centres independently per axis', () => {
    const camera = new Camera(viewport);
    camera.scale = 8;                       // 100x75 world units visible
    camera.x = 5000; camera.y = -5000;
    camera.clampTo(300, 50);                // wide board, short board
    expect(camera.x).toBeCloseTo(250, 6);   // held inside: 300 - 100/2
    expect(camera.y).toBeCloseTo(25, 6);    // centred
  });
});
