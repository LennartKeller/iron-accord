import { HeuristicAgent } from './heuristic.ts';
import { Belief } from './belief.ts';
import { buildBeliefThreatMap } from './evaluate.ts';
import { evaluatePosition, DEFAULT_POSITION_WEIGHTS, type PositionWeights } from './position.ts';
import { enumerateActions, applyAction, actionKey, type ActionDescriptor } from './actions.ts';
import type { Agent } from './agent.ts';
import type { GameEnvironment } from './environment.ts';
import type { Player } from '../host/index.ts';

export interface PlannerOptions {
  /** Plans kept at each step. Wider searches more orderings and costs linearly. */
  beamWidth: number;
  /** Candidate actions expanded per plan per step, ordered by the greedy score. */
  branching: number;
  /** Hard cap on actions in one plan, so a large army cannot run away with it. */
  maxPlanLength: number;
  /** Wall-clock budget per turn, in milliseconds. */
  timeBudgetMs: number;
  position: PositionWeights;
}

export const DEFAULT_PLANNER_OPTIONS: PlannerOptions = {
  beamWidth: 6,
  branching: 6,
  maxPlanLength: 24,
  timeBudgetMs: 400,
  position: DEFAULT_POSITION_WEIGHTS,
};

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
  /** Move ordering. The greedy agent is a good, cheap policy for that job. */
  private readonly ordering = new HeuristicAgent();
  private belief: Belief | null = null;
  private beliefPlayer = -1;
  private queue: ActionDescriptor[] = [];
  private queueTurn = -1;

  constructor(options: Partial<PlannerOptions> = {}, name = 'planner') {
    this.options = { ...DEFAULT_PLANNER_OPTIONS, ...options };
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

  selectAction(env: GameEnvironment, legal: ActionDescriptor[]): ActionDescriptor | null {
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
      this.queue = this.plan(env, legal);
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

  /** Beam search over the rest of the turn. */
  private plan(env: GameEnvironment, legal: ActionDescriptor[]): ActionDescriptor[] {
    const deadline = Date.now() + this.options.timeBudgetMs;
    const self = env.game.currentPlayer;
    const belief = this.beliefFor(self);

    let beam: Plan[] = [{ actions: [], score: -Infinity }];
    let best: Plan = { actions: [], score: this.evaluate(env, self, belief) };

    for (let depth = 0; depth < this.options.maxPlanLength; depth++) {
      const next: Plan[] = [];

      for (const plan of beam) {
        if (Date.now() > deadline) break;

        env.explore(() => {
          for (const action of plan.actions) applyAction(env.game, action);
          const options = depth === 0 && plan.actions.length === 0
            ? legal
            : enumerateActions(env.game, { maxFieldChoices: 4 });

          for (const candidate of this.topActions(env, options)) {
            env.explore(() => {
              if (!applyAction(env.game, candidate)) return;
              next.push({
                actions: [...plan.actions, candidate],
                score: this.evaluate(env, env.game.map.getPlayer(self.getPlayerID())!, belief),
              });
            });
          }
        });
      }

      if (next.length === 0) break;
      next.sort((a, b) => b.score - a.score);
      if (next[0].score > best.score) best = next[0];
      beam = next.slice(0, this.options.beamWidth);
      if (Date.now() > deadline) break;
    }

    return best.actions;
  }

  /** The most promising few actions, ranked by the greedy scorer. */
  private topActions(env: GameEnvironment, options: ActionDescriptor[]): ActionDescriptor[] {
    const scored = options
      .filter(action => action.kind !== 'endTurn')
      .map(action => ({ action, score: this.ordering.scoreFor(env, action) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, this.options.branching).map(entry => entry.action);
  }

  private evaluate(env: GameEnvironment, self: Player, belief: Belief): number {
    const threat = buildBeliefThreatMap(env.game, self, belief);
    return evaluatePosition(env.game, self, belief, threat, this.options.position);
  }
}
