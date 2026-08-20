import { BrowserEvaluator } from '../scripts/evaluator-browser.ts';
import { loadScripts, type LoadReport } from '../scripts/loader.ts';
import type { ScriptRegistry } from '../scripts/types.ts';
import {
  GameEnums, Qt, qsTr, makeGlobals, makeAnimationStubs, Mulberry32, AnimationRunner,
} from '../host/index.ts';

/** The bundle tools/build-data.ts writes to data/scripts.json. */
export interface ScriptBundle {
  order: string[];
  sources: Record<string, string>;
}

export interface BrowserBoot {
  registry: ScriptRegistry;
  report: LoadReport;
  animations: AnimationRunner;
  rng: Mulberry32;
}

/**
 * Boots the Commander Wars script layer in a browser.
 *
 * The scripts arrive pre-repaired and in load order, so this is just: build a
 * sandbox with the host globals, evaluate, hand back the registry. The sandbox
 * is a hidden iframe, whose `contentWindow` is a fresh sloppy-mode global — the
 * browser's equivalent of Node's `vm.createContext`, and what keeps ~700 script
 * globals out of the application's own `window`.
 */
export async function bootstrapBrowser(bundleUrl = '/scripts.json', seed = 0xC0FFEE): Promise<BrowserBoot> {
  const response = await fetch(bundleUrl);
  if (!response.ok) throw new Error(`could not load ${bundleUrl}: ${response.status}`);
  const bundle: ScriptBundle = await response.json();

  const rng = new Mulberry32(seed);
  const animations = new AnimationRunner();
  const evaluator = new BrowserEvaluator({
    GameEnums,
    Qt,
    qsTr,
    globals: makeGlobals(rng),
    ...makeAnimationStubs(animations),
    unitSpriteManager: new Proxy({}, { get: () => () => {} }),
    terrainSpriteManager: new Proxy({}, { get: () => () => {} }),
    settings: new Proxy({}, { get: () => () => 0 }),
    // Persistent player profile the achievement scripts write to. Bookkeeping
    // only, but the scripts reference it by bare identifier.
    userdata: new Proxy({}, { get: () => () => undefined }),
  });

  const report = loadScripts(
    evaluator,
    BrowserEvaluator.parse,
    bundle.order.map(path => ({ path, source: bundle.sources[path] })),
  );

  animations.attach(evaluator.global);
  return { registry: evaluator.global, report, animations, rng };
}
