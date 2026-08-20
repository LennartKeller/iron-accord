import { repairShorthand, type Parse } from './repair.ts';
import type { Evaluator, ScriptRegistry } from './types.ts';

export interface ScriptSource {
  /** Path relative to resources/scripts, e.g. "units/infantry.js". */
  path: string;
  source: string;
}

export interface LoadReport {
  loaded: string[];
  patchedLines: string[];
  failed: Array<{ path: string; error: string }>;
}

/**
 * Loads Commander Wars scripts into a sandbox.
 *
 * Load order matters: a script ends with `Constructor.prototype = UNIT` and so
 * needs its base prototype already defined. Rather than hard-coding a full
 * dependency graph we retry whatever failed, which converges as long as there
 * are no genuine cycles.
 */
export function loadScripts(
  evaluator: Evaluator,
  parse: Parse,
  scripts: ScriptSource[],
  maxPasses = 8,
): LoadReport {
  const report: LoadReport = { loaded: [], patchedLines: [], failed: [] };
  let pending = scripts;

  for (let pass = 0; pass < maxPasses && pending.length > 0; pass++) {
    const stillFailing: ScriptSource[] = [];
    let progressed = false;

    for (const script of pending) {
      try {
        const { source, patchedLines } = repairShorthand(script.source, script.path, parse);
        evaluator.evaluate(source, script.path);
        report.loaded.push(script.path);
        report.patchedLines.push(...patchedLines);
        progressed = true;
      } catch (err) {
        stillFailing.push(script);
      }
    }

    if (!progressed) break;
    pending = stillFailing;
  }

  for (const script of pending) {
    try {
      const { source } = repairShorthand(script.source, script.path, parse);
      evaluator.evaluate(source, script.path);
      report.loaded.push(script.path);
    } catch (err) {
      report.failed.push({ path: script.path, error: (err as Error).message });
    }
  }

  return report;
}

/** The registry is the sandbox global (`global.js` does `Global = this`). */
export function registryOf(evaluator: Evaluator): ScriptRegistry {
  return evaluator.global;
}
