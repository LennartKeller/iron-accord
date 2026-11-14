import type { ScriptRegistry } from '../scripts/types.ts';
import { requestSound } from './sound.ts';

/** Where `attach` parks the runner so `Game` can find it without being told. */
export const ANIMATION_RUNNER_KEY = '__ironAccordAnimationRunner';

/**
 * Stand-in for Commander Wars' animation system.
 *
 * The important part is not the visuals — it is that several actions do their
 * real work in a callback. ACTION_CAPTURE, for example, only transfers the
 * building inside `performPostAnimation`, which the engine invokes when the
 * capture animation ends:
 *
 *     animation.setEndOfAnimationCall("ACTION_CAPTURE", "performPostAnimation");
 *
 * So a stub that silently swallows those calls would leave capture and combat
 * doing nothing at all. This records them instead and `flush()` runs them, which
 * makes the actions complete synchronously.
 */
export interface PendingCallback {
  object: string;
  method: string;
  animation: FakeAnimation;
}

export class FakeAnimation {
  readonly runner: AnimationRunner;
  private data: Array<number | string> = [];
  private readCursor = 0;

  constructor(runner: AnimationRunner) {
    this.runner = runner;
  }

  setEndOfAnimationCall(object: string, method: string): void {
    this.runner.enqueue({ object, method, animation: this });
  }

  // Data slots: scripts stash a few numbers on an animation and read them back
  // inside the callback.
  writeDataInt32(value: number): void { this.data.push(value); }
  writeDataString(value: string): void { this.data.push(value); }
  writeDataFloat(value: number): void { this.data.push(value); }
  startReading(): void { this.readCursor = 0; }
  /**
   * Rewinds the read cursor. This one matters: the presentation proxy would
   * otherwise absorb it and return 0, so an animation whose buffer is read a
   * second time would silently read shifted values with no error at all.
   */
  seekBuffer(): void { this.readCursor = 0; }
  readDataInt32(): number { return Number(this.data[this.readCursor++] ?? 0); }
  readDataString(): string { return String(this.data[this.readCursor++] ?? ''); }
  readDataFloat(): number { return Number(this.data[this.readCursor++] ?? 0); }

  queueAnimation(next: FakeAnimation): FakeAnimation { return next; }

  // The one part of an animation's presentation that is not visual: scripts
  // name the sound that goes with it. See src/host/sound.ts for who hears it.
  setSound(file: unknown): void { requestSound(file); }
  addSound(file: unknown): void { requestSound(file); }

  /**
   * Work the engine does when this animation ends, before its end-of-animation
   * call. Only a walk has any; see AnimationRunner.createWalk.
   */
  onFinished: (() => void) | null = null;
}

/** The slice of a unit a finished walk needs; kept structural to avoid an import cycle. */
interface WalkingUnit {
  x: number;
  y: number;
  getHp(): number;
  map: { units: unknown[]; onMap(x: number, y: number): boolean; getUnitAt(x: number, y: number): unknown };
}

/**
 * Presentation calls (addSprite, addText, addSound, tweens…) are numerous and
 * vary per script, so unknown methods answer with 0 rather than throwing. A
 * throw here would abandon an action halfway — several scripts use an
 * animation's return value in arithmetic, hence 0 rather than undefined.
 */
function withPresentationStubs(animation: FakeAnimation): FakeAnimation {
  return new Proxy(animation, {
    get(target, property, receiver) {
      const existing = Reflect.get(target, property, receiver);
      if (existing !== undefined) {
        return typeof existing === 'function' ? existing.bind(target) : existing;
      }
      if (typeof property === 'symbol') return undefined;
      return () => 0;
    },
  });
}

export class AnimationRunner {
  private registry: ScriptRegistry | null = null;
  private pending: PendingCallback[] = [];
  private running = false;

  /**
   * Binds the runner to a registry, and records it there under a well-known key.
   *
   * The back-reference is what lets `Game` default to the runner the scripts are
   * already wired to. Without it, constructing a Game and forgetting to pass one
   * produces a game where every action that finishes in a callback -- capture
   * above all -- silently does nothing, which looks like an AI that will not
   * take ground rather than like a missing argument.
   */
  attach(registry: ScriptRegistry): void {
    this.registry = registry;
    (registry as ScriptRegistry & { [ANIMATION_RUNNER_KEY]?: AnimationRunner })[ANIMATION_RUNNER_KEY] = this;
  }

  enqueue(callback: PendingCallback): void { this.pending.push(callback); }

  private readonly created: FakeAnimation[] = [];
  private walks: FakeAnimation[] = [];

  /**
   * game/gameanimation/gameanimationwalk.cpp: GameAnimationWalk::onFinished.
   *
   * When a walk ends the engine puts the unit on the last tile of the route it
   * was created with, provided that tile is empty. For an ordinary move this
   * is a no-op, because Unit::moveUnit already relocated the unit. It is NOT a
   * no-op for an ambush stopped after a single step: ActionPerformer::doTrapping
   * hands ACTION_TRAP a route without the starting tile, so that route has one
   * point, Unit::moveUnit (which only acts on more than one) leaves the unit
   * where it was, and this is the only thing that moves it. Dropping it left an
   * ambushed unit one tile short, and the next unit sent to that tile stacked
   * on top of it.
   *
   * It bypasses Unit::moveUnitToField, as upstream does, so capture progress is
   * not reset by it.
   */
  createWalk(unit: unknown, destination: { x: number; y: number } | null): FakeAnimation {
    const animation = this.create();
    const walker = unit as WalkingUnit | null;
    if (walker && destination) {
      const target = { ...destination };
      animation.onFinished = () => {
        const { map } = walker;
        if (!map.units.includes(walker) || walker.getHp() <= 0) return;
        if (!map.onMap(target.x, target.y) || map.getUnitAt(target.x, target.y)) return;
        walker.x = target.x;
        walker.y = target.y;
      };
      this.walks.push(animation);
    }
    return animation;
  }

  /** Walks come first in the engine's queue, so they end before any callback runs. */
  private finishWalks(): void {
    const walks = this.walks;
    this.walks = [];
    for (const walk of walks) {
      try { walk.onFinished?.(); }
      catch (error) { console.warn('walk animation end failed', error); }
    }
  }

  create(): FakeAnimation {
    const animation = withPresentationStubs(new FakeAnimation(this));
    this.created.push(animation);
    return animation;
  }

  /**
   * Runs every queued callback. Callbacks can queue further animations (a
   * capture chains into its own post-animation), so this drains until empty
   * with a bound to keep a misbehaving script from looping forever.
   */
  flush(map: unknown): void {
    if (this.running) return;   // callbacks that flush re-entrantly
    this.running = true;
    try {
      this.finishWalks();
      for (let guard = 0; guard < 256 && this.pending.length > 0; guard++) {
        const callbacks = this.pending;
        this.pending = [];
        for (const callback of callbacks) {
          const target = this.registry?.[callback.object];
          const fn = target?.[callback.method];
          if (typeof fn !== 'function') continue;
          try {
            fn.call(target, callback.animation, map);
          } catch (error) {
            console.warn(`animation callback ${callback.object}.${callback.method} failed`, error);
          }
        }
        // A callback may itself have started a walk.
        this.finishWalks();
      }
    } finally {
      this.running = false;
      this.pending = [];
      this.walks = [];
    }
  }

  /**
   * The `GameAnimationFactory` global. Most members create an animation, but a
   * couple query the queue — scripts chain onto the previously created one.
   */
  factory(): Record<string, (...args: unknown[]) => unknown> {
    const self = this;
    return new Proxy({}, {
      get(_target, property) {
        if (property === 'getAnimationCount') return () => self.created.length;
        if (property === 'getAnimation') return (index: number) => self.created[index] ?? self.create();
        if (property === 'createWalkingAnimation') {
          // (map, unit, action): the route is the action's, read when the walk is created.
          return (_map: unknown, unit: unknown, action: { getActionTarget?(): { x: number; y: number } } | null) =>
            self.createWalk(unit, action?.getActionTarget?.() ?? null);
        }
        if (property === 'createWalkingAnimationV2') {
          // (map, unit, movePath): a route handed over directly, in the host's
          // start-first order, so its last point is where the walk ends.
          return (_map: unknown, unit: unknown, movePath: Array<{ x: number; y: number }> | null) =>
            self.createWalk(unit, Array.isArray(movePath) ? movePath[movePath.length - 1] ?? null : null);
        }
        return () => self.create();
      },
    }) as Record<string, (...args: unknown[]) => unknown>;
  }

  /** Drops animations kept only so scripts can chain onto them. */
  clearCreated(): void { this.created.length = 0; }
}
