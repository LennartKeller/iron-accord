/**
 * The learned position evaluation, as an Evaluator the planner can use.
 *
 * `capture` runs inside the explore-and-rewind scope, so it must copy everything
 * it needs out of the live board — it packs the position into the same uint8
 * index planes `tools/extract-positions.ts` writes, because the net was trained
 * on exactly that layout and any drift between the two is silent. `score` then
 * runs one batched forward pass for the whole beam layer, which is the reason
 * the Evaluator interface splits in two at all.
 *
 * Node-only: it pulls in onnxruntime-node and the filesystem. The browser wants
 * onnxruntime-web against the same .onnx file — see `loadValueNet` for the split.
 */
import type { Evaluator } from './evaluator.ts';
import { ObservationEncoder } from './observation.ts';
import type { Belief } from './belief.ts';
import type { Game } from '../game/game.ts';
import type { Player } from '../host/index.ts';

/** What `capture` takes out of a position: packed planes plus the global scalars. */
export interface PackedPosition {
  planes: Uint8Array;
  scalars: Float32Array;
  width: number;
  height: number;
}

export interface ValueNetMeta {
  planes: number;
  derivedCount: number;
  terrainCount: number;
  unitCount: number;
  buildingCount: number;
  scalarNames: string[];
  none: number;
}

/** The subset of an onnxruntime session this uses, so both runtimes fit. */
export interface OnnxSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>>;
}

export interface TensorFactory {
  uint8(data: Uint8Array, dims: number[]): unknown;
  float32(data: Float32Array, dims: number[]): unknown;
}

export class ValueNetEvaluator implements Evaluator<PackedPosition> {
  readonly name = 'valuenet';
  private readonly session: OnnxSession;
  private readonly tensors: TensorFactory;
  private readonly meta: ValueNetMeta;
  private readonly encoders = new Map<string, ObservationEncoder>();

  constructor(session: OnnxSession, tensors: TensorFactory, meta: ValueNetMeta) {
    this.session = session;
    this.tensors = tensors;
    this.meta = meta;
  }

  /**
   * Encoders are per board size, and building one walks the whole script
   * registry — far too slow to redo for every position in a beam layer.
   */
  private encoderFor(game: Game): ObservationEncoder {
    const key = `${game.map.width}x${game.map.height}`;
    let encoder = this.encoders.get(key);
    if (!encoder) {
      encoder = ObservationEncoder.fromGame(game);
      this.encoders.set(key, encoder);
    }
    return encoder;
  }

  capture(game: Game, self: Player, _belief: Belief): PackedPosition {
    const encoder = this.encoderFor(game);
    const observation = encoder.encode(game, self.getPlayerID());
    const { width, height } = game.map;
    const planeSize = width * height;
    const { terrainCount, unitCount, buildingCount, derivedCount, none } = this.meta;
    const derivedBase = terrainCount + unitCount + buildingCount;

    const packed = new Uint8Array((3 + derivedCount) * planeSize);
    let cursor = 0;
    for (let group = 0; group < 3; group++) {
      const start = group === 0 ? 0 : group === 1 ? terrainCount : terrainCount + unitCount;
      const size = group === 0 ? terrainCount : group === 1 ? unitCount : buildingCount;
      for (let tile = 0; tile < planeSize; tile++) {
        let found = none;
        for (let c = 0; c < size; c++) {
          if (observation.planes[(start + c) * planeSize + tile] !== 0) { found = c; break; }
        }
        packed[cursor++] = found;
      }
    }
    for (let d = 0; d < derivedCount; d++) {
      const offset = (derivedBase + d) * planeSize;
      for (let tile = 0; tile < planeSize; tile++) {
        const value = observation.planes[offset + tile];
        const clamped = value < 0 ? 0 : value > 1 ? 1 : value;
        packed[cursor++] = Math.round(clamped * 255);
      }
    }

    return { planes: packed, scalars: observation.scalars, width, height };
  }

  async score(batch: PackedPosition[]): Promise<number[]> {
    if (batch.length === 0) return [];
    const { width, height } = batch[0];
    const planeCount = 3 + this.meta.derivedCount;
    const scalarCount = this.meta.scalarNames.length;

    // Every position in a beam layer is the same board, so one tensor covers
    // the layer. A mixed batch would need padding, and never happens here.
    const planes = new Uint8Array(batch.length * planeCount * width * height);
    const scalars = new Float32Array(batch.length * scalarCount);
    for (let i = 0; i < batch.length; i++) {
      planes.set(batch[i].planes, i * planeCount * width * height);
      scalars.set(batch[i].scalars, i * scalarCount);
    }

    const output = await this.session.run({
      planes: this.tensors.uint8(planes, [batch.length, planeCount, height, width]),
      scalars: this.tensors.float32(scalars, [batch.length, scalarCount]),
    });
    const values = output.value.data;
    const scores: number[] = [];
    // The planner compares scores in funds; the net speaks in [-1, 1]. Scaling
    // keeps the two on one axis so a mixed or blended evaluator stays sane.
    for (let i = 0; i < batch.length; i++) scores.push(Number(values[i]) * VALUE_SCALE);
    return scores;
  }
}

/**
 * A win is worth more than any board. The hand-priced evaluation counts funds,
 * so this puts a certain win an order of magnitude above a typical material
 * swing rather than inventing a second unit of account.
 */
export const VALUE_SCALE = 100_000;

/**
 * The value net where it fits in the budget, the hand-priced score everywhere else.
 *
 * The net costs about 1.25 ms per position natively and 10 ms under wasm, against
 * microseconds for `evaluatePosition`. A 250 ms turn therefore buys roughly 200
 * net evaluations in Node and about 24 in a browser, and a beam search given 24
 * evaluations does not merely search less — it plays worse than no search at all.
 * Measured on Central Lake: at 250 ms the net planner wins by day 24, at 60 ms it
 * is still shuffling units on day 201.
 *
 * So the layer is ranked with the cheap score first and only its most promising
 * few are sent to the net. Below the cut a candidate keeps its cheap ordering,
 * placed under everything the net scored — the two scales are never compared
 * directly, only concatenated, which keeps the ranking monotone. The floor of
 * the budget is now heuristic play, which finishes games, rather than a crippled
 * search, which does not.
 */
export class BudgetedValueNet implements Evaluator<{ hand: number; packed: PackedPosition }> {
  readonly name = 'valuenet';
  private readonly net: ValueNetEvaluator;
  private readonly hand: Evaluator<number>;
  private readonly maxPerLayer: number;

  constructor(net: ValueNetEvaluator, hand: Evaluator<number>, maxPerLayer: number) {
    this.net = net;
    this.hand = hand;
    this.maxPerLayer = Math.max(1, maxPerLayer);
  }

  capture(game: Game, self: Player, belief: Belief) {
    // Both are taken inside the explore scope; only the net call is deferred.
    return { hand: this.hand.capture(game, self, belief), packed: this.net.capture(game, self, belief) };
  }

  async score(batch: Array<{ hand: number; packed: PackedPosition }>): Promise<number[]> {
    if (batch.length === 0) return [];
    const order = batch.map((entry, i) => i).sort((a, b) => batch[b].hand - batch[a].hand);
    const cut = Math.min(order.length, this.maxPerLayer);

    const netted = await this.net.score(order.slice(0, cut).map(i => batch[i].packed));
    const out = new Array<number>(batch.length);
    let floor = Infinity;
    for (let rank = 0; rank < cut; rank++) {
      out[order[rank]] = netted[rank];
      if (netted[rank] < floor) floor = netted[rank];
    }
    // Everything past the cut sits below the net's worst pick, still in cheap order.
    for (let rank = cut; rank < order.length; rank++) {
      out[order[rank]] = floor - (rank - cut + 1);
    }
    return out;
  }
}
