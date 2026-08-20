/**
 * Free functions Commander Wars scripts expect on the sandbox global,
 * registered by Interpreter in coreengine/interpreter.cpp.
 */

export interface Rng {
  next(): number;
  /** Restarts the stream. Episodes must be able to reproduce exactly. */
  reseed(seed: number): void;
  /**
   * Position in the stream, so a caller can rewind it.
   *
   * A search agent simulates attacks to decide what to play, and every
   * simulated attack rolls luck. Without rewinding, merely *thinking* about a
   * line would consume the randomness the real game was going to use, so the
   * board would evolve differently depending on how hard the AI thought.
   */
  getState(): number;
  setState(state: number): void;
}

/** Deterministic PRNG so replays and tests reproduce exactly. */
export class Mulberry32 implements Rng {
  private state: number;
  private readonly initialSeed: number;
  constructor(seed = 0x9e3779b9) {
    this.initialSeed = seed >>> 0;
    this.state = this.initialSeed;
  }
  reseed(seed: number = this.initialSeed): void { this.state = seed >>> 0; }
  getState(): number { return this.state; }
  setState(state: number): void { this.state = state >>> 0; }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

export function makeGlobals(rng: Rng) {
  return {
    randInt: (min: number, max: number) => min + Math.floor(rng.next() * (max - min + 1)),
    randIntBase: (min: number, max: number) => min + Math.floor(rng.next() * (max - min + 1)),
    getSeed: () => 0,
    isEven: (value: number) => value % 2 === 0,
    roundUp: (value: number) => Math.ceil(value),
    roundDown: (value: number) => Math.floor(value),
    /**
     * coreengine/globalutils.cpp: GlobalUtils::getCircle — every offset whose
     * manhattan distance falls within [min, max]. Weapon ranges are built from
     * this, so it must include the ring bounds.
     */
    getEmptyPointArray: () => new PointVector([]),
    getDistance: (a: QPoint | number, b: QPoint | number, c?: number, d?: number) => {
      if (typeof a === 'number') return Math.abs(a - (b as number)) + Math.abs((c ?? 0) - (d ?? 0));
      const p1 = a as QPoint, p2 = b as QPoint;
      return Math.abs(p1.x - p2.x) + Math.abs(p1.y - p2.y);
    },
    /**
     * coreengine/globalutils.cpp: GlobalUtils::getShotFields — a firing cone in
     * one direction, used by the directional cannon buildings.
     */
    getShotFields: (min: number, max: number, xDirection = 0, yDirection = 0) => {
      const points: QPoint[] = [];
      for (let x = -max; x <= max; x++) {
        for (let y = -max; y <= max; y++) {
          const distance = Math.abs(x) + Math.abs(y);
          if (distance < min || distance > max) continue;
          if (xDirection > 0 && x < 0) continue;
          if (xDirection < 0 && x > 0) continue;
          if (yDirection > 0 && y < 0) continue;
          if (yDirection < 0 && y > 0) continue;
          points.push({ x, y });
        }
      }
      return new PointVector(points);
    },
    getCircle: (min: number, max: number) => {
      const points: QPoint[] = [];
      for (let x = -max; x <= max; x++) {
        for (let y = -max; y <= max; y++) {
          const distance = Math.abs(x) + Math.abs(y);
          if (distance >= min && distance <= max) points.push({ x, y });
        }
      }
      return new PointVector(points);
    },
  };
}

/** Minimal QmlVectorPoint stand-in for the point lists scripts iterate. */
export class PointVector {
  private readonly points: QPoint[];
  constructor(points: QPoint[]) { this.points = points; }
  size(): number { return this.points.length; }
  at(index: number): QPoint { return this.points[index]; }
  append(point: QPoint): void { this.points.push(point); }
  remove(index: number): void { this.points.splice(index, 1); }
}

export interface QPoint { x: number; y: number; }

export interface QRect { x: number; y: number; width: number; height: number; }

export const Qt = {
  point: (x: number, y: number): QPoint => ({ x, y }),
  /**
   * ACTION_FIRE packs a battle result into a rect: (x, y) is the attacker's
   * damage and weapon index, (width, height) the defender's counter.
   */
  rect: (x: number, y: number, width: number, height: number): QRect => ({ x, y, width, height }),
};

/** Translation hook; scripts call qsTr() for display strings. */
export const qsTr = (text: string): string => text;

/**
 * Animation surface.
 *
 * Pass an AnimationRunner to get one that records end-of-animation callbacks so
 * actions like capture actually complete; without one the animations are inert,
 * which is fine for anything that only reads data (damage tables, sprite ids).
 */
export function makeAnimationStubs(runner?: { factory(): unknown }) {
  const inert = (): any => new Proxy({}, { get: () => () => inert() });
  return {
    GameAnimationFactory: runner
      ? runner.factory()
      : new Proxy({}, { get: () => () => inert() }),
    audio: { playSound() {}, stopSound() {} },
    GameConsole: new Proxy({}, { get: () => () => {} }),
  };
}
