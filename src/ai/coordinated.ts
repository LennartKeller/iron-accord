import type { Agent } from './agent.ts';
import type { ActionDescriptor } from './actions.ts';
import type { GameEnvironment } from './environment.ts';
import { NormalAi } from './cw/normalai.ts';
import { planOffensive } from './coordinated-planner.ts';

export interface CoordinatedAiOptions { seed?: number }

interface PendingAttack {
  targetUid: number;
  actorUid: number;
  to: { x: number; y: number };
}

const MAX_SEARCHES_PER_TURN = 12;
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Experimental same-turn focus fire, with NormalAi handling ordinary orders.
 * Owns no host objects in saved state. Each committed shot invalidates the
 * predicted suffix: remaining attacks are recalculated against the actual board.
 * The entire group acts before fallback orders can spend its participants.
 */
export class CoordinatedAi implements Agent {
  readonly name = 'coordinated';
  private readonly fallback: NormalAi;
  private day = -1;
  private player = -1;
  private searches = 0;
  private pending: PendingAttack | null = null;
  private blockedTargets = new Set<number>();

  constructor(options: CoordinatedAiOptions = {}) {
    this.fallback = new NormalAi({ seed: options.seed });
  }

  beginTurn(env: GameEnvironment): void {
    const game = env.game;
    if (this.day !== game.day || this.player !== game.currentPlayerIndex) {
      this.day = game.day;
      this.player = game.currentPlayerIndex;
      this.searches = 0;
      this.pending = null;
      this.blockedTargets.clear();
    }
    // Also called on a mid-turn resume. Persistent objective/budget survive;
    // fallback's transient movement and forecast caches are rebuilt.
    this.fallback.beginTurn(env);
  }

  async selectAction(env: GameEnvironment): Promise<ActionDescriptor | null> {
    const game = env.game;
    if (game.over) return null;
    if (this.day !== game.day || this.player !== game.currentPlayerIndex) this.beginTurn(env);

    const previous = this.pending;
    this.pending = null;
    if (previous) {
      const actor = game.map.getUnitByUid(previous.actorUid);
      const committed = !actor || (actor.getHasMoved()
        && actor.x === previous.to.x && actor.y === previous.to.y);
      const target = game.map.getUnitByUid(previous.targetUid);
      // A rejected move or ambush must not repeatedly retry the same offensive.
      if (!committed) this.blockedTargets.add(previous.targetUid);
      if (committed && target && !target.isStealthed(game.currentPlayer)
        && game.currentPlayer.isEnemy(target.getOwner()) && this.searches < MAX_SEARCHES_PER_TURN) {
        this.searches++;
        const continuation = planOffensive(game, { targetUid: previous.targetUid, minParticipants: 1 });
        if (continuation) return this.issue(continuation.targetUid, continuation.actions[0]);
        this.blockedTargets.add(previous.targetUid);
      }
      this.fallback.beginTurn(env);
    }

    // Leave enough budget to re-evaluate a four-unit group's remaining shots.
    if (this.searches <= MAX_SEARCHES_PER_TURN - 4) {
      this.searches++;
      const plan = planOffensive(game, { excludedTargets: this.blockedTargets });
      if (plan) return this.issue(plan.targetUid, plan.actions[0]);
    }
    return this.fallback.selectAction(env);
  }

  private issue(targetUid: number, action: ActionDescriptor): ActionDescriptor {
    if (action.kind !== 'unit') throw new Error('Offensive planner returned a non-unit action');
    this.pending = { targetUid, actorUid: action.uid, to: { ...action.to } };
    return action;
  }

  saveState(): unknown {
    return { version: 1, fallback: this.fallback.saveState(), day: this.day, player: this.player,
      searches: this.searches, pending: this.pending ? { ...this.pending, to: { ...this.pending.to } } : null,
      blockedTargets: [...this.blockedTargets] };
  }

  loadState(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const state = value as Record<string, unknown>;
    if (state.version !== 1) return;
    this.fallback.loadState(state.fallback);
    this.day = -1;
    this.player = -1;
    this.searches = 0;
    this.pending = null;
    this.blockedTargets.clear();
    if (!integer(state.day) || !integer(state.player) || !integer(state.searches)
      || state.searches > MAX_SEARCHES_PER_TURN) return;
    this.day = state.day;
    this.player = state.player;
    this.searches = state.searches;
    if (Array.isArray(state.blockedTargets)) {
      this.blockedTargets = new Set(state.blockedTargets.filter(integer).slice(0, MAX_SEARCHES_PER_TURN));
    }
    if (!state.pending || typeof state.pending !== 'object') return;
    const pending = state.pending as Record<string, unknown>;
    const to = pending.to as Record<string, unknown> | null;
    if (integer(pending.targetUid) && integer(pending.actorUid) && to && typeof to === 'object'
      && integer(to.x) && integer(to.y)) {
      this.pending = { targetUid: pending.targetUid, actorUid: pending.actorUid, to: { x: to.x, y: to.y } };
    }
  }
}
