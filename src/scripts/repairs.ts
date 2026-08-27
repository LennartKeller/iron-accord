import type { ScriptRegistry } from './types.ts';

/**
 * Repairs for defects in Commander Wars' own shipped scripts.
 *
 * The rule everywhere else in this project is to run their code unmodified, and
 * `ext/` is never edited. But a script that is simply broken cannot be run as
 * intended, and pretending otherwise silently corrupts whatever depends on it.
 * So the defect is repaired here, in one place, with the reason recorded and the
 * upstream source left alone.
 *
 * Each entry states what is wrong, what it costs, and why the repair restores
 * upstream's evident intent rather than inventing behaviour.
 */
export function applyScriptRepairs(registry: ScriptRegistry): string[] {
  const applied: string[] = [];

  /**
   * `general/terrain.js` and `general/building.js` each declare `onDestroyed`
   * twice in one object literal:
   *
   *     onDestroyed : function(terrain, map) { },   // empty, with a comment
   *     onDestroyed : null,
   *
   * A duplicate key means the last wins, so both bases end up null. ACTION_FIRE
   * then calls `Global[id].onDestroyed(...)` unconditionally when a building or
   * destructible terrain is destroyed, which throws for every type that does not
   * override it -- which is nearly all of them.
   *
   * The cost is not cosmetic. The throw happens inside an animation callback, so
   * the destruction never completes, the board diverges from what the actions
   * describe, and the game becomes unreplayable. Agents that shoot structures
   * hit it constantly.
   *
   * Restoring the no-op the duplicate key clobbered is exactly what the first,
   * shadowed definition was, comment and all.
   */
  for (const base of ['TERRAIN', 'BUILDING']) {
    const script = registry[base] as { onDestroyed?: unknown } | undefined;
    if (script && script.onDestroyed === null) {
      script.onDestroyed = () => {};
      applied.push(`${base}.onDestroyed restored (shadowed by a duplicate key)`);
    }
  }

  return applied;
}
