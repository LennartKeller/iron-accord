"""
Exports a trained value net to ONNX, so one file serves Node and the browser.

    .venv/bin/python tools/export_onnx.py --checkpoint models/value.pt --out models/value.onnx

Board size is a dynamic axis, not a fixed shape. The trunk is fully
convolutional and the head pools globally, so the same graph runs on a 5x5 and
a 31x16 — but only if the export says so, otherwise onnxruntime bakes in
whatever board the dummy input happened to be.

Batch is dynamic for the same reason the Evaluator interface splits capture from
score: the planner expands a whole beam layer and scores it in one pass.
"""
import argparse
import json
import os

import numpy as np
import torch

from train_value import ValueNet


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--checkpoint', default='models/value.pt')
    p.add_argument('--out', default='models/value.onnx')
    p.add_argument('--opset', type=int, default=17)
    args = p.parse_args()

    ckpt = torch.load(args.checkpoint, map_location='cpu', weights_only=False)
    spec = ckpt['manifest']
    trained = ckpt['args']

    model = ValueNet(spec, trained['width'], trained['blocks'], trained['input'],
                     scalars=len(spec['scalarNames']), norm=trained.get('norm', 'group'))
    model.load_state_dict(ckpt['model'])
    model.eval()

    planes = 3 + spec['derivedCount']
    dummy_planes = torch.zeros(2, planes, 9, 11, dtype=torch.uint8)
    dummy_scalars = torch.zeros(2, len(spec['scalarNames']), dtype=torch.float32)

    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
    torch.onnx.export(
        model, (dummy_planes, dummy_scalars), args.out,
        input_names=['planes', 'scalars'], output_names=['value'],
        dynamic_axes={
            'planes': {0: 'batch', 2: 'height', 3: 'width'},
            'scalars': {0: 'batch'},
            'value': {0: 'batch'},
        },
        opset_version=args.opset,
        dynamo=False,
    )

    # Verify against the torch model on a board size the export never saw —
    # that is what catches a shape silently baked into the graph.
    import onnxruntime as ort
    session = ort.InferenceSession(args.out, providers=['CPUExecutionProvider'])
    rng = np.random.default_rng(0)
    for (h, w, n) in ((9, 11, 2), (17, 24, 5), (5, 5, 1)):
        pl = rng.integers(0, 60, size=(n, planes, h, w), dtype=np.uint8)
        sc = rng.random((n, len(spec['scalarNames']))).astype(np.float32)
        got = session.run(None, {'planes': pl, 'scalars': sc})[0].reshape(-1)
        with torch.no_grad():
            want = model(torch.from_numpy(pl), torch.from_numpy(sc)).numpy()
        delta = float(np.abs(got - want).max())
        print(f"{h}x{w} batch {n}: max |onnx - torch| = {delta:.2e}"
              f"{'  MISMATCH' if delta > 1e-4 else ''}")

    meta = {
        'planes': planes,
        'derivedCount': spec['derivedCount'],
        'terrainCount': spec['terrainCount'],
        'unitCount': spec['unitCount'],
        'buildingCount': spec['buildingCount'],
        'scalarNames': spec['scalarNames'],
        'none': 255,
        'stats': ckpt.get('stats', {}),
    }
    side = os.path.splitext(args.out)[0] + '.json'
    json.dump(meta, open(side, 'w'), indent=2)
    print(f"\nwrote {args.out} ({os.path.getsize(args.out)/1e6:.1f} MB) and {side}")


if __name__ == '__main__':
    main()
