import { NodeEvaluator } from '../scripts/evaluator-node.ts';
import { loadScripts, type LoadReport } from '../scripts/loader.ts';
import { applyScriptRepairs } from '../scripts/repairs.ts';
import type { ScriptRegistry } from '../scripts/types.ts';
export { vocabulary } from '../scripts/vocabulary.ts';
import { collectScripts, type CollectOptions } from '../cw/resources.node.ts';
import {
  GameEnums, Qt, qsTr, makeGlobals, makeAnimationStubs, Mulberry32, GameMap, AnimationRunner,
} from '../host/index.ts';

export interface Bootstrapped {
  registry: ScriptRegistry;
  report: LoadReport;
  animations: AnimationRunner;
  /** The stream the scripts draw from; reseed it to reproduce an episode. */
  rng: Mulberry32;
  createMap(width: number, height: number, defaultTerrain?: string): GameMap;
}

/**
 * Boots the Commander Wars script layer against the host shim and returns the
 * populated registry. Node-only: uses `vm` and the filesystem.
 */
export function bootstrap(options: CollectOptions & { seed?: number } = {}): Bootstrapped {
  const rng = new Mulberry32(options.seed ?? 0xC0FFEE);
  const animations = new AnimationRunner();
  const evaluator = new NodeEvaluator({
    GameEnums,
    Qt,
    qsTr,
    globals: makeGlobals(rng),
    ...makeAnimationStubs(animations),
    // Sprite managers are consulted while scripts load; the rules never read them.
    unitSpriteManager: new Proxy({}, { get: () => () => {} }),
    terrainSpriteManager: new Proxy({}, { get: () => () => {} }),
    settings: new Proxy({}, { get: () => () => 0 }),
    // Persistent player profile the achievement scripts write to. Bookkeeping
    // only, but the scripts reference it by bare identifier.
    userdata: new Proxy({}, { get: () => () => undefined }),
  });

  const report = loadScripts(evaluator, NodeEvaluator.parse, collectScripts(options));
  const registry = evaluator.global;
  applyScriptRepairs(registry);
  animations.attach(registry);

  return {
    registry,
    report,
    animations,
    rng,
    createMap: (width, height, defaultTerrain = 'PLAINS') =>
      new GameMap(width, height, defaultTerrain, registry),
  };
}

/** Unit script ids present in the registry (they all expose getBaseCost). */
export function unitIds(registry: ScriptRegistry): string[] {
  return Object.keys(registry).filter(key =>
    /^[A-Z][A-Z0-9_]*$/.test(key)
    && registry[key]
    && typeof registry[key] === 'object'
    && typeof registry[key].getBaseCost === 'function'
    && registry[key] !== registry.UNIT);
}

/** Weapon script ids present in the registry. */
export function weaponIds(registry: ScriptRegistry): string[] {
  return Object.keys(registry).filter(key =>
    /^WEAPON_/.test(key)
    && registry[key]
    && typeof registry[key].getBaseDamage === 'function');
}
