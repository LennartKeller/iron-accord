import type { Camera } from '../render/camera.ts';

/**
 * Unified pointer input for touch, mouse and pen.
 *
 * Pointer Events give one code path for all three; the only real work is
 * telling a tap apart from a drag, and tracking two fingers for pinch-zoom.
 */
export interface PointerControlOptions {
  /** A tap that never exceeded the drag threshold. */
  onTap?(screenX: number, screenY: number): void;
  onLongPress?(screenX: number, screenY: number): void;
  onChange?(): void;
  /**
   * Pointer moved with nothing pressed. Fires for mouse and pen only — touch
   * has no hover state, so anything behind this must also be reachable by tap.
   */
  onHover?(screenX: number, screenY: number): void;
  /** Movement in CSS px before a gesture stops counting as a tap. */
  dragThreshold?: number;
  longPressMs?: number;
}

interface TrackedPointer {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  moved: boolean;
}

export class PointerControls {
  private readonly pointers = new Map<number, TrackedPointer>();
  private pinchDistance = 0;
  private longPressTimer: number | null = null;
  private readonly dragThreshold: number;
  private readonly longPressMs: number;
  private disposed = false;

  // Written out rather than declared as constructor parameter properties:
  // plain `node` type stripping erases the annotations but cannot generate the
  // assignments they imply, so the fields would silently stay undefined.
  private readonly element: HTMLElement;
  private readonly camera: Camera;
  private readonly options: PointerControlOptions;

  constructor(element: HTMLElement, camera: Camera, options: PointerControlOptions = {}) {
    this.element = element;
    this.camera = camera;
    this.options = options;
    this.dragThreshold = options.dragThreshold ?? 8;
    this.longPressMs = options.longPressMs ?? 500;

    element.style.touchAction = 'none';
    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('pointercancel', this.onPointerUp);
    element.addEventListener('pointerleave', this.onPointerUp);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    element.addEventListener('contextmenu', this.onContextMenu);
  }

  dispose(): void {
    this.disposed = true;
    this.clearLongPress();
    const { element } = this;
    element.removeEventListener('pointerdown', this.onPointerDown);
    element.removeEventListener('pointermove', this.onPointerMove);
    element.removeEventListener('pointerup', this.onPointerUp);
    element.removeEventListener('pointercancel', this.onPointerUp);
    element.removeEventListener('pointerleave', this.onPointerUp);
    element.removeEventListener('wheel', this.onWheel);
    element.removeEventListener('contextmenu', this.onContextMenu);
  }

  private local(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private changed(): void { this.options.onChange?.(); }

  private clearLongPress(): void {
    if (this.longPressTimer !== null) {
      window.clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  private readonly onContextMenu = (event: Event): void => {
    // Long-press on touch would otherwise raise the context menu mid-gesture.
    event.preventDefault();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.element.setPointerCapture(event.pointerId);
    const { x, y } = this.local(event);
    this.pointers.set(event.pointerId, { id: event.pointerId, x, y, startX: x, startY: y, moved: false });

    if (this.pointers.size === 1) {
      this.clearLongPress();
      this.longPressTimer = window.setTimeout(() => {
        const pointer = this.pointers.get(event.pointerId);
        if (pointer && !pointer.moved) this.options.onLongPress?.(pointer.x, pointer.y);
      }, this.longPressMs);
    } else {
      this.clearLongPress();
    }

    if (this.pointers.size === 2) this.pinchDistance = this.currentPinchDistance();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) {
      // Not a drag: a mouse or pen hovering.
      if (event.pointerType !== 'touch') {
        const { x, y } = this.local(event);
        this.options.onHover?.(x, y);
      }
      return;
    }
    const { x, y } = this.local(event);
    const dx = x - pointer.x;
    const dy = y - pointer.y;
    pointer.x = x;
    pointer.y = y;

    if (Math.hypot(x - pointer.startX, y - pointer.startY) > this.dragThreshold) {
      if (!pointer.moved) this.clearLongPress();
      pointer.moved = true;
    }

    if (this.pointers.size === 1) {
      if (pointer.moved) {
        this.camera.panBy(dx, dy);
        this.changed();
      }
      return;
    }

    if (this.pointers.size === 2) {
      const distance = this.currentPinchDistance();
      const centre = this.pinchCentre();
      if (this.pinchDistance > 0 && distance > 0) {
        this.camera.zoomAt(centre.x, centre.y, distance / this.pinchDistance);
      }
      this.pinchDistance = distance;
      // Both fingers moving together still pans.
      this.camera.panBy(dx / 2, dy / 2);
      this.changed();
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    this.pointers.delete(event.pointerId);
    this.clearLongPress();
    if (this.element.hasPointerCapture?.(event.pointerId)) {
      this.element.releasePointerCapture(event.pointerId);
    }

    // A tap is a single pointer that never crossed the drag threshold.
    if (!pointer.moved && this.pointers.size === 0 && !this.disposed) {
      this.options.onTap?.(pointer.x, pointer.y);
    }
    if (this.pointers.size < 2) this.pinchDistance = 0;
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const { x, y } = this.local(event);
    // Trackpads emit many small deltas; exponential mapping keeps them smooth.
    const factor = Math.exp(-event.deltaY * 0.0015);
    this.camera.zoomAt(x, y, factor);
    this.changed();
  };

  private points(): TrackedPointer[] { return [...this.pointers.values()]; }

  private currentPinchDistance(): number {
    const [a, b] = this.points();
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  private pinchCentre(): { x: number; y: number } {
    const [a, b] = this.points();
    if (!a || !b) return { x: 0, y: 0 };
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
}
