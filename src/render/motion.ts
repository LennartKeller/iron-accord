export interface MotionPoint { x: number; y: number }

/** Bound long routes so watching a turn stays responsive. */
export function movementDuration(path: readonly MotionPoint[]): number {
  return Math.min(1000, Math.max(0, path.length - 1) * 110);
}

/** Linear tile interpolation preserves corners instead of cutting across terrain. */
export function sampleRoute(path: readonly MotionPoint[], progress: number): {
  position: MotionPoint; from: MotionPoint; to: MotionPoint;
} | null {
  if (!path.length) return null;
  const distance = Math.max(0, Math.min(1, progress)) * (path.length - 1);
  const index = Math.min(Math.floor(distance), path.length - 1);
  const from = path[index];
  const to = path[Math.min(index + 1, path.length - 1)];
  const fraction = distance - index;
  return { position: { x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction }, from, to };
}

export function visibleMotionTile(point: MotionPoint, fog: Uint8Array | null, width: number): boolean {
  return !fog || (point.x >= 0 && point.x < width && point.y >= 0
    && fog[point.y * width + point.x] === 2);
}
