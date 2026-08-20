import { Game } from '../game/game.ts';
import { snapshot, restore, type GameState } from '../game/snapshot.ts';
import { enumerateActions, applyAction, type ActionDescriptor, type EnumerateOptions } from './actions.ts';
import { ObservationEncoder, type Observation } from './observation.ts';
import type { GameMap, Rng } from '../host/index.ts';
import type { ScriptRegistry } from '../scripts/types.ts';

/**
 * A step-based wrapper around a game, in the shape reinforcement-learning code
 * expects: reset / legalActions / step, plus snapshot and restore so a search
 * can explore and rewind.
 *
 * It is deliberately agent-agnostic. A hand-written heuristic, a tree search and
 * a neural policy all see the same interface; the only difference is what they
 * do with `legalActions()` and `observe()`.
 */

export interface StepResult {
  observation: Observation;
  /** Reward for the player who took the action. */
  reward: number;
  done: boolean;
  info: {
    accepted: boolean;
    /** Whose turn it is now. */
    player: number;
    day: number;
    winner: number | null;
  };
}

export interface EnvironmentOptions extends EnumerateOptions {
  /** Unit ids to give observation channels. Defaults to those the map can build. */
  unitVocabulary?: string[];
  /** Turn cap; without one a bad policy can loop indefinitely. */
  maxDays?: number;
  /**
   * The script RNG. `reset()` reseeds it, without which combat luck carries
   * over between episodes and two runs from the same seed diverge.
   */
  rng?: Rng;
  seed?: number;
}

/**
 * Reward shaping.
 *
 * Kept small and explicit so it is easy to change: the terminal win/loss signal
 * dominates, with light shaping for the things that actually decide Advance Wars
 * games — property count and army value.
 */
export function defaultReward(before: GameState, after: GameState, player: number): number {
  const armyValue = (state: GameState) =>
    state.units.filter(u => u.owner === player).reduce((sum, u) => sum + u.hp, 0);
  const enemyValue = (state: GameState) =>
    state.units.filter(u => u.owner !== player).reduce((sum, u) => sum + u.hp, 0);
  const properties = (state: GameState) =>
    state.buildings.filter(b => b.owner === player).length;

  let reward = 0;
  reward += (armyValue(after) - armyValue(before)) * 0.01;
  reward -= (enemyValue(after) - enemyValue(before)) * 0.01;
  reward += (properties(after) - properties(before)) * 0.1;

  if (after.over && !before.over) {
    // Allies share the result, so the seat's team decides the sign.
    reward += after.over.winningTeam === after.players[player]?.team ? 1 : -1;
  }
  return reward;
}

export class GameEnvironment {
  readonly game: Game;
  private encoder: ObservationEncoder;
  private readonly options: EnvironmentOptions;
  private readonly initial: GameState;
  private stepCount = 0;

  constructor(map: GameMap, registry: ScriptRegistry, options: EnvironmentOptions = {}, game?: Game) {
    this.game = game ?? new Game(map, registry);
    this.options = options;
    void this.stepCount;
    this.encoder = ObservationEncoder.fromGame(this.game, options.unitVocabulary ?? this.buildableUnits());
    this.initial = snapshot(this.game);
  }

  /** Unit ids any building on this map can produce — a sensible default vocabulary. */
  private buildableUnits(): string[] {
    const ids = new Set<string>();
    for (let y = 0; y < this.game.map.height; y++) {
      for (let x = 0; x < this.game.map.width; x++) {
        const building = this.game.map.getTerrain(x, y).getBuilding();
        if (!building?.canBuildUnits()) continue;
        for (const id of building.getConstructionList()) ids.add(id);
      }
    }
    for (const unit of this.game.map.units) ids.add(unit.getUnitID());
    return [...ids];
  }

  reset(seed = this.options.seed): Observation {
    restore(this.game, this.initial);
    if (seed !== undefined) this.options.rng?.reseed(seed);
    this.stepCount = 0;
    return this.observe();
  }

  get currentPlayer(): number { return this.game.currentPlayerIndex; }
  get done(): boolean {
    return this.game.over !== null
      || (this.options.maxDays !== undefined && this.game.day > this.options.maxDays);
  }

  observe(player = this.game.currentPlayerIndex): Observation {
    return this.encoder.encode(this.game, player);
  }

  legalActions(): ActionDescriptor[] {
    return enumerateActions(this.game, this.options);
  }

  step(action: ActionDescriptor): StepResult {
    const player = this.game.currentPlayerIndex;
    const before = snapshot(this.game);
    const accepted = applyAction(this.game, action);
    const after = snapshot(this.game);
    this.stepCount++;

    return {
      observation: this.observe(),
      // An illegal action is a small penalty rather than a throw, so a policy
      // that proposes one can learn from it instead of crashing the rollout.
      reward: accepted ? defaultReward(before, after, player) : -0.05,
      done: this.done,
      info: {
        accepted,
        player: this.game.currentPlayerIndex,
        day: this.game.day,
        winner: this.game.over?.winner ?? null,
      },
    };
  }

  snapshot(): GameState { return snapshot(this.game); }
  restore(state: GameState): void { restore(this.game, state); }

  /**
   * Explores a line of play and rewinds, the randomness included.
   *
   * The script RNG is process-wide, so a simulated battle advances the same
   * stream the real game draws from. Restoring the board without restoring the
   * stream would let the AI's deliberation change the dice.
   */
  explore<T>(fn: () => T): T {
    const saved = this.snapshot();
    const rngState = this.options.rng?.getState();
    try {
      return fn();
    } finally {
      this.restore(saved);
      if (rngState !== undefined) this.options.rng?.setState(rngState);
    }
  }
}
