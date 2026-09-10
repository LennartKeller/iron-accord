import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PointerControls } from '../src/input/pointer.ts';
import { Camera } from '../src/render/camera.ts';

class PointerSurface extends EventTarget {
  style = { touchAction: '' };
  captures = new Set<number>();
  getBoundingClientRect() { return { left: 10, top: 20 }; }
  setPointerCapture(id: number) { this.captures.add(id); }
  hasPointerCapture(id: number) { return this.captures.has(id); }
  releasePointerCapture(id: number) { this.captures.delete(id); }
  pointer(type: string, id: number, x: number, y: number, button = 0) {
    const event = new Event(type);
    Object.assign(event, { pointerId: id, clientX: x + 10, clientY: y + 20, button, pointerType: 'touch' });
    this.dispatchEvent(event);
  }
}

describe('pointer gestures', () => {
  let surface: PointerSurface;
  let camera: Camera;
  let controls: PointerControls;
  let onTap: ReturnType<typeof vi.fn>;
  let onLongPress: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    surface = new PointerSurface();
    camera = new Camera({ width: 800, height: 600 });
    onTap = vi.fn();
    onLongPress = vi.fn();
    controls = new PointerControls(surface as unknown as HTMLElement, camera, { onTap, onLongPress });
  });
  afterEach(() => {
    controls.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('taps at the local release position', () => {
    surface.pointer('pointerdown', 1, 100, 100);
    surface.pointer('pointerup', 1, 102, 103);
    expect(onTap).toHaveBeenCalledWith(102, 103);
  });

  it.each(['pointercancel', 'pointerleave', 'lostpointercapture'])('does not tap after %s', type => {
    surface.pointer('pointerdown', 1, 100, 100);
    surface.pointer(type, 1, 100, 100);
    vi.advanceTimersByTime(600);
    surface.pointer('pointerup', 1, 100, 100);
    expect(onTap).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('does not tap after a handled long press', () => {
    surface.pointer('pointerdown', 1, 100, 100);
    vi.advanceTimersByTime(600);
    surface.pointer('pointerup', 1, 100, 100);
    expect(onLongPress).toHaveBeenCalledOnce();
    expect(onTap).not.toHaveBeenCalled();
  });

  it('does not tap after two fingers even when the last finger stayed still', () => {
    surface.pointer('pointerdown', 1, 100, 100);
    surface.pointer('pointerdown', 2, 200, 100);
    surface.pointer('pointermove', 1, 80, 100);
    surface.pointer('pointerup', 1, 80, 100);
    surface.pointer('pointerup', 2, 200, 100);
    expect(onTap).not.toHaveBeenCalled();
  });

  it('keeps the world point under a moving pinch midpoint attached to it', () => {
    surface.pointer('pointerdown', 1, 100, 100);
    surface.pointer('pointerdown', 2, 200, 100);
    const anchor = camera.screenToWorld(150, 100);
    surface.pointer('pointermove', 2, 300, 100);
    const screen = camera.worldToScreen(anchor.x, anchor.y);
    expect(screen.x).toBeCloseTo(200);
    expect(screen.y).toBeCloseTo(100);
  });

  it('does not tap when release moved past the threshold without a move event', () => {
    surface.pointer('pointerdown', 1, 100, 100);
    surface.pointer('pointerup', 1, 140, 100);
    expect(onTap).not.toHaveBeenCalled();
  });

  it('ignores secondary buttons', () => {
    surface.pointer('pointerdown', 1, 100, 100, 2);
    vi.advanceTimersByTime(600);
    surface.pointer('pointerup', 1, 100, 100, 2);
    expect(onTap).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('releases active captures and timers when disposed', () => {
    surface.pointer('pointerdown', 1, 100, 100);
    controls.dispose();
    vi.advanceTimersByTime(600);
    expect(surface.captures.size).toBe(0);
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
