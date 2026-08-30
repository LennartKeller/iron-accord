/**
 * Loads the value net under Node.
 *
 * Kept apart from `onnx-evaluator.ts` on purpose: that file is pure and takes
 * its session injected, so the browser can hand it onnxruntime-web against the
 * same .onnx file. This one pulls in onnxruntime-node and the filesystem, so
 * nothing the browser reaches may import it — see the note about
 * `bootstrap.node.ts` in the handoff doc; the failure mode is a build that
 * "succeeds" with stubbed node builtins.
 */
import fs from 'node:fs';
import path from 'node:path';
import ort from 'onnxruntime-node';
import { ValueNetEvaluator, type ValueNetMeta } from './onnx-evaluator.ts';

/**
 * Runs the net on the GPU when VALUENET_CUDA is set, falling back silently.
 *
 * Self-play with a net-guided planner is inference-bound: a game costs ~167
 * core-seconds against ~7 for heuristic play, almost all of it forward passes.
 * On this machine CUDA measured 0.114 ms per position against ~1.25 ms on CPU,
 * an 11x difference, which is what decides whether an expert-iteration round is
 * an afternoon or a week.
 *
 * Opt-in rather than automatic: it needs the CUDA and cuDNN shared libraries on
 * the loader path (the torch venv ships them), and a benchmark that silently
 * changed backend would make its own numbers incomparable.
 */
export async function loadValueNet(modelPath = 'models/value.onnx'): Promise<ValueNetEvaluator> {
  const metaPath = `${modelPath.replace(/\.onnx$/, '')}.json`;
  const meta: ValueNetMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const resolved = path.resolve(modelPath);
  let session: unknown;
  if (process.env.VALUENET_CUDA) {
    try {
      session = await ort.InferenceSession.create(resolved, { executionProviders: ['cuda'] });
    } catch (error) {
      console.warn('VALUENET_CUDA set but the CUDA provider failed; using CPU:',
        error instanceof Error ? error.message : error);
    }
  }
  // Without a cap, every session takes ORT's default intra-op pool of one
  // thread per core -- 30 self-play workers on a 32-core box is ~960 threads
  // and a load average in the hundreds. One thread per worker is right when
  // the workers themselves are the parallelism.
  const intraOpNumThreads = Number(process.env.ORT_INTRA_THREADS ?? 0) || undefined;
  session ??= await ort.InferenceSession.create(
    resolved, intraOpNumThreads ? { intraOpNumThreads } : {});

  return new ValueNetEvaluator(
    session as never,
    {
      uint8: (data, dims) => new ort.Tensor('uint8', data, dims),
      float32: (data, dims) => new ort.Tensor('float32', data, dims),
    },
    meta,
  );
}
