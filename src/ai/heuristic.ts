import type { Agent } from './agent.ts';
import type { GameEnvironment } from './environment.ts';
import type { ActionDescriptor } from './actions.ts';
import type { Unit, Player } from '../host/index.ts';
import {
  unitValue, buildingValue, buildThreatMap, captureTargets, canCapture,
  isCapturable, terrainDefence, type ThreatMap,
} from './evaluate.ts';

/**
 * A hand-written opponent.
 *
 * It scores every legal action in funds and plays the best one, repeatedly,
 * until nothing is worth doing. There is no lookahead: the strength comes from
 * pricing trades correctly and from valuing capture properly, which is what
 * decides most Advance Wars games.
 *
 * Deliberately greedy and stateless between decisions — it re-derives its view
 * each call, so it behaves identically whether driven a step at a time by the
 * UI or in a headless rollout.
 */

export interface HeuristicWeights {
  /** How much of the counter-attack we expect to eat is charged against a trade. */
  counterWeight: number;
  /** Value of one point of expected incoming damage when choosing where to stand. */
  threatWeight: number;
  /** Value per tile of progress toward a capture target. */
  advanceWeight: number;
  /** Multiplier on capture progress, which is how games are actually won. */
  captureWeight: number;
  /** Preference for ending a turn on defensive terrain. */
  coverWeight: number;
  /** Funds kept back rather than spent on the cheapest available unit. */
  reserveFunds: number;
}

export const DEFAULT_WEIGHTS: HeuristicWeights = {
  counterWeight: 0.9,
  threatWeight: 0.35,
  advanceWeight: 140,
  captureWeight: 1.0,
  coverWeight: 90,
  reserveFunds: 0,
};

interface TurnContext {
  self: Player;
  threat: ThreatMap;
  captures: Array<{ x: number; y: number; value: number }>;
  enemyHq: { x: number; y: number } | null;
}

export class HeuristicAgent implements Agent {
  readonly name: string;
  private readonly weights: HeuristicWeights;
  private context: TurnContext | null = null;
  private contextPlayer = -1;

  constructor(weights: Partial<HeuristicWeights> = {}, name = 'heuristic') {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
    this.name = name;
  }

  beginTurn(env: GameEnvironment): void {
    this.context = null;
    this.contextPlayer = env.currentPlayer;
  }

  /**
   * The board view is rebuilt whenever the acting player changes or a previous
   * action invalidated it. Threat maps are the expensive part, so they are not
   * recomputed per candidate action.
   */
  private ensureContext(env: GameEnvironment): TurnContext {
    const player = env.game.currentPlayer;
    if (this.context && this.contextPlayer === env.currentPlayer) return this.context;

    let enemyHq: { x: number; y: number } | null = null;
    for (let y = 0; y < env.game.map.height && !enemyHq; y++) {
      for (let x = 0; x < env.game.map.width; x++) {
        const building = env.game.map.getTerrain(x, y).getBuilding();
        if (building?.getBuildingID() !== 'HQ') continue;
        const owner = building.getOwner();
        if (owner && player.isEnemy(owner)) { enemyHq = { x, y }; break; }
      }
    }

    this.context = {
      self: player,
      threat: buildThreatMap(env.game, player),
      captures: captureTargets(env.game, player),
      enemyHq,
    };
    this.contextPlayer = env.currentPlayer;
    return this.context;
  }

  selectAction(env: GameEnvironment, legal: ActionDescriptor[]): ActionDescriptor | null {
    if (legal.length === 0) return null;
    const context = this.ensureContext(env);

    let best: ActionDescriptor | null = null;
    let bestScore = 0;   // ending the turn scores zero, so only positives act

    for (const action of legal) {
      if (action.kind === 'endTurn') continue;
      const score = this.score(env, context, action);
      if (score > bestScore) {
        bestScore = score;
        best = action;
      }
    }

    // Any action changes the board, so the cached view has to go.
    if (best) this.context = null;
    return best ?? { kind: 'endTurn' };
  }

  private score(env: GameEnvironment, context: TurnContext, action: ActionDescriptor): number {
    if (action.kind === 'build') return this.scoreBuild(env, context, action);
    if (action.kind !== 'unit') return 0;

    const unit = env.game.map.getUnitByUid(action.uid);
    if (!unit) return 0;

    switch (action.actionId) {
      case 'ACTION_FIRE': return this.scoreAttack(env, context, unit, action);
      case 'ACTION_CAPTURE': return this.scoreCapture(env, context, unit, action);
      case 'ACTION_JOIN': return this.scoreJoin(env, unit, action);
      case 'ACTION_LOAD': return 60;    // getting a foot unit moving is usually good
      case 'ACTION_MISSILE': return this.scoreMissile(env, context, action);
      case 'ACTION_WAIT': return this.scorePosition(env, context, unit, action);
      default: return this.scorePosition(env, context, unit, action) * 0.5;
    }
  }

  /** A trade is worth the value destroyed minus the value we expect to lose. */
  private scoreAttack(
    env: GameEnvironment, context: TurnContext, unit: Unit, action: ActionDescriptor,
  ): number {
    if (action.kind !== 'unit' || !action.target) return 0;
    const defender = env.game.map.getUnitAt(action.target.x, action.target.y);

    const preview = env.game.previewBattle(unit, action.to, action.target);
    if (!preview) return 0;

    let gained: number;
    if (defender) {
      const dealt = Math.min(preview.attacker / 10, defender.getHp());
      gained = defender.getCosts() * (dealt / 10);
      // Finishing a unit denies the counter and removes it from the board.
      if (dealt >= defender.getHp()) gained *= 1.35;
    } else {
      // A structure: worth attacking, but far less than an enemy unit.
      const building = env.game.map.getTerrain(action.target.x, action.target.y).getBuilding();
      gained = building ? buildingValue(building) * 0.05 : 400;
    }

    const lost = unit.getCosts() * (Math.min(preview.defender / 10, unit.getHp()) / 10);

    // No exposure term here: an attack already prices the counter it provokes
    // explicitly, and charging the threat map on top double-counts the risk
    // badly enough that the agent refuses every trade.
    return gained - lost * this.weights.counterWeight;
  }

  /** Capturing is how the game is won, so it dominates ordinary positioning. */
  private scoreCapture(
    env: GameEnvironment, context: TurnContext, unit: Unit, action: ActionDescriptor,
  ): number {
    if (action.kind !== 'unit') return 0;
    const building = env.game.map.getTerrain(action.to.x, action.to.y).getBuilding();
    if (!building) return 0;

    const value = buildingValue(building);
    // Progress this tick as a fraction of the 20 points needed.
    const progress = Math.min(unit.getHpRounded(), 20) / 20;
    const exposure = this.exposure(context, unit, action.to);

    return value * progress * this.weights.captureWeight - exposure;
  }

  /** Merging two damaged units recovers value only if both are hurt. */
  private scoreJoin(env: GameEnvironment, unit: Unit, action: ActionDescriptor): number {
    if (action.kind !== 'unit') return 0;
    const other = env.game.map.getUnitAt(action.to.x, action.to.y);
    if (!other) return 0;
    const combined = Math.min(10, unit.getHpRounded() + other.getHpRounded());
    const recovered = combined - Math.max(unit.getHpRounded(), other.getHpRounded());
    return recovered * unit.getCosts() / 10;
  }

  /** A missile is worth the total damage it lands in its blast. */
  private scoreMissile(
    env: GameEnvironment, context: TurnContext, action: ActionDescriptor,
  ): number {
    if (action.kind !== 'unit' || !action.steps?.length) return 0;
    const aim = action.steps[0];
    if (typeof aim === 'string') return 0;

    let value = 0;
    for (const other of env.game.map.units) {
      const distance = Math.abs(other.x - aim.x) + Math.abs(other.y - aim.y);
      if (distance > 2) continue;
      const damage = Math.min(3, other.getHp());
      const worth = other.getCosts() * (damage / 10);
      // Blowing up our own units is a cost, not a benefit.
      value += context.self.isEnemyUnit(other) ? worth : -worth * 1.5;
    }
    return value;
  }

  /**
   * Ordinary movement: get closer to something worth taking, prefer cover, and
   * stay out of the enemy's reach when there is a choice.
   */
  private scorePosition(
    env: GameEnvironment, context: TurnContext, unit: Unit, action: ActionDescriptor,
  ): number {
    if (action.kind !== 'unit') return 0;
    const { x, y } = action.to;

    const objective = this.objectiveFor(context, unit);
    let score = 10;   // acting beats idling

    if (objective) {
      const before = Math.abs(unit.x - objective.x) + Math.abs(unit.y - objective.y);
      const after = Math.abs(x - objective.x) + Math.abs(y - objective.y);
      score += (before - after) * this.weights.advanceWeight;
    }

    // Never park a unit that cannot capture on a building we are trying to
    // take: it blocks our own infantry indefinitely, which is how the first
    // version of this agent stalemated every game it should have won.
    const building = env.game.map.getTerrain(x, y).getBuilding();
    if (building && isCapturable(building) && building.getOwner() !== context.self && !canCapture(unit)) {
      score -= buildingValue(building) * 0.5;
    }

    score += terrainDefence(env.game, unit, x, y) * this.weights.coverWeight;
    score -= this.exposure(context, unit, { x, y });

    // A hurt unit should value safety more than progress.
    if (unit.getHp() <= 5) score -= this.exposure(context, unit, { x, y });
    return score;
  }

  /** What standing here is expected to cost us, in funds. */
  private exposure(context: TurnContext, unit: Unit, at: { x: number; y: number }): number {
    return unit.getCosts() * context.threat.at(at.x, at.y) * this.weights.threatWeight;
  }

  /** What this unit should be walking toward. */
  private objectiveFor(context: TurnContext, unit: Unit): { x: number; y: number } | null {
    if (canCapture(unit) && context.captures.length > 0) {
      // Nearest capture target, weighted by what it is worth.
      let best: { x: number; y: number } | null = null;
      let bestScore = -Infinity;
      for (const target of context.captures) {
        const distance = Math.abs(target.x - unit.x) + Math.abs(target.y - unit.y);
        const score = target.value / (distance + 1);
        if (score > bestScore) { bestScore = score; best = target; }
      }
      return best;
    }
    // Combat units head for the enemy HQ, which is where the fighting will be —
    // but they escort rather than occupy, which the blocking penalty enforces.
    return context.enemyHq;
  }

  /**
   * Production. Foot units are prioritised while there is anything left to
   * capture, because captures compound; otherwise buy the most value per fund.
   */
  private scoreBuild(
    env: GameEnvironment, context: TurnContext, action: ActionDescriptor,
  ): number {
    if (action.kind !== 'build') return 0;
    const player = context.self;
    const cost = this.buildCost(env, action);
    if (cost <= 0 || player.funds - cost < this.weights.reserveFunds) return 0;

    const capturers = player.units.filter(canCapture).length;
    const wantsCapturers = context.captures.length > 0 && capturers < 2 + context.captures.length / 3;

    const script = env.game.registry[action.unitId];
    const isFoot = Array.isArray(script?.actionList) && script.actionList.includes('ACTION_CAPTURE');

    // Spending is only worth it against the alternative of saving, so the score
    // is deliberately modest — an attack or a capture should outrank it.
    let score = cost / 12;
    if (isFoot && wantsCapturers) score += 900;
    if (!isFoot && !wantsCapturers) score += 200;
    // Prefer spending most of the bank rather than dribbling out infantry.
    if (cost > player.funds * 0.6) score += 150;
    return score;
  }

  private buildCost(env: GameEnvironment, action: ActionDescriptor): number {
    if (action.kind !== 'build') return 0;
    const building = env.game.map.getTerrain(action.at.x, action.at.y).getBuilding();
    if (!building) return 0;
    return env.game.buildOptions(building).find(o => o.id === action.unitId)?.cost ?? 0;
  }
}
