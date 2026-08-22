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
    p.add_argument('--head', choices=['scalar', 'wdl'], default='wdl',
                   help='scalar: tanh trained on MSE. wdl: three logits over '
                        '{loss, draw, win} trained on cross-entropy, read by the '
                        'search as P(win) - P(loss). A scalar head cannot tell a '
                        'certain draw from a 50/50 win-or-loss -- both sit at 0 -- '
                        'and draws are ~40%% of the set, so that is a fifth of the '
                        'capacity spent on a distinction it cannot represent.')
    p.add_argument('--norm', choices=['group', 'batch'], default='group',
                   help='BatchNorm assumes IID batches. A batch here is one map, '
                        'because that is what fixes H and W, so BN running stats '
                        'track whichever map came last and do not transfer to a '
                        'held-out map. GroupNorm does not use batch statistics.')
    p.add_argument('--augment', type=int, default=1, help='D4 symmetry augmentation')
    p.add_argument('--draw-weight', type=float, default=1.0,
                   help='relative weight on drawn positions: a per-sample loss '
                        'multiplier under --head scalar, the draw class weight '
                        'under --head wdl. They are ~40%% of the set.')
    p.add_argument('--device', default=('cuda' if torch.cuda.is_available()
                                        else 'mps' if torch.backends.mps.is_available()
                                        else 'cpu'))
    p.add_argument('--seed', type=int, default=0)
    p.add_argument('--log-every', type=int, default=100,
                   help='steps between training-loss points sent to W&B. Epochs '
                        'here are ~12k steps, so epoch-boundary logging alone '
                        'leaves a run looking dead for ten minutes at a time.')
    p.add_argument('--val-per-shard', type=int, default=1024,
                   help='cap on validation rows taken per shard; 0 uses all. '
                        'The split is by map and there are hundreds of shards, '
                        'so a per-shard cap keeps every map represented while '
                        'cutting an eval pass that is otherwise 38%% of the '
                        'data -- and twice that under --head wdl, which runs '
                        'the scalar ablation over the same batches.')
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

    def batches(self, batch_size, rng, augment, max_per_shard=0):
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
            # Sampled after the shuffle, so a capped pass still sees a random
            # slice of the shard rather than whatever the file happens to open with.
            if max_per_shard:
                rows = rows[:max_per_shard]
            rows_by_shard.append(rows)
            for start in range(0, len(rows), batch_size):
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
            yield planes, scalars, labels, base, si


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
    """
    Fully convolutional trunk, globally pooled head.

    Two heads share everything above them. `scalar` is a tanh in [-1, 1] trained
    on MSE. `wdl` is three logits over {loss, draw, win} trained on cross-entropy,
    which the search reads as P(win) - P(loss) -- the same [-1, 1] range, so both
    heads can be scored on identical MSE and rank metrics and compared directly.
    """

    def __init__(self, spec, width=64, blocks=6, mode='embed', scalars=5, norm='group',
                 head='wdl'):
        super().__init__()
        self.mode = mode
        self.head_kind = head
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
            nn.Linear(64, 3 if head == 'wdl' else 1))

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
        out = self.head(pooled)
        return out if self.head_kind == 'wdl' else torch.tanh(out).squeeze(1)


def expected_value(out, head):
    """
    The scalar the search ranks on, for either head.

    Under wdl that is E[label] over the predicted distribution -- P(win) minus
    P(loss), the draw class contributing nothing because its label is 0. Putting
    both heads on this one axis is what makes their MSE and rank comparable.
    """
    if head != 'wdl':
        return out
    p = torch.softmax(out, dim=1)
    return p[:, 2] - p[:, 0]


def classes_from(labels):
    """{-1, 0, +1}, or any gamma-scaled version of it, -> {0: loss, 1: draw, 2: win}."""
    return torch.sign(labels).long() + 1


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
    preds, labels, bases, logits, blank = [], [], [], [], []
    shard_ids = []
    for planes, scalars, y, base, si in shards.batches(
            args.batch, rng, augment=0, max_per_shard=args.val_per_shard):
        planes = planes.to(args.device)
        scalars = scalars.to(args.device)
        out = model(planes, scalars)
        preds.append(expected_value(out, args.head).float().cpu().numpy())
        if args.head == 'wdl':
            logits.append(out.float().cpu().numpy())
            # Ablation: the same boards with the five scalars blanked. `day` is
            # one of them and it feeds the head directly, bypassing the trunk --
            # and draws are structurally late-day, so a net can score well on
            # `day` alone while telling sibling positions apart no better than
            # chance. If blanking barely moves CE, the trunk learned nothing and
            # the pooled numbers below are measuring a shortcut.
            blank.append(model(planes, torch.zeros_like(scalars)).float().cpu().numpy())
        labels.append(y.numpy())
        bases.append(base.numpy())
        shard_ids.append(np.full(len(y), si))
    model.train()
    preds = np.concatenate(preds); labels = np.concatenate(labels); bases = np.concatenate(bases)
    shard_ids = np.concatenate(shard_ids)
    mse = float(((preds - labels) ** 2).mean())
    # The constant predictor is the bar the doc asks the net to clear by a wide
    # margin: predicting the mean label is what "no signal" looks like.
    const = float(((labels.mean() - labels) ** 2).mean())
    # Per-map rank, averaged over maps, is the honest version of this number.
    # The search only ever compares positions within one layer -- same map, same
    # day -- so a pooled correlation can be carried entirely by between-map
    # differences the search never sees. It also unbiases the comparison: the
    # heuristic scores in absolute funds, whose scale moves with map size, so
    # pooling across maps degrades its rank for scale reasons and flatters the net.
    per_map_net, per_map_base = [], []
    for si in np.unique(shard_ids):
        where = shard_ids == si
        if where.sum() < 3 or len(np.unique(labels[where])) < 2:
            continue
        per_map_net.append(spearman(preds[where], labels[where]))
        per_map_base.append(spearman(bases[where], labels[where]))

    stats = {
        'mse': mse,
        'const_mse': const,
        'net_rank': spearman(preds, labels),
        'baseline_rank': spearman(bases, labels),
        'net_rank_bymap': float(np.nanmean(per_map_net)) if per_map_net else float('nan'),
        'baseline_rank_bymap': float(np.nanmean(per_map_base)) if per_map_base else float('nan'),
        'maps_scored': len(per_map_net),
        'n': len(labels),
    }
    if args.head == 'wdl':
        z = torch.from_numpy(np.concatenate(logits))
        cls = classes_from(torch.from_numpy(labels))
        # Unweighted, whatever --draw-weight the training used: this has to be
        # comparable to the class prior below, and to another run's number.
        stats['ce'] = float(F.cross_entropy(z, cls))
        # The bar for a distribution is the class prior's entropy, not the mean
        # label -- a net that has learned only "40% of positions draw" scores
        # exactly this, and anything above it is knowing nothing about the board.
        prior = torch.bincount(cls, minlength=3).float() / len(cls)
        stats['const_ce'] = float(-(prior * prior.clamp_min(1e-12).log()).sum())
        predicted = z.argmax(1)
        stats['acc'] = float((predicted == cls).float().mean())
        # A net that never says "draw" has learned the prior, not the position --
        # the one number that says whether the third class is earning its place.
        stats['draw_pred'] = float((predicted == 1).float().mean())
        stats['draw_true'] = float((cls == 1).float().mean())
        blank_ce = float(F.cross_entropy(torch.from_numpy(np.concatenate(blank)), cls))
        stats['blank_ce'] = blank_ce
        # How much of the net's edge over the prior survives losing the scalars.
        # Near 0 means the scalars were doing the work.
        edge = stats['const_ce'] - stats['ce']
        stats['trunk_share'] = (stats['const_ce'] - blank_ce) / edge if edge > 1e-9 else float('nan')
    return stats


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
                     args.norm, args.head).to(args.device)
    params = sum(p.numel() for p in model.parameters())
    print(f"model: {args.head} head, {args.input}/{args.norm}, {args.blocks} blocks x "
          f"{args.width} ch, {params/1e3:.0f}k params, device {args.device}")

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
        wandb.define_metric('step')
        wandb.define_metric('*', step_metric='step')
        wandb.define_metric('val/mse', summary='min')
        wandb.define_metric('val/ce', summary='min')
        wandb.define_metric('val/rank', summary='max')
        wandb.define_metric('val/rank_bymap', summary='max')

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    steps = max(1, math.ceil(train.total / args.batch)) * args.epochs
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=steps)

    # Cross-entropy takes the draw weight as a class weight rather than a
    # per-sample multiplier; same knob, the shape the loss expects.
    class_weights = None
    if args.head == 'wdl' and args.draw_weight != 1.0:
        class_weights = torch.tensor([1.0, args.draw_weight, 1.0], device=args.device)

    best = None
    best_rank = None
    step = 0
    for epoch in range(args.epochs):
        started = time.time()
        running, seen = 0.0, 0
        for planes, scalars_b, y, _, _shard in train.batches(args.batch, rng, args.augment):
            planes = planes.to(args.device)
            scalars_b = scalars_b.to(args.device)
            y = y.to(args.device)
            out = model(planes, scalars_b)
            if args.head == 'wdl':
                loss = F.cross_entropy(out, classes_from(y), weight=class_weights)
            else:
                loss = (out - y) ** 2
                if args.draw_weight != 1.0:
                    loss = loss * torch.where(y == 0, args.draw_weight, 1.0)
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
            if run is not None and step % args.log_every == 0:
                run.log({'step': step, 'train/loss_running': running / max(seen, 1),
                         'lr': sched.get_last_lr()[0]}, step=step)

        stats = evaluate(model, val, args, rng)
        line = f"epoch {epoch+1:2d}  train {running/max(seen,1):.4f}  "
        if args.head == 'wdl':
            line += (f"val ce {stats['ce']:.4f} (prior {stats['const_ce']:.4f})  "
                     f"draw {stats['draw_pred']*100:.0f}%/{stats['draw_true']*100:.0f}%  ")
        line += (f"val mse {stats['mse']:.4f}  "
                 f"rank/map net {stats['net_rank_bymap']:.3f} vs heuristic "
                 f"{stats['baseline_rank_bymap']:.3f}  ")
        if args.head == 'wdl':
            share = stats['trunk_share']
            line += ('trunk n/a  ' if share != share else f"trunk {share*100:.0f}%  ")
        line += f"{time.time()-started:.0f}s"
        print(line)

        if run is not None:
            payload = {
                'step': step,
                'epoch': epoch + 1,
                'train/loss': running / max(seen, 1),
                'val/mse': stats['mse'],
                'val/const_mse': stats['const_mse'],
                # Fraction of the constant predictor's error removed: 0 is no
                # signal, 1 is perfect. Comparable across label distributions.
                'val/skill': 1 - stats['mse'] / stats['const_mse'],
                'val/rank': stats['net_rank'],
                'val/heuristic_rank': stats['baseline_rank'],
                # The pair that actually matters -- see evaluate().
                'val/rank_bymap': stats['net_rank_bymap'],
                'val/heuristic_rank_bymap': stats['baseline_rank_bymap'],
                'lr': sched.get_last_lr()[0],
            }
            if args.head == 'wdl':
                payload.update({
                    'val/ce': stats['ce'],
                    'val/const_ce': stats['const_ce'],
                    'val/ce_skill': 1 - stats['ce'] / stats['const_ce'],
                    'val/acc': stats['acc'],
                    'val/draw_pred': stats['draw_pred'],
                    'val/draw_true': stats['draw_true'],
                    'val/blank_ce': stats['blank_ce'],
                    'val/trunk_share': stats['trunk_share'],
                })
            run.log(payload, step=step)

        # Three checkpoints, because no single validation metric here predicts
        # playing strength. Cross-entropy and rank disagree badly -- on the
        # merged dataset CE was lowest at epoch 1 while rank kept climbing to
        # epoch 6, so selecting on CE alone threw away the better player -- and
        # a head-to-head between two heads once inverted both of them. Keep the
        # candidates cheap (2 MB each) and let `bench-valuenet.ts` decide.
        os.makedirs(args.out, exist_ok=True)
        payload = {'args': vars(args),
                   'manifest': {k: manifest[k] for k in
                                ('channels', 'terrainCount', 'unitCount',
                                 'buildingCount', 'derivedCount', 'scalarNames')}}

        def save(name, why):
            torch.save({**payload, 'model': model.state_dict(),
                        'stats': stats, 'selected_by': why},
                       os.path.join(args.out, name))

        key = 'ce' if args.head == 'wdl' else 'mse'
        save('value-last.pt', 'final epoch')
        if best_rank is None or stats['net_rank_bymap'] > best_rank['net_rank_bymap']:
            best_rank = stats
            save('value-rank.pt', 'best val rank per map')
        if best is None or stats[key] < best[key]:
            best = stats
            save('value.pt', f'best val {key}')

    print()
    if args.head == 'wdl':
        print(f"best val ce {best['ce']:.4f} vs class prior {best['const_ce']:.4f} "
              f"({(1 - best['ce']/best['const_ce'])*100:.1f}% better); "
              f"draw predicted on {best['draw_pred']*100:.0f}% of positions, "
              f"true {best['draw_true']*100:.0f}%")
    print(f"best val mse {best['mse']:.4f} vs constant {best['const_mse']:.4f} "
          f"({(1 - best['mse']/best['const_mse'])*100:.1f}% better)")
    if run is not None:
        run.summary['best/mse'] = best['mse']
        run.summary['best/skill'] = 1 - best['mse'] / best['const_mse']
        if args.head == 'wdl':
            run.summary['best/ce'] = best['ce']
            run.summary['best/ce_skill'] = 1 - best['ce'] / best['const_ce']
            run.summary['best/draw_pred'] = best['draw_pred']
        run.summary['best/rank'] = best['net_rank']
        run.summary['best/heuristic_rank'] = best['baseline_rank']
        run.summary['best/rank_bymap'] = best['net_rank_bymap']
        run.summary['best/heuristic_rank_bymap'] = best['baseline_rank_bymap']
        # Judged per map, not pooled: pooled flatters the net (see evaluate()).
        run.summary['beats_heuristic'] = bool(best['net_rank_bymap'] > best['baseline_rank_bymap'])
        run.finish()

    if args.head == 'wdl':
        share = best['trunk_share']
        if share != share:
            # No edge over the prior means there is nothing to attribute yet.
            print(f"scalars ablated: ce {best['blank_ce']:.4f} vs {best['ce']:.4f} -- "
                  f"net does not beat the class prior, so trunk share is undefined")
        else:
            print(f"scalars ablated: ce {best['blank_ce']:.4f} vs {best['ce']:.4f} -- "
                  f"{share*100:.0f}% of the edge over the prior is the trunk"
                  f"{'  (SHORTCUT: the scalars are doing the work)' if share < 0.5 else ''}")
    if best_rank is not None and best_rank['net_rank_bymap'] > best['net_rank_bymap'] + 1e-9:
        print(f"NOTE: value.pt ranks {best['net_rank_bymap']:.3f} but value-rank.pt "
              f"ranks {best_rank['net_rank_bymap']:.3f} -- play them, do not assume")
    print(f"ranking per map over {best['maps_scored']} maps: net {best['net_rank_bymap']:.3f}, "
          f"heuristic {best['baseline_rank_bymap']:.3f} "
          f"-> {'net wins' if best['net_rank_bymap'] > best['baseline_rank_bymap'] else 'HEURISTIC STILL WINS'}")
    print(f"(pooled, for reference: net {best['net_rank']:.3f}, "
          f"heuristic {best['baseline_rank']:.3f})")


if __name__ == '__main__':
    main()
