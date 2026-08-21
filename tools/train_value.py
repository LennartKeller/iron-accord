"""
Trains the value net on extracted positions.

    .venv/bin/python tools/train_value.py --data data/positions --epochs 12

Shape. Boards run from 5x5 to 31x16, so the trunk is fully convolutional and the
head pools globally — nothing in the model depends on H or W. A shard holds one
map, which is the only thing that fixes those dimensions, so a batch is drawn
from within a single shard and never needs padding.

Input. The extractor stores three uint8 index planes plus the quantised derived
planes. `--input embed` looks the indices up in small embedding tables;
`--input onehot` scatters them back to the 222-channel tensor the encoder
produces. Same file, both answers to the open question.

Splits are by map, never by position: consecutive positions from one game differ
by a move and share a label, so a random split leaks the answer across it. The
extractor already writes train/ and validation/ directories for that reason.
"""
import argparse
import json
import math
import os
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--data', default='data/positions')
    p.add_argument('--out', default='models')
    p.add_argument('--epochs', type=int, default=12)
    p.add_argument('--batch', type=int, default=256)
    p.add_argument('--lr', type=float, default=1e-3)
    p.add_argument('--clip', type=float, default=1.0, help='gradient norm clip; 0 disables')
    p.add_argument('--width', type=int, default=64, help='trunk channels')
    p.add_argument('--blocks', type=int, default=6, help='residual blocks')
    p.add_argument('--input', choices=['embed', 'onehot'], default='embed')
    p.add_argument('--norm', choices=['group', 'batch'], default='group',
                   help='BatchNorm assumes IID batches. A batch here is one map, '
                        'because that is what fixes H and W, so BN running stats '
                        'track whichever map came last and do not transfer to a '
                        'held-out map. GroupNorm does not use batch statistics.')
    p.add_argument('--augment', type=int, default=1, help='D4 symmetry augmentation')
    p.add_argument('--draw-weight', type=float, default=1.0,
                   help='loss weight on drawn positions; they are ~40%% of the set '
                        'and carry the least signal')
    p.add_argument('--device', default='mps' if torch.backends.mps.is_available() else 'cpu')
    p.add_argument('--seed', type=int, default=0)
    p.add_argument('--wandb', default='iron-accord-value',
                   help='W&B project; empty string disables logging')
    p.add_argument('--run-name', default=None)
    return p.parse_args()


class Shards:
    """Memory-mapped shards, grouped so a batch never spans two board shapes."""

    def __init__(self, root, manifest, split):
        self.entries = []
        self.total = 0
        for shard in manifest['shards']:
            if shard['split'] != split:
                continue
            stem = os.path.join(root, shard['stem'])
            n, h, w = shard['count'], shard['height'], shard['width']
            planes = shard['indexPlanes'] + shard['derivedPlanes']
            entry = {
                'planes': np.memmap(f'{stem}.planes.u8', dtype=np.uint8, mode='r',
                                    shape=(n, planes, h, w)),
                'scalars': np.fromfile(f'{stem}.scalars.f32', dtype=np.float32).reshape(n, -1),
                'labels': np.fromfile(f'{stem}.labels.f32', dtype=np.float32),
                'baseline': np.fromfile(f'{stem}.baseline.f32', dtype=np.float32),
                'n': n, 'h': h, 'w': w, 'map': shard['map'],
            }
            self.entries.append(entry)
            self.total += n

    def batches(self, batch_size, rng, augment):
        """
        Yields (planes, scalars, labels, baseline), interleaved across maps.

        A batch has to come from one shard, because that is what fixes H and W.
        But walking shard by shard makes every consecutive gradient step come
        from the same map, and the model swings map-to-map instead of averaging
        over them — validation MSE tripled on the epoch the learning rate peaked.
        Planning the whole epoch's batches up front and shuffling that plan keeps
        the fixed shape per batch while making the update sequence IID.
        """
        plan = []
        rows_by_shard = []
        for si, e in enumerate(self.entries):
            rows = rng.permutation(e['n'])
            rows_by_shard.append(rows)
            for start in range(0, e['n'], batch_size):
                plan.append((si, start))
        rng.shuffle(plan)

        for si, start in plan:
            e = self.entries[si]
            idx = np.sort(rows_by_shard[si][start:start + batch_size])
            planes = torch.from_numpy(np.ascontiguousarray(e['planes'][idx]))
            scalars = torch.from_numpy(e['scalars'][idx])
            labels = torch.from_numpy(e['labels'][idx])
            base = torch.from_numpy(e['baseline'][idx])
            if augment:
                # One transform for the whole batch: a rotation changes H and W,
                # and a batch has to keep a single shape.
                k = int(rng.integers(4))
                if k:
                    planes = torch.rot90(planes, k, dims=(2, 3))
                if rng.integers(2):
                    planes = torch.flip(planes, dims=(3,))
                planes = planes.contiguous()
            yield planes, scalars, labels, base


def norm_layer(kind, width, groups=8):
    return nn.BatchNorm2d(width) if kind == 'batch' else nn.GroupNorm(groups, width)


class Block(nn.Module):
    def __init__(self, width, norm='group'):
        super().__init__()
        self.c1 = nn.Conv2d(width, width, 3, padding=1, bias=False)
        self.b1 = norm_layer(norm, width)
        self.c2 = nn.Conv2d(width, width, 3, padding=1, bias=False)
        self.b2 = norm_layer(norm, width)

    def forward(self, x):
        y = F.relu(self.b1(self.c1(x)))
        y = self.b2(self.c2(y))
        return F.relu(x + y)


class ValueNet(nn.Module):
    """Fully convolutional trunk, globally pooled head, tanh output in [-1, 1]."""

    def __init__(self, spec, width=64, blocks=6, mode='embed', scalars=5, norm='group'):
        super().__init__()
        self.mode = mode
        t, u, b, d = (spec['terrainCount'], spec['unitCount'],
                      spec['buildingCount'], spec['derivedCount'])
        self.counts = (t, u, b)
        self.derived = d

        if mode == 'embed':
            # +1 row for the "nothing here" index the extractor writes as 255.
            self.e_terrain = nn.Embedding(t + 1, 16)
            self.e_unit = nn.Embedding(u + 1, 24)
            self.e_building = nn.Embedding(b + 1, 16)
            in_channels = 16 + 24 + 16 + d
        else:
            in_channels = t + u + b + d

        self.stem = nn.Sequential(
            nn.Conv2d(in_channels, width, 3, padding=1, bias=False),
            norm_layer(norm, width), nn.ReLU(inplace=True))
        self.trunk = nn.Sequential(*[Block(width, norm) for _ in range(blocks)])
        self.head = nn.Sequential(
            nn.Linear(width * 2 + scalars, 128), nn.ReLU(inplace=True),
            nn.Linear(128, 64), nn.ReLU(inplace=True),
            nn.Linear(64, 1))

    def features(self, planes):
        """uint8 index planes -> float feature planes, either embedded or one-hot."""
        t, u, b = self.counts
        idx = planes[:, :3].long()
        derived = planes[:, 3:].float() / 255.0
        # 255 means empty; embeddings and one-hot both put it in the last slot.
        terrain = torch.where(idx[:, 0] == 255, t, idx[:, 0].clamp(max=t))
        unit = torch.where(idx[:, 1] == 255, u, idx[:, 1].clamp(max=u))
        building = torch.where(idx[:, 2] == 255, b, idx[:, 2].clamp(max=b))

        if self.mode == 'embed':
            parts = [self.e_terrain(terrain), self.e_unit(unit), self.e_building(building)]
            # (N, H, W, C) -> (N, C, H, W)
            parts = [p.permute(0, 3, 1, 2) for p in parts]
        else:
            parts = []
            for values, size in ((terrain, t), (unit, u), (building, b)):
                hot = F.one_hot(values, size + 1)[..., :size].float()
                parts.append(hot.permute(0, 3, 1, 2))
        return torch.cat(parts + [derived], dim=1)

    def forward(self, planes, scalars):
        x = self.stem(self.features(planes))
        x = self.trunk(x)
        pooled = torch.cat([
            F.adaptive_avg_pool2d(x, 1).flatten(1),
            F.adaptive_max_pool2d(x, 1).flatten(1),
            scalars], dim=1)
        return torch.tanh(self.head(pooled)).squeeze(1)


def _ranks(x):
    """
    Ranks with ties averaged.

    argsort-of-argsort breaks ties by array position, and the labels here take
    only three values, so ties are the common case, not the edge case. That made
    the heuristic's own score drift between epochs — same scores, same positions,
    different batch order — which is nonsense for a fixed baseline.
    """
    order = np.argsort(x, kind='stable')
    ranks = np.empty(len(x), dtype=np.float64)
    ranks[order] = np.arange(len(x), dtype=np.float64)
    sorted_x = x[order]
    start = 0
    for i in range(1, len(x) + 1):
        if i == len(x) or sorted_x[i] != sorted_x[start]:
            if i - start > 1:
                ranks[order[start:i]] = (start + i - 1) / 2.0
            start = i
    return ranks


def spearman(a, b):
    """Rank correlation, for comparing against a score on a different scale."""
    if len(a) < 3:
        return float('nan')
    ra, rb = _ranks(np.asarray(a, dtype=np.float64)), _ranks(np.asarray(b, dtype=np.float64))
    ra -= ra.mean(); rb -= rb.mean()
    denom = math.sqrt((ra ** 2).sum() * (rb ** 2).sum())
    return float((ra * rb).sum() / denom) if denom else float('nan')


@torch.no_grad()
def evaluate(model, shards, args, rng):
    model.eval()
    preds, labels, bases = [], [], []
    for planes, scalars, y, base in shards.batches(args.batch, rng, augment=0):
        p = model(planes.to(args.device), scalars.to(args.device))
        preds.append(p.float().cpu().numpy())
        labels.append(y.numpy())
        bases.append(base.numpy())
    model.train()
    preds = np.concatenate(preds); labels = np.concatenate(labels); bases = np.concatenate(bases)
    mse = float(((preds - labels) ** 2).mean())
    # The constant predictor is the bar the doc asks the net to clear by a wide
    # margin: predicting the mean label is what "no signal" looks like.
    const = float(((labels.mean() - labels) ** 2).mean())
    return {
        'mse': mse,
        'const_mse': const,
        'net_rank': spearman(preds, labels),
        'baseline_rank': spearman(bases, labels),
        'n': len(labels),
    }


def main():
    args = parse_args()
    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)

    manifest = json.load(open(os.path.join(args.data, 'manifest.json')))
    train = Shards(args.data, manifest, 'train')
    val = Shards(args.data, manifest, 'validation')
    print(f"train {train.total} positions / {len(train.entries)} shards, "
          f"validation {val.total} / {len(val.entries)}")
    print(f"maps  train={len({e['map'] for e in train.entries})} "
          f"validation={len({e['map'] for e in val.entries})}")

    scalars = train.entries[0]['scalars'].shape[1]
    model = ValueNet(manifest, args.width, args.blocks, args.input, scalars,
                     args.norm).to(args.device)
    params = sum(p.numel() for p in model.parameters())
    print(f"model: {args.input}/{args.norm}, {args.blocks} blocks x {args.width} ch, {params/1e3:.0f}k params, "
          f"device {args.device}")

    run = None
    if args.wandb:
        import wandb
        run = wandb.init(
            project=args.wandb, name=args.run_name, config={
                **vars(args),
                'params': params,
                'train_positions': train.total,
                'val_positions': val.total,
                'train_maps': len({e['map'] for e in train.entries}),
                'val_maps': len({e['map'] for e in val.entries}),
                'source': manifest.get('source'),
                'games': manifest.get('games'),
                'perTurn': manifest.get('perTurn'),
                'gamma': manifest.get('gamma'),
            })
        # The heuristic is the thing to beat, and it does not change between
        # epochs — logging it as a line makes every chart self-explanatory.
        wandb.define_metric('val/mse', summary='min')
        wandb.define_metric('val/rank', summary='max')

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    steps = max(1, math.ceil(train.total / args.batch)) * args.epochs
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=steps)

    best = None
    step = 0
    for epoch in range(args.epochs):
        started = time.time()
        running, seen = 0.0, 0
        for planes, scalars_b, y, _ in train.batches(args.batch, rng, args.augment):
            planes = planes.to(args.device)
            scalars_b = scalars_b.to(args.device)
            y = y.to(args.device)
            pred = model(planes, scalars_b)
            loss = (pred - y) ** 2
            if args.draw_weight != 1.0:
                weight = torch.where(y == 0, args.draw_weight, 1.0)
                loss = loss * weight
            loss = loss.mean()
            opt.zero_grad(set_to_none=True)
            loss.backward()
            if args.clip:
                torch.nn.utils.clip_grad_norm_(model.parameters(), args.clip)
            opt.step()
            if step < steps - 1:
                sched.step()
            step += 1
            running += float(loss.detach()) * len(y)
            seen += len(y)

        stats = evaluate(model, val, args, rng)
        print(f"epoch {epoch+1:2d}  train {running/max(seen,1):.4f}  "
              f"val mse {stats['mse']:.4f} (const {stats['const_mse']:.4f})  "
              f"rank net {stats['net_rank']:.3f} vs heuristic {stats['baseline_rank']:.3f}  "
              f"{time.time()-started:.0f}s")

        if run is not None:
            run.log({
                'epoch': epoch + 1,
                'train/mse': running / max(seen, 1),
                'val/mse': stats['mse'],
                'val/const_mse': stats['const_mse'],
                # Fraction of the constant predictor's error removed: 0 is no
                # signal, 1 is perfect. Comparable across label distributions.
                'val/skill': 1 - stats['mse'] / stats['const_mse'],
                'val/rank': stats['net_rank'],
                'val/heuristic_rank': stats['baseline_rank'],
                'lr': sched.get_last_lr()[0],
            }, step=epoch + 1)

        if best is None or stats['mse'] < best['mse']:
            best = stats
            os.makedirs(args.out, exist_ok=True)
            torch.save({'model': model.state_dict(), 'args': vars(args),
                        'manifest': {k: manifest[k] for k in
                                     ('channels', 'terrainCount', 'unitCount',
                                      'buildingCount', 'derivedCount', 'scalarNames')},
                        'stats': stats},
                       os.path.join(args.out, 'value.pt'))

    print(f"\nbest val mse {best['mse']:.4f} vs constant {best['const_mse']:.4f} "
          f"({(1 - best['mse']/best['const_mse'])*100:.1f}% better)")
    if run is not None:
        run.summary['best/mse'] = best['mse']
        run.summary['best/skill'] = 1 - best['mse'] / best['const_mse']
        run.summary['best/rank'] = best['net_rank']
        run.summary['best/heuristic_rank'] = best['baseline_rank']
        run.summary['beats_heuristic'] = bool(best['net_rank'] > best['baseline_rank'])
        run.finish()

    print(f"ranking: net {best['net_rank']:.3f}, heuristic {best['baseline_rank']:.3f} "
          f"-> {'net wins' if best['net_rank'] > best['baseline_rank'] else 'HEURISTIC STILL WINS'}")


if __name__ == '__main__':
    main()
