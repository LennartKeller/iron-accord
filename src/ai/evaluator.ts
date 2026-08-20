import { buildBeliefThreatMap } from './evaluate.ts';
import { evaluatePosition, DEFAULT_POSITION_WEIGHTS, type PositionWeights } from './position.ts';
import type { Belief } from './belief.ts';
import type { Game } from '../game/game.ts';
import type { Player } from '../host/index.ts';

/**
 * How a search scores the positions it reaches, in two stages.
 *
 * The split exists for the network that will replace the hand-written scoring.
 * A position only exists inside the explore-and-rewind scope that produced it,
 * so anything the scorer needs has to be taken while it is still there —
 * `capture` runs inside, `score` runs outside on the whole batch at once.
 *
 * For arithmetic scoring the batch is pointless, but for a neural evaluator it
 * is the difference between one forward pass per turn and several hundred: the
 * beam expands a whole layer before ranking it, so the layer is the batch.
 */
export interface Evaluator<Capture> {
  readonly name: string;
  /** Runs inside the explored position; must not retain the live game. */
  capture(game: Game, self: Player, belief: Belief): Capture;
  /** Runs once per beam layer, on everything captured from it. */
  score(batch: Capture[]): number[] | Promise<number[]>;
}

/**
 * The hand-priced evaluation, in batched clothing.
 *
 * It scores while capturing, because the arithmetic needs the live board and
 * costs nothing; `score` is then the identity. That keeps one code path in the
 * planner whichever evaluator is plugged in.
 */
export class HeuristicEvaluator implements Evaluator<number> {
  readonly name = 'heuristic';
  private readonly weights: PositionWeights;

  constructor(weights: PositionWeights = DEFAULT_POSITION_WEIGHTS) {
    this.weights = weights;
  }

  capture(game: Game, self: Player, belief: Belief): number {
    return evaluatePosition(game, self, belief, buildBeliefThreatMap(game, self, belief), this.weights);
  }

  score(batch: number[]): number[] { return batch; }
}
