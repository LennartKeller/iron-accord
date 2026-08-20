import type { Evaluator, ScriptRegistry } from './types.ts';
import type { Parse } from './repair.ts';

/**
 * Browser evaluator. A hidden same-origin iframe is the browser's equivalent of
 * `vm.createContext`: its `contentWindow` is a fresh global object, so a script's
 * top-level `var INFANTRY = ...` lands there rather than on the app's `window`,
 * and code evaluated through it runs in sloppy mode.
 *
 * Using the iframe (rather than indirect eval on the host window) keeps ~700
 * script globals out of the application's own namespace.
 */
export class BrowserEvaluator implements Evaluator {
  readonly global: ScriptRegistry;
  private readonly frame: HTMLIFrameElement;

  constructor(hostGlobals: Record<string, unknown>) {
    this.frame = document.createElement('iframe');
    this.frame.setAttribute('aria-hidden', 'true');
    this.frame.style.display = 'none';
    document.body.appendChild(this.frame);

    const win = this.frame.contentWindow as (Window & ScriptRegistry) | null;
    if (!win) throw new Error('BrowserEvaluator: iframe has no contentWindow');

    for (const [key, value] of Object.entries(hostGlobals)) win[key] = value;
    this.global = win as unknown as ScriptRegistry;
  }

  evaluate(source: string, filename: string): void {
    const win = this.frame.contentWindow as (Window & { eval(s: string): unknown }) | null;
    if (!win) throw new Error('BrowserEvaluator: iframe detached');
    // Indirect-style eval through the frame's own global keeps `var` bindings
    // on that global and preserves sloppy mode.
    win.eval(`${source}\n//# sourceURL=cw/${filename}`);
  }

  /** Browsers surface the same "Invalid shorthand property initializer" message. */
  static parse: Parse = (source, filename) => {
    // eslint-disable-next-line no-new-func
    new Function(`${source}\n//# sourceURL=cw/${filename}`);
  };

  dispose(): void {
    this.frame.remove();
  }
}
