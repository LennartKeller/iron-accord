import { HeuristicAgent } from './heuristic.ts';
import { Belief } from './belief.ts';
import { HeuristicEvaluator, type Evaluator } from './evaluator.ts';
import { DEFAULT_POSITION_WEIGHTS, type PositionWeights } from './position.ts';
import { enumerateActions, applyAction, actionKey, type ActionDescriptor } from './actions.ts';
import type { Agent } from './agent.ts';
import type { GameEnvironment } from './environment.ts';
import type { Player } from '../host/index.ts';
import type { Game } from '../game/game.ts';

export interface PlannerOptions {
  /** Plans kept at each step. Wider searches more orderings and costs linearly. */
  beamWidth: number;
  /** Candidate actions expanded per plan per step, ordered by the greedy score. */
  branching: number;
  /** Hard cap on actions in one plan, so a large army cannot run away with it. */
  maxPlanLength: number;
  /** Wall-clock budget per turn, in milliseconds. */
  timeBudgetMs: number;
  /**
   * Positions the evaluator may score per turn. 0 leaves the clock in charge.
   *
   * A wall-clock budget makes a match depend on how busy the machine was: the
   * same model, maps, seeds and seats scored 0.672 in a duel that shared the box
   * with a training run and 0.727 in one that did not, because the search fit
   * more nodes into 250 ms. `env.reset(seed)` cannot fix that — the seed pins
   * combat luck, not how much thinking fits in a millisecond.
   *
   * Counting scored positions instead makes a comparison reproducible, which is
   * what a benchmark needs. The shipped agent still wants the clock, because a
   * turn has to end whatever the hardware is doing.
   */
  nodeBudget: number;
  /**
   * How much a deeper plan must beat the incumbent by, in standard deviations
   * of its own layer's scores. 0 keeps the plain argmax.
   *
   * `best` is the maximum over every candidate the search ever scores, and the
   * maximum of a noisy estimator is biased upward — the more candidates, the
   * larger the bias. That is why more search made this agent worse, and
   * measurement says it is the search rather than the evaluation: with a node
   * budget, 200 -> 1600 nodes cost the net planner 0.071 and the hand-priced
   * planner 0.078, the same slope from opposite ends of evaluation quality.
   *
   * The bias scales with the noise, so the threshold does too: a layer's own
   * spread is the estimate of it that costs nothing to compute. A deeper plan
   * has to clear the incumbent by more than the noise that would promote it by
   * accident, which floors the search near the greedy line it started from
   * rather than letting it wander off up its own error.
   */
  selectionSigmas: number;
  position: PositionWeights;
  /**
   * Ranks candidate actions in place of the greedy scorer, when one is loaded.
   *
   * `topActions` is where the hand-priced evaluation has the last word even
   * with a value net installed: the beam only ever expands `branching` moves
   * that `HeuristicAgent.scoreFor` liked, so a move it misprices is never
   * searched, however good the evaluator that would have scored it. A learned
   * policy is the piece that removes that, and it is why the policy head shares
   * the value net's trunk -- ordering and evaluation want the same features.
   */
  policy?: PolicyOrdering;
  /** How positions are scored. Swap in a network without touching the search. */
  evaluator?: Evaluator<unknown>;
}

export const DEFAULT_PLANNER_OPTIONS: PlannerOptions = {
  beamWidth: 6,
  branching: 6,
  maxPlanLength: 24,
  timeBudgetMs: 400,
  nodeBudget: 0,
  selectionSigmas: 0,
  position: DEFAULT_POSITION_WEIGHTS,
};

/**
 * A move-ordering policy: score the candidates, best first.
 *
 * Async because the implementation is a network forward pass, and batched over
 * the whole candidate list for the same reason `Evaluator` splits capture from
 * score -- one call per layer rather than one per move.
 */
export interface PolicyOrdering<Capture = unknown> {
  /** Runs inside the explored position; must not retain the live game. */
  capture(game: Game, self: Player): Capture;
  /** Runs outside it, on a whole beam layer: one score per action, per position. */
  rank(batch: Array<{ capture: Capture; actions: ActionDescriptor[] }>): Promise<number[][]>;
}

interface Plan {
  actions: ActionDescriptor[];
  score: number;
}

/**
 * A turn-planning agent.
 *
 * Where the heuristic agent picks the best single action and repeats, this one
 * searches for the best *turn*: a beam search over sequences of actions, scoring
 * the position each sequence arrives at rather than the actions themselves.
 *
 * That difference is the point. Greedy play is order-dependent — the first unit
 * to move takes the best tile and the rest make do — and it cannot express a
 * plan whose parts are only good together, like moving a tank up so artillery
 * behind it is worth keeping. Comparing finished turns handles both.
 *
 * Everything it knows comes through a Belief, so it plays fog honestly: it
 * reasons about enemies it has seen or remembers, and it is rewarded for
 * keeping them in view rather than being handed their positions.
 */
export class PlannerAgent implements Agent {
  readonly name: string;
  private readonly options: PlannerOptions;
  private readonly evaluator: Evaluator<unknown>;
  /** Move ordering. The greedy agent is a good, cheap policy for that job. */
  private readonly ordering = new HeuristicAgent();
  private belief: Belief | null = null;
  private beliefPlayer = -1;
  private queue: ActionDescriptor[] = [];
  private queueTurn = -1;

  constructor(options: Partial<PlannerOptions> = {}, name = 'planner') {
    this.options = { ...DEFAULT_PLANNER_OPTIONS, ...options };
    this.evaluator = this.options.evaluator ?? new HeuristicEvaluator(this.options.position);
    this.name = name;
  }

  beginTurn(env: GameEnvironment): void {
    this.ordering.beginTurn(env);
    this.queue = [];
    this.queueTurn = -1;
    this.beliefFor(env.game.currentPlayer).observe(env.game);
  }

  /** One Belief per seat, kept across turns — that is what memory means. */
  private beliefFor(player: Player): Belief {
    if (!this.belief || this.beliefPlayer !== player.getPlayerID()) {
      this.belief = new Belief(player);
      this.beliefPlayer = player.getPlayerID();
    }
    return this.belief;
  }

  async selectAction(env: GameEnvironment, legal: ActionDescriptor[]): Promise<ActionDescriptor | null> {
    if (legal.length === 0) return null;
    const turnId = env.game.day * 100 + env.currentPlayer;

    // Replan when the turn changes, or when the plan's next step has become
    // illegal — combat rolls luck, so a battle can end differently from the
    // average-damage estimate the search planned against.
    if (this.queueTurn !== turnId) {
      // Note the belief is NOT reset here: memory of where the enemy was is
      // the whole point of it, and rebuilding it each turn would leave the
      // agent permanently surprised. beliefFor only starts over if the seat
      // changes, which one instance per seat never does.
      this.beliefFor(env.game.currentPlayer).observe(env.game);
      this.queue = await this.plan(env, legal);
      this.queueTurn = turnId;
    }

    if (this.queue.length > 0) {
      const next = this.queue[0];
      if (new Set(legal.map(actionKey)).has(actionKey(next))) {
        this.queue.shift();
        return next;
      }
      // The plan has diverged — a battle rolled differently from the estimate
      // it was built against. The rest of it was reasoned about on a board
      // that no longer exists, so discard the lot rather than execute a tail
      // that no longer makes sense.
      this.queue = [];
    }

    return this.ordering.selectAction(env, legal);
  }

  /**
   * Beam search over the rest of the turn.
   *
   * Each layer is expanded in full, capturing what the evaluator needs from
   * every child while its position still exists, and only then scored — one
   * batched call per layer rather than one per child.
   */
  private async plan(env: GameEnvironment, legal: ActionDescriptor[]): Promise<ActionDescriptor[]> {
    const deadline = Date.now() + this.options.timeBudgetMs;
    // Whichever limit is in force, `spent` is what the search has actually used.
    const nodeBudget = this.options.nodeBudget;
    let scored = 0;
    const exhausted = () => nodeBudget > 0 ? scored >= nodeBudget : Date.now() > deadline;
    const self = env.game.currentPlayer;
    const seat = self.getPlayerID();
    const belief = this.beliefFor(self);

    let beam: Plan[] = [{ actions: [], score: -Infinity }];
    let best: Plan = { actions: [], score: -Infinity };

    // The position as it stands, so a turn that does nothing has a price.
    const opening = this.evaluator.capture(env.game, self, belief);
    best.score = (await this.evaluator.score([opening]))[0];
    scored += 1;

    for (let depth = 0; depth < this.options.maxPlanLength; depth++) {
      const pending: Array<{ actions: ActionDescriptor[]; capture: unknown }> = [];

      /**
       * Two passes over the beam when a policy is ranking, one when it is not.
       *
       * `explore` rewinds synchronously, so nothing inside it may await — but a
       * network policy is a forward pass, and running one per plan would cost
       * more than the search it is guiding. So the first pass only reads each
       * plan's position and the moves legal there, the ranking happens once for
       * the whole layer outside any explore scope, and the second pass expands.
       * Replaying a plan's actions is cheap next to a forward pass per plan.
       */
      const frames: Array<{ plan: Plan; options: ActionDescriptor[]; capture: unknown }> = [];
      for (const plan of beam) {
        if (exhausted()) break;
        env.explore(() => {
          for (const action of plan.actions) applyAction(env.game, action);
          const options = depth === 0 && plan.actions.length === 0
            ? legal
            : enumerateActions(env.game, { maxFieldChoices: 4 });
          const player = env.game.map.getPlayer(seat);
          frames.push({
            plan,
            options,
            capture: this.options.policy && player
              ? this.options.policy.capture(env.game, player)
              : null,
          });
        });
      }

      let ranked: number[][] | null = null;
      if (this.options.policy && frames.length > 0) {
        ranked = await this.options.policy.rank(frames.map(frame => ({
          capture: frame.capture,
          actions: frame.options.filter(action => action.kind !== 'endTurn'),
        })));
      }

      for (let index = 0; index < frames.length; index++) {
        const frame = frames[index];
        env.explore(() => {
          for (const action of frame.plan.actions) applyAction(env.game, action);

          for (const candidate of this.topActions(env, frame.options, ranked?.[index])) {
            env.explore(() => {
              if (!applyAction(env.game, candidate)) return;
              const player = env.game.map.getPlayer(seat);
              if (!player) return;
              pending.push({
                actions: [...frame.plan.actions, candidate],
                capture: this.evaluator.capture(env.game, player, belief),
              });
            });
          }
        });
      }

      if (pending.length === 0) break;
      const scores = await this.evaluator.score(pending.map(entry => entry.capture));
      scored += pending.length;
      const next: Plan[] = pending.map((entry, i) => ({ actions: entry.actions, score: scores[i] }));

      next.sort((a, b) => b.score - a.score);
      // The bar rises with how noisy this layer looks, not with a fixed number,
      // so one threshold serves an evaluator scoring in funds and one scoring
      // in [-1, 1].
      let bar = best.score;
      if (this.options.selectionSigmas > 0 && next.length > 1) {
        let sum = 0;
        for (const plan of next) sum += plan.score;
        const mean = sum / next.length;
        let variance = 0;
        for (const plan of next) variance += (plan.score - mean) ** 2;
        const spread = Math.sqrt(variance / next.length);
        bar += this.options.selectionSigmas * spread;
      }
      if (next[0].score > bar) best = next[0];
      beam = next.slice(0, this.options.beamWidth);
      if (exhausted()) break;
    }

    return best.actions;
  }

  /**
   * The most promising few actions: the policy's ranking when one was computed
   * for this position, the greedy scorer otherwise.
   */
  private topActions(
    env: GameEnvironment, options: ActionDescriptor[], policyScores?: number[],
  ): ActionDescriptor[] {
    const candidates = options.filter(action => action.kind !== 'endTurn');
    if (candidates.length === 0) return [];
    const scores = policyScores && policyScores.length === candidates.length
      ? policyScores
      : candidates.map(action => this.ordering.scoreFor(env, action));
    const order = candidates.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
    return order.slice(0, this.options.branching).map(i => candidates[i]);
  }
}
