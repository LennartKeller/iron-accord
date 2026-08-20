import vm from 'node:vm';
import type { Evaluator, ScriptRegistry } from './types.ts';
import type { Parse } from './repair.ts';

/** Node evaluator: `vm.createContext` gives an isolated sloppy-mode global. */
export class NodeEvaluator implements Evaluator {
  readonly global: ScriptRegistry;
  private readonly context: vm.Context;

  constructor(hostGlobals: Record<string, unknown>) {
    const sandbox: Record<string, unknown> = { ...hostGlobals, console };
    this.context = vm.createContext(sandbox);
    this.global = sandbox as ScriptRegistry;
  }

  evaluate(source: string, filename: string): void {
    vm.runInContext(source, this.context, { filename });
  }

  static parse: Parse = (source, filename) => {
    new vm.Script(source, { filename });
  };
}
