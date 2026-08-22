/** Pan/zoom camera over map space, in CSS pixels. */
export interface Viewport { width: number; height: number; }

export class Camera {
  /** Map-space coordinate drawn at the viewport centre. */
  x = 0;
  y = 0;
  scale = 3;
  minScale = 1;
  maxScale = 12;

  // Written out rather than declared as a constructor parameter property:
  // plain `node` type stripping erases the annotation but cannot generate the
  // assignment it implies, so the field would silently stay undefined.
  private viewport: Viewport;

  constructor(viewport: Viewport) {
    this.viewport = viewport;
  }

  setViewport(viewport: Viewport): void { this.viewport = viewport; }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return {
      x: (wx - this.x) * this.scale + this.viewport.width / 2,
      y: (wy - this.y) * this.scale + this.viewport.height / 2,
    };
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.viewport.width / 2) / this.scale + this.x,
      y: (sy - this.viewport.height / 2) / this.scale + this.y,
    };
  }

  /** Zooms while keeping the map point under `screen` stationary. */
  zoomAt(screenX: number, screenY: number, factor: number): void {
    const before = this.screenToWorld(screenX, screenY);
    this.scale = clamp(this.scale * factor, this.minScale, this.maxScale);
    const after = this.screenToWorld(screenX, screenY);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  panBy(screenDx: number, screenDy: number): void {
    this.x -= screenDx / this.scale;
    this.y -= screenDy / this.scale;
  }

  /**
   * Keeps the board filling the screen.
   *
   * Along an axis where the map is smaller than the viewport it is centred; on
   * a larger one the camera is held inside the map's bounds. Without the second
   * rule, centring on a corner unit — which is exactly what the next-unit cycle
   * does — leaves most of the screen showing empty space beyond the edge.
   */
  clampTo(worldWidth: number, worldHeight: number): void {
    const visibleWidth = this.viewport.width / this.scale;
    const visibleHeight = this.viewport.height / this.scale;

    this.x = worldWidth <= visibleWidth
      ? worldWidth / 2
      : clamp(this.x, visibleWidth / 2, worldWidth - visibleWidth / 2);

    this.y = worldHeight <= visibleHeight
      ? worldHeight / 2
      : clamp(this.y, visibleHeight / 2, worldHeight - visibleHeight / 2);
  }

  /**
   * Smallest scale `fit` will choose.
   *
   * Fitting a 70x40 map into a phone-sized viewport wants a scale near 1, which
   * makes each tile 16 CSS pixels — about 4mm, far too small to hit with a
   * thumb, and half a tile is already past the drag threshold so taps turn into
   * pans. Big maps therefore start zoomed in and pannable rather than fully
   * visible; `minScale` still allows pinching out to an overview deliberately.
   */
  minFitScale = 2.5;

  /** Scale at which the whole map fits, with padding. */
  fitScale(worldWidth: number, worldHeight: number, padding = 24): number {
    const sx = (this.viewport.width - padding) / worldWidth;
    const sy = (this.viewport.height - padding) / worldHeight;
    return clamp(Math.min(sx, sy), this.minScale, this.maxScale);
  }

  /** Frames the map at a scale that is still comfortable to touch. */
  fit(worldWidth: number, worldHeight: number, padding = 24): void {
    const fitted = this.fitScale(worldWidth, worldHeight, padding);
    this.scale = clamp(Math.max(fitted, this.minFitScale), this.minScale, this.maxScale);
    this.x = worldWidth / 2;
    this.y = worldHeight / 2;
  }
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
