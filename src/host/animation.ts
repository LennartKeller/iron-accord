import type { ScriptRegistry } from '../scripts/types.ts';

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
      }
    } finally {
      this.running = false;
      this.pending = [];
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
        return () => self.create();
      },
    }) as Record<string, (...args: unknown[]) => unknown>;
  }

  /** Drops animations kept only so scripts can chain onto them. */
  clearCreated(): void { this.created.length = 0; }
}
