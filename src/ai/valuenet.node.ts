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

export async function loadValueNet(modelPath = 'models/value.onnx'): Promise<ValueNetEvaluator> {
  const metaPath = `${modelPath.replace(/\.onnx$/, '')}.json`;
  const meta: ValueNetMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const session = await ort.InferenceSession.create(path.resolve(modelPath));

  return new ValueNetEvaluator(
    session as never,
    {
      uint8: (data, dims) => new ort.Tensor('uint8', data, dims),
      float32: (data, dims) => new ort.Tensor('float32', data, dims),
    },
    meta,
  );
}
