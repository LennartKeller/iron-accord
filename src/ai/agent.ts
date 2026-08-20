import type { ActionDescriptor } from './actions.ts';
import type { GameEnvironment } from './environment.ts';

/**
 * Everything that can play.
 *
 * Intentionally minimal: given an environment and the legal moves, choose one.
 * A heuristic agent inspects `env.game` directly, a search agent uses
 * `env.explore()` to try lines and rewind, and a learned policy uses
 * `env.observe()` and ignores the game object entirely.
 */
export interface Agent {
  readonly name: string;
  /**
   * Choose an action. Returning null is equivalent to ending the turn — useful
   * for agents that only implement part of the action space.
   */
  selectAction(env: GameEnvironment, legal: ActionDescriptor[]): ActionDescriptor | null | Promise<ActionDescriptor | null>;
  /** Optional hook at the start of each of this agent's turns. */
  beginTurn?(env: GameEnvironment): void | Promise<void>;
}

export interface MatchOptions {
  /** Hard cap on steps, so a stuck agent cannot hang a training run. */
  maxSteps?: number;
  onStep?(step: number, action: ActionDescriptor, player: number): void;
}

export interface MatchResult {
  winner: number | null;
  days: number;
  steps: number;
  reason: 'victory' | 'step-limit' | 'day-limit';
}

/** Plays agents against each other, one per player index. */
export async function playMatch(
  env: GameEnvironment,
  agents: Agent[],
  options: MatchOptions = {},
): Promise<MatchResult> {
  const maxSteps = options.maxSteps ?? 20_000;
  let steps = 0;
  let lastPlayer = -1;

  while (!env.done && steps < maxSteps) {
    const player = env.currentPlayer;
    const agent = agents[player % agents.length];

    if (player !== lastPlayer) {
      await agent.beginTurn?.(env);
      lastPlayer = player;
    }

    const legal = env.legalActions();
    const chosen = (await agent.selectAction(env, legal)) ?? { kind: 'endTurn' as const };
    options.onStep?.(steps, chosen, player);
    env.step(chosen);
    steps++;
  }

  return {
    winner: env.game.over?.winner ?? null,
    days: env.game.day,
    steps,
    reason: env.game.over ? 'victory' : (steps >= maxSteps ? 'step-limit' : 'day-limit'),
  };
}

/** Reference agent: uniformly random legal moves. Useful as a training opponent and a smoke test. */
export class RandomAgent implements Agent {
  readonly name = 'random';
  private state: number;

  constructor(seed = 1) { this.state = seed >>> 0 || 1; }

  private next(): number {
    // xorshift32 — deterministic so runs reproduce.
    this.state ^= this.state << 13; this.state >>>= 0;
    this.state ^= this.state >> 17;
    this.state ^= this.state << 5;  this.state >>>= 0;
    return this.state / 0x100000000;
  }

  selectAction(_env: GameEnvironment, legal: ActionDescriptor[]): ActionDescriptor | null {
    if (legal.length === 0) return null;
    // Prefer acting over passing while anything else is available.
    const acting = legal.filter(action => action.kind !== 'endTurn');
    const pool = acting.length > 0 ? acting : legal;
    return pool[Math.floor(this.next() * pool.length)] ?? null;
  }
}
