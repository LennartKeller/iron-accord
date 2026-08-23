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
  /**
   * Lets the policy's END_TURN mass end a plan, instead of being thrown away.
   *
   * The policy head's vocabulary has an END_TURN slot (the final one — see
   * tools/extract-positions.ts), but `topActions` filters endTurn out before
   * ranking, so whatever mass the net puts on stopping is discarded. With this
   * set, endTurn stays in the list `rank` sees, and a frame only expands the
   * candidates the policy ranks above stopping. Expanding endTurn itself would
   * hand the board to the opponent mid-beam and duplicate what `best` already
   * represents — a plan that stops here — so ranking below END_TURN simply
   * means the frame contributes fewer (possibly zero) children, and the
   * incumbent plan stands. Ignored when no policy is loaded.
   *
   * Built to test a specific story for the 1600-node collapse of the policy
   * planner (0.320 v greedy, 0.188 head-to-head v the same net without the
   * policy): that deep in a turn the policy piles its mass on the discarded
   * END_TURN slot and the survivors are ranked by noise. Measurement refuted
   * that story — over real planner layers at 1600 nodes
   * (tools/diag-policy-endturn.ts, 3 held-out maps, ~13k layer-frames), mean
   * p(END_TURN) FALLS with beam depth, 0.027 at depth 0 to 0.0008 at 10+,
   * while the best surviving candidate keeps 0.25-0.35 of the mass and a 5-7
   * nat spread over the median. So this option prunes mostly at shallow
   * depths, where stopping still carries a little mass, and cannot repair the
   * deep collapse. Kept because treating stopping as a rankable move is
   * principled; kept OFF because no measurement yet shows it winning matches.
   */
  policyEndTurn: boolean;
  /**
   * Greedy ordering takes over a frame when the policy has no real opinion:
   * if the best candidate's probability is below this floor, the frame is
   * ordered by `HeuristicAgent.scoreFor` instead. 0 disables it.
   *
   * A guard rail rather than a fix: the same diag-policy-endturn.ts run that
   * refuted the END_TURN story also showed the mean best-candidate mass stays
   * at 0.25-0.35 through depth 10+, so at any floor low enough to respect the
   * policy's confident frames this rarely binds — the 1600-node collapse is
   * not a flat-distribution problem. Expressed as a probability, not a
   * log-probability, because that is the unit the measurement speaks.
   */
  policyGreedyFloor: number;
  /**
   * Beam layers the policy is allowed to order; deeper layers fall back to the
   * greedy scorer. 0, the default, leaves the policy in charge everywhere.
   *
   * The depth profile of the failure picks this shape: with the same net and
   * budgets, policy ordering was neutral at 200 nodes (0.609 v greedy against
   * 0.602 for the net alone; 0.477 head-to-head) and catastrophic at 1600
   * (0.320 v greedy; 0.188 head-to-head, ~5 sigma). A 200-node search expands
   * about ceil(200/36) = 6 layers, a 1600-node one up to maxPlanLength — the
   * only thing the extra budget buys is deeper layers, and those are the
   * layers that turn the policy toxic. Two candidate mechanisms were measured:
   * discarded END_TURN mass (refuted — see policyEndTurn) and correlated
   * selection, where the policy proposes moves its shared trunk overprices, so
   * deep argmax adoption compounds the value head's own errors in a way the
   * greedy ordering's independent errors do not (tools/diag-policy-plans.ts).
   * Capping the policy at the depth a 200-node search reaches keeps it where
   * it measured harmless and hands the deep layers back to the ordering that
   * scored 0.563 at 1600 nodes.
   */
  policyMaxDepth: number;
  /**
   * Opponent actions simulated before a plan may be adopted. 0 disables it,
   * and is the default.
   *
   * The beam expands only the acting player's moves — no endTurn, no reply —
   * so every leaf is a position where the enemy has stood frozen while the
   * plan stacked up unopposed moves, and the evaluator prices that fantasy as
   * if it were real. tools/diag-depth.ts measured what that costs (6
   * validation maps, both seats, fog off, hand evaluator): plans are executed
   * faithfully — 0 of 609 broke mid-turn across both budgets, and end-of-turn
   * reality beat the promise by 700-900 funds on average — but the same
   * promise measured again at the start of the next turn, after the opponent
   * actually replied, was short by an amount that climbs with plan length:
   * roughly 0 for empty plans, +18000 to +20000 funds for plans of 4 or more
   * actions. More nodes adopt longer plans (mean length 3.2 at 200 nodes,
   * 6.3 at 1600), so the mean overpromise rose from 8100 +- 1200 to
   * 13200 +- 1300 funds per turn (+5100 +- 1800, ~2.9 sigma). Deeper search
   * buys systematically less honest promises; that is the depth paradox, and
   * it is why the hand-priced and the learned evaluator degrade at the same
   * rate — neither can see a reply the search never plays. (The rival
   * hypothesis, brittle long commitments, measured exactly zero: no plan ever
   * diverged mid-execution, because explore() preserves the RNG stream and a
   * plan replays with the very dice it was simulated with.)
   *
   * With this set, a plan that would replace the incumbent `best` is first
   * re-scored after a cheap reply: end the turn, let the greedy heuristic play
   * up to this many opponent actions, and evaluate the position that remains
   * from the planner's own seat. Adoption then compares reply-adjusted scores,
   * so a plan only wins by looking good in a world where the opponent moves.
   * One reply per layer at most, so the cost is bounded by maxPlanLength
   * simulations per turn; each counts against the node budget.
   *
   * Caveat: the reply is simulated on the true board, as explored battles
   * already are, so under fog it peeks at unseen enemies. It also plays only
   * the next seat, which is the whole opposition only in a two-player game.
   */
  opponentReplyActions: number;
  /** How positions are scored. Swap in a network without touching the search. */
  evaluator?: Evaluator<unknown>;
  /**
   * Measurement taps for tools/. Undefined in play, and when undefined the
   * search behaves exactly as before — the hooks only observe, never steer.
   */
  diagnostics?: PlannerDiagnostics;
}

/**
 * What the diagnostic taps see. Built for tools/diag-depth.ts, which measures
 * how a plan's promised score compares with the position the game actually
 * reaches — the direct test of whether deeper plans overpromise.
 */
export interface PlannerDiagnostics {
  /** After every `plan()` call, before a single action of it is executed. */
  onPlan?(info: {
    /** `env.game.day * 100 + seat`, to pair with later events on the same turn. */
    turnId: number;
    /** Actions in the adopted plan. 0 means nothing beat standing still. */
    planLength: number;
    /** The adopted plan's evaluator score — what the search promises. */
    predictedScore: number;
    /** The evaluator's score of the position before any action, for the gain. */
    openingScore: number;
    /** Positions actually scored, i.e. the budget really spent. */
    scored: number;
    /** Deepest layer the search expanded, whether or not it was adopted. */
    depthSearched: number;
  }): void;
  /**
   * When a queued action has become illegal and the tail is thrown away.
   * `executed` counts the plan actions that did run before the break.
   */
  onPlanBroken?(info: { turnId: number; executed: number; planned: number }): void;
}

export const DEFAULT_PLANNER_OPTIONS: PlannerOptions = {
  beamWidth: 6,
  branching: 6,
  maxPlanLength: 24,
  timeBudgetMs: 400,
  nodeBudget: 0,
  selectionSigmas: 0,
  policyEndTurn: false,
  policyGreedyFloor: 0,
  policyMaxDepth: 0,
  opponentReplyActions: 0,
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
  /**
   * A second greedy instance for opponent replies. Separate from `ordering`
   * because HeuristicAgent caches a per-player turn view, and the reply plays
   * the other seat mid-search — sharing one instance would poison the cache
   * `topActions` is relying on.
   */
  private readonly replyOrdering = new HeuristicAgent();
  private belief: Belief | null = null;
  private beliefPlayer = -1;
  private queue: ActionDescriptor[] = [];
  private queueTurn = -1;
  /** Length of the plan behind `queue`, for the diagnostics taps only. */
  private queuePlanned = 0;

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
      this.queuePlanned = this.queue.length;
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
      this.options.diagnostics?.onPlanBroken?.({
        turnId,
        executed: this.queuePlanned - this.queue.length,
        planned: this.queuePlanned,
      });
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
    const openingScore = best.score;
    let depthSearched = 0;

    /**
     * The plan's position re-scored after a cheap opponent reply — see
     * `opponentReplyActions`. Runs the plan, ends the turn, lets the greedy
     * heuristic play the next seat for a bounded number of actions, and prices
     * what is left from this planner's own seat. Terminal positions fall
     * through to the evaluator, so a plan that leaves the door open to a loss
     * is priced like one.
     */
    const replyAdjusted = async (actions: ActionDescriptor[]): Promise<number> => {
      let capture: unknown = null;
      env.explore(() => {
        for (const action of actions) {
          if (!applyAction(env.game, action)) return;
        }
        applyAction(env.game, { kind: 'endTurn' });
        this.replyOrdering.beginTurn(env);
        for (let i = 0; i < this.options.opponentReplyActions && !env.game.over; i++) {
          const moves = enumerateActions(env.game, { maxFieldChoices: 4 });
          const choice = this.replyOrdering.selectAction(env, moves);
          if (!choice || choice.kind === 'endTurn') break;
          if (!applyAction(env.game, choice)) break;
        }
        const player = env.game.map.getPlayer(seat);
        if (player) capture = this.evaluator.capture(env.game, player, belief);
      });
      if (capture === null) return -Infinity;
      return (await this.evaluator.score([capture]))[0];
    };

    // Reply-adjusted score of the incumbent, starting from the empty plan.
    // Adoption compares in this currency when the reply is enabled, so a
    // deeper plan has to look good in a world where the opponent moves too.
    let bestReplyScore = -Infinity;
    if (this.options.opponentReplyActions > 0) {
      bestReplyScore = await replyAdjusted([]);
      scored += 1;
    }

    for (let depth = 0; depth < this.options.maxPlanLength; depth++) {
      depthSearched = depth;
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
      // Whether the policy orders this layer: policyMaxDepth hands layers past
      // the cap back to the greedy scorer. See that option for the measurement.
      const policyHere = this.options.policy !== undefined
        && (this.options.policyMaxDepth === 0 || depth < this.options.policyMaxDepth);
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
            capture: policyHere && player
              ? this.options.policy!.capture(env.game, player)
              : null,
          });
        });
      }

      let ranked: number[][] | null = null;
      if (this.options.policy && policyHere && frames.length > 0) {
        // With policyEndTurn the stop action rides along, so its ranking can
        // truncate a frame's expansion; otherwise it is filtered here exactly
        // as topActions will filter it, keeping scores aligned to candidates.
        ranked = await this.options.policy.rank(frames.map(frame => ({
          capture: frame.capture,
          actions: this.options.policyEndTurn
            ? frame.options
            : frame.options.filter(action => action.kind !== 'endTurn'),
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
      if (next[0].score > bar) {
        if (this.options.opponentReplyActions > 0) {
          // The frozen-enemy score got it over the bar; the reply-adjusted
          // score decides. This can only veto an adoption, never promote a
          // plan the raw search disliked — the diagnosed failure is deep
          // plans overpromising, so a veto is the whole correction.
          const adjusted = await replyAdjusted(next[0].actions);
          scored += 1;
          if (adjusted > bestReplyScore) {
            best = next[0];
            bestReplyScore = adjusted;
          }
        } else {
          best = next[0];
        }
      }
      beam = next.slice(0, this.options.beamWidth);
      if (exhausted()) break;
    }

    this.options.diagnostics?.onPlan?.({
      turnId: env.game.day * 100 + env.currentPlayer,
      planLength: best.actions.length,
      predictedScore: best.score,
      openingScore,
      scored,
      depthSearched,
    });
    return best.actions;
  }

  /**
   * The most promising few actions: the policy's ranking when one was computed
   * for this position, the greedy scorer otherwise.
   */
  private topActions(
    env: GameEnvironment, options: ActionDescriptor[], policyScores?: number[],
  ): ActionDescriptor[] {
    // Indices into `options`, because policy scores can be aligned with either
    // the filtered candidates (the default) or the whole list (policyEndTurn
    // sends endTurn through `rank` so its slot's mass is readable here).
    const kept: number[] = [];
    for (let i = 0; i < options.length; i++) {
      if (options[i].kind !== 'endTurn') kept.push(i);
    }
    if (kept.length === 0) return [];
    const aligned = policyScores && policyScores.length === options.length
      ? kept.map(i => policyScores[i])
      : policyScores && policyScores.length === kept.length ? policyScores : null;

    // The floor: a policy with no opinion left about non-stop moves hands the
    // frame back to the greedy scorer. See PlannerOptions.policyGreedyFloor.
    let usePolicy = aligned;
    if (aligned && this.options.policyGreedyFloor > 0) {
      let best = -Infinity;
      for (const score of aligned) if (score > best) best = score;
      if (Math.exp(best) < this.options.policyGreedyFloor) usePolicy = null;
    }
    const scores = usePolicy ?? kept.map(i => this.ordering.scoreFor(env, options[i]));

    let order = kept.map((_, j) => j).sort((a, b) => scores[b] - scores[a]);
    if (usePolicy && this.options.policyEndTurn
        && policyScores && policyScores.length === options.length) {
      // endTurn is a real candidate whose expansion is empty — `best` already
      // prices the plan that stops here — so candidates the policy ranks below
      // stopping are simply not expanded. See PlannerOptions.policyEndTurn.
      let stop = -Infinity;
      for (let i = 0; i < options.length; i++) {
        if (options[i].kind === 'endTurn' && policyScores[i] > stop) stop = policyScores[i];
      }
      order = order.filter(j => scores[j] > stop);
    }
    return order.slice(0, this.options.branching).map(j => options[kept[j]]);
  }
}
