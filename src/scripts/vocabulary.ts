import type { ScriptRegistry } from './types.ts';

/**
 * Walks a script object's prototype chain looking for one of the base
 * prototypes. Content scripts end with `Constructor.prototype = UNIT` (or
 * TERRAIN, or BUILDING), so this classifies them exactly rather than by
 * guessing from which methods they happen to expose — BUILDING inherits
 * getDefense from TERRAIN, so duck-typing counts every building as terrain.
 */
function derivesFrom(value: unknown, base: unknown): boolean {
  let proto = value === null || typeof value !== 'object' ? null : Object.getPrototypeOf(value);
  while (proto) {
    if (proto === base) return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/**
 * Every id the scripts define, by kind.
 *
 * A learned model needs one fixed input layout across every map, so the
 * vocabulary has to come from the registry rather than from whichever ids a
 * particular board happens to use.
 */
export function vocabulary(registry: ScriptRegistry): {
  terrain: string[]; units: string[]; buildings: string[]; actions: string[];
} {
  const source = registry as Record<string, unknown>;
  const ids = Object.keys(source)
    .filter(key => /^[A-Z][A-Z0-9_]*$/.test(key) && source[key] && typeof source[key] === 'object')
    .sort();
  const units = ids.filter(id => derivesFrom(source[id], source.UNIT));
  const buildings = ids.filter(id => derivesFrom(source[id], source.BUILDING));
  // Buildings inherit from TERRAIN too, so they are excluded explicitly.
  const terrain = ids.filter(id =>
    derivesFrom(source[id], source.TERRAIN) && !derivesFrom(source[id], source.BUILDING));
  // Actions are named, not subclassed, so they are matched by prefix rather
  // than by prototype chain. The list is the policy head's output vocabulary,
  // so it must come from the registry for the same reason the others do: a
  // fixed layout across every map, independent of what a board happens to use.
  // The registry carries UI and CO entries (ACTION_OPTIONS, ACTION_SAVEGAME,
  // ACTION_ACTIVATE_POWER_CO_0) that no agent can ever choose; they cost one
  // dead output each, which is cheaper than a hand-maintained allowlist that
  // silently drops a real action when the submodule adds one.
  const actions = ids.filter(id => /^ACTION_/.test(id));
  return { terrain, units, buildings, actions };
}
