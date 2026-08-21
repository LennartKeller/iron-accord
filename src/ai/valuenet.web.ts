/**
 * The value net in the browser.
 *
 * Counterpart to `valuenet.node.ts`: same .onnx file, same pure
 * `ValueNetEvaluator`, different runtime. Nothing here may be imported from
 * Node tooling and nothing from `valuenet.node.ts` may be imported here — that
 * file pulls `node:fs` into the bundle, where Vite externalises it to a stub and
 * the build still reports success.
 *
 * The model is fetched at runtime rather than imported as a build asset.
 * `import ... from '../../models/value.onnx?url'` made the whole web build fail
 * when no model had been trained yet — `models/` is generated, and gitignored,
 * so CI never has one and rollup cannot resolve the import. The URL is built
 * from `import.meta.env.BASE_URL` instead, which gives the same `base` prefix
 * on GitHub Pages, and `valueNetAssets()` in vite.config.ts emits the files
 * when they happen to exist. No model, no build failure — just a seat that
 * reports it has no net.
 *
 * The wasm runtime cannot be imported as a URL either — the package does not
 * export it — so vite.config.ts copies it into the output and `wasmPaths`
 * points there. Left alone it would fetch from a CDN, which is wrong for an
 * offline PWA.
 */
// The './wasm' entry, not the package root: the default entry pulls the
// WebGPU (jsep) runtime, a 26 MB binary, and this net is 513k parameters on
// boards of at most a few hundred tiles. CPU wasm is 13 MB and plenty.
import * as ort from 'onnxruntime-web/wasm';
import { ValueNetEvaluator, BudgetedValueNet, type ValueNetMeta } from './onnx-evaluator.ts';
import { HeuristicEvaluator } from './evaluator.ts';
import { PlannerAgent } from './planner.ts';
import type { Agent } from './agent.ts';
import type { GameEnvironment } from './environment.ts';
import type { ActionDescriptor } from './actions.ts';
import type { Evaluator } from './evaluator.ts';

/** Emitted beside the bundle by `valueNetAssets()`, served under `base`. */
const modelUrl = `${import.meta.env.BASE_URL}value.onnx`;
const metaUrl = `${import.meta.env.BASE_URL}value.json`;

let pending: Promise<ValueNetEvaluator> | null = null;

/** Loaded once per page: the session and its wasm are expensive to build. */
export function valueNet(): Promise<ValueNetEvaluator> {
  if (!pending) {
    pending = (async () => {
      // Point the runtime at the wasm copied beside the bundle by the
      // `onnxRuntime` plugin in vite.config.ts. onnxruntime-web does not export
      // its own .wasm through package exports, so it cannot be imported as a
      // URL; left unset it would fetch from a CDN, which an offline PWA cannot.
      // Threads need cross-origin isolation, which GitHub Pages does not send.
      ort.env.wasm.numThreads = 1;

      const metaResponse = await fetch(metaUrl);
      if (!metaResponse.ok) {
        // A build with no trained model reaches here. Say so plainly rather
        // than failing inside onnxruntime with a parse error on an HTML 404.
        throw new Error(`no value net deployed at ${modelUrl} — train one and rebuild`);
      }
      const meta: ValueNetMeta = await metaResponse.json();
      const session = await ort.InferenceSession.create(modelUrl);
      return new ValueNetEvaluator(
        session as never,
        {
          uint8: (data, dims) => new ort.Tensor('uint8', data, dims),
          float32: (data, dims) => new ort.Tensor('float32', data, dims),
        },
        meta,
      );
    })();
  }
  return pending;
}

/**
 * A planner that waits for its evaluator.
 *
 * The seat registry builds agents synchronously, but the model arrives over the
 * network, so the real planner is constructed on first use. Until then there is
 * nothing to do: `beginTurn` and `selectAction` are both already async.
 */
export class ValueNetAgent implements Agent {
  readonly name = 'valuenet';
  private inner: PlannerAgent | null = null;
  private readonly budgetMs: number;

  private readonly maxPerLayer: number;

  /**
   * @param maxPerLayer how many positions per beam layer reach the net.
   *
   * Under wasm a forward pass costs ~10 ms per position, so a 250 ms turn
   * affords roughly 24 of them. Handing the whole layer to the net spends that
   * budget on a search too shallow to be worth anything: on Central Lake the
   * unbudgeted net failed to finish a single game across four seeds, still
   * shuffling units on day 201, while this cut finished all four by day 49.
   */
  constructor(budgetMs = 250, maxPerLayer = 8) {
    this.budgetMs = budgetMs;
    this.maxPerLayer = maxPerLayer;
  }

  private async ready(): Promise<PlannerAgent> {
    if (!this.inner) {
      this.inner = new PlannerAgent({
        timeBudgetMs: this.budgetMs,
        evaluator: new BudgetedValueNet(
          await valueNet(), new HeuristicEvaluator(), this.maxPerLayer) as Evaluator<unknown>,
      });
    }
    return this.inner;
  }

  async beginTurn(env: GameEnvironment): Promise<void> {
    (await this.ready()).beginTurn(env);
  }

  async selectAction(env: GameEnvironment, legal: ActionDescriptor[]): Promise<ActionDescriptor | null> {
    return (await this.ready()).selectAction(env, legal);
  }
}
