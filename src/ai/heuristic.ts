import type { Agent } from './agent.ts';
import type { GameEnvironment } from './environment.ts';
import type { ActionDescriptor } from './actions.ts';
import type { Unit, Player } from '../host/index.ts';
import { computeMovementRange } from '../game/pathfinding.ts';
import {
  unitValue, buildingValue, buildThreatMap, captureTargets, canCapture,
  isCapturable, terrainDefence, type ThreatMap,
} from './evaluate.ts';
import { Navigator, UNREACHABLE } from './navigation.ts';
import type { Game } from '../game/game.ts';

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
  /**
   * How hard to push ferrying infantry across water. Zero falls back to a flat
   * value for boarding and no special handling for landing, which is how the
   * agent behaved before transports were scored at all.
   */
  transportWeight: number;
  /**
   * How much a unit's matchup against the enemy's actual army is worth.
   *
   * Production was scored almost entirely by price (`cost / 12`), so the agent
   * bought whatever was most expensive and never asked what it was for. On a
   * map with no pipes that buys PIPERUNNERs -- immobile, and parked on the
   * factory that built them -- and two agents doing it to each other produce a
   * drawn game neither can end. It also explains a build list topped by
   * MEGATANK and STEALTHBOMBER regardless of what the opponent fields.
   *
   * Zero restores the price-only behaviour.
   */
  matchupWeight: number;
}

export const DEFAULT_WEIGHTS: HeuristicWeights = {
  counterWeight: 0.9,
  threatWeight: 0.35,
  advanceWeight: 140,
  captureWeight: 1.0,
  coverWeight: 90,
  reserveFunds: 0,
  transportWeight: 1,
  // Untuned: chosen so a good matchup is worth a few hundred points against the
  // capturer bonus of 900, not fitted. Weight search has failed twice on this
  // agent and is not worth a third attempt -- see the handoff.
  matchupWeight: 1,
};

interface TurnContext {
  self: Player;
  threat: ThreatMap;
  captures: Array<{ x: number; y: number; value: number }>;
  enemyHq: { x: number; y: number } | null;
  /** Distance to the nearest objective, by movement type, respecting terrain. */
  navigator: Navigator;
  /** Tiles a transport can drop a capturer where it can then walk to work. */
  dropOffs: Navigator;
}

/**
 * How often, and how widely, the agent departs from its best move.
 *
 * Only for generating training data, and the reason is the whole difficulty
 * with learning a value function here. This agent is deterministic, so from any
 * position exactly ONE continuation is ever recorded: the data never says what
 * would have happened after a different move. A value net trained on it cannot
 * learn to tell sibling positions apart, because it has never seen a
 * counterfactual — and sibling positions are the only thing a beam search ever
 * compares. Measured on the shipped datasets: within-game, within-seat label
 * variance is exactly zero.
 *
 * The dose matters. `--agents random,heuristic` was tried and made the net
 * WORSE, because uniformly random play visits boards no competent player
 * reaches, and a value learned there does not transfer. Sampling among the
 * agent's own top few actions keeps the trajectory close to real play while
 * making the same position resolve differently across games, which is what
 * AlphaZero's temperature sampling buys and what this data has never had.
 */
export interface ExplorationOptions {
  /** Chance of sampling instead of taking the best action. 0 is deterministic. */
  epsilon: number;
  /** How many of the top-scoring actions to sample among. */
  topK: number;
  /** Seed, so a generated game stays reproducible from its replay. */
  seed: number;
}

/** The best base damage any of `attacker`'s weapons does to `defender`. */
function bestBaseDamage(map: Unit['map'], attacker: Unit, defender: Unit): number {
  let best = 0;
  for (const weaponID of [attacker.weapon1ID, attacker.weapon2ID]) {
    if (!weaponID) continue;
    const damage = map.registry[weaponID]?.getBaseDamage?.(defender);
    if (typeof damage === 'number' && damage > best) best = damage;
  }
  return best;
}

export class HeuristicAgent implements Agent {
  readonly name: string;
  private readonly weights: HeuristicWeights;
  private context: TurnContext | null = null;
  private contextPlayer = -1;
  /** Whether a unit id can move at all on this board; see canEverMove. */
  private readonly mobility = new Map<string, boolean>();
  /** Matchup value per unit id and build tile; see matchupValue. */
  private readonly matchups = new Map<string, number>();
  private readonly exploration: ExplorationOptions | null;
  private rngState: number;

  constructor(
    weights: Partial<HeuristicWeights> = {},
    name = 'heuristic',
    exploration: ExplorationOptions | null = null,
  ) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
    this.name = name;
    this.exploration = exploration && exploration.epsilon > 0 ? exploration : null;
    this.rngState = (exploration?.seed ?? 1) >>> 0 || 1;
  }

  /**
   * Mulberry32, kept private to the agent.
   *
   * Deliberately NOT the shared script RNG: that one is rewound by `explore()`
   * so deliberation cannot consume the game's luck, and drawing exploration
   * from it would make the sampled move depend on how much the agent thought.
   */
  private random(): number {
    this.rngState = (this.rngState + 0x6D2B79F5) >>> 0;
    let t = this.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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

    const captures = captureTargets(env.game, player);
    const goals = captures.length > 0 ? captures : (enemyHq ? [enemyHq] : []);
    this.context = {
      self: player,
      threat: buildThreatMap(env.game, player),
      captures,
      enemyHq,
      navigator: new Navigator(env.game.map, goals),
      dropOffs: new Navigator(env.game.map, landingSites(env.game, player, goals)),
    };
    this.contextPlayer = env.currentPlayer;
    return this.context;
  }

  selectAction(env: GameEnvironment, legal: ActionDescriptor[]): ActionDescriptor | null {
    if (legal.length === 0) return null;
    const context = this.ensureContext(env);

    // Ending the turn scores zero, so only positive-scoring actions ever act.
    const scored: Array<{ action: ActionDescriptor; score: number }> = [];
    for (const action of legal) {
      if (action.kind === 'endTurn') continue;
      const score = this.score(env, context, action);
      if (score > 0) scored.push({ action, score });
    }

    let best: ActionDescriptor | null = null;
    if (scored.length > 0) {
      scored.sort((a, b) => b.score - a.score);
      // Sampling among the top few, not among everything: the tail is full of
      // actively bad moves, and playing those produces the off-distribution
      // positions that made the random-agent slice hurt.
      const sample = this.exploration
        && scored.length > 1
        && this.random() < this.exploration.epsilon;
      const cut = sample ? Math.min(this.exploration!.topK, scored.length) : 1;
      best = scored[sample ? Math.floor(this.random() * cut) : 0].action;
    }

    // Any action changes the board, so the cached view has to go.
    if (best) this.context = null;
    return best ?? { kind: 'endTurn' };
  }

  /**
   * The greedy score for one action, with the turn view built on demand.
   * Exposed so a search agent can borrow this as its move-ordering policy —
   * a cheap, decent ranking is exactly what a beam needs to decide what to
   * expand first.
   */
  scoreFor(env: GameEnvironment, action: ActionDescriptor): number {
    return this.score(env, this.ensureContext(env), action);
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
      case 'ACTION_LOAD': return this.scoreLoad(env, context, unit, action);
      case 'ACTION_UNLOAD': return this.scoreUnload(env, context, unit, action);
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

  /**
   * Boarding a transport.
   *
   * Worth a great deal when the unit has no route to anything on its own —
   * infantry on an island are otherwise dead weight for the whole game — and
   * worth very little when it can already walk there, since a turn spent
   * boarding is a turn not spent capturing.
   */
  private scoreLoad(
    env: GameEnvironment, context: TurnContext, unit: Unit, action: ActionDescriptor,
  ): number {
    if (action.kind !== 'unit') return 0;
    const transport = env.game.map.getUnitAt(action.to.x, action.to.y);
    if (!transport) return 0;

    if (this.weights.transportWeight === 0) return 60;
    const stranded = !context.navigator.canReachGoal(unit);
    // Only useful if the ride is going somewhere the passenger cannot reach.
    const ferryable = context.dropOffs.canReachGoal(transport);
    if (!stranded) return canCapture(unit) ? 40 : 20;
    return (ferryable ? 1500 : 0) * this.weights.transportWeight;
  }

  /**
   * Putting a passenger ashore. Scored by what it can do once it lands, so a
   * transport only unloads where the cargo can actually get to work.
   */
  private scoreUnload(
    env: GameEnvironment, context: TurnContext, unit: Unit, action: ActionDescriptor,
  ): number {
    if (action.kind !== 'unit' || !action.steps?.length) return 0;
    if (this.weights.transportWeight === 0) return this.scorePosition(env, context, unit, action) * 0.5;
    const site = action.steps[0];
    if (typeof site === 'string') return 0;

    const cargo = unit.getLoadedUnit(0);
    if (!cargo) return 0;
    const after = context.navigator.distance(cargo, site.x, site.y);
    if (after === UNREACHABLE) return 0;
    // Landing next to the objective beats landing across the island from it.
    return (1200 - after * 20) * this.weights.transportWeight;
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

    let score = 10;   // acting beats idling

    // Progress is measured in movement cost to the nearest objective this unit
    // can actually reach, not in straight-line distance: a town across water is
    // not two tiles away for infantry, it is unreachable.
    const carrying = unit.getLoadedUnitCount() > 0;
    const field = carrying ? context.dropOffs : context.navigator;
    const before = field.distance(unit, unit.x, unit.y);
    const after = field.distance(unit, x, y);
    if (before !== UNREACHABLE && after !== UNREACHABLE) {
      score += (before - after) * this.weights.advanceWeight;
    } else if (before === UNREACHABLE && after !== UNREACHABLE) {
      score += this.weights.advanceWeight;          // any way in beats none
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
  /**
   * Can a unit of this id enter any tile on this board?
   *
   * Production is otherwise scored mostly by price, which on a map with no
   * pipes buys PIPERUNNERs: expensive, immobile, and parked on the factory that
   * built them, so nothing else can be produced there either. Two agents doing
   * it to each other is a drawn game neither can end -- and a mutual pathology
   * is invisible to a win rate, which is how this survived in 96% of the
   * PIPERUNNERs in the training data (4,900 of 5,095 built on pipeless maps).
   *
   * It has to be REACHABILITY from the factory, not "is any tile enterable":
   * a PIPERUNNER can enter pipe stations and bases, so an enterable-tile test
   * says yes on a map where every route between them is impassable, and the
   * unit is still stuck on the factory that built it.
   *
   * Answered with a probe unit because the movement tables take one, and cached
   * per unit id and build tile: the answer depends only on the board, which
   * does not change within a turn.
   */
  private canEverMove(
    env: GameEnvironment, unitId: string, owner: Player, at: { x: number; y: number },
  ): boolean {
    const cacheKey = `${unitId}@${at.x},${at.y}`;
    const cached = this.mobility.get(cacheKey);
    if (cached !== undefined) return cached;

    const map = env.game.map;
    const uidBefore = map.getUnitUidCounter();
    const probe = map.addUnit(unitId, owner, at.x, at.y);
    // More than its own tile means it can actually leave.
    const mobile = computeMovementRange(map, probe).tiles.size > 1;
    map.removeUnit(probe);
    map.setUnitUidCounter(uidBefore);
    this.mobility.set(cacheKey, mobile);
    return mobile;
  }

  /**
   * What a unit of this id is worth against the enemy army we can actually see.
   *
   * For each visible enemy: the value we expect to destroy, minus the value we
   * expect to lose to it, using the same base-damage tables the attack scorer
   * uses. Averaged over the enemies, so it is a per-engagement expectation
   * rather than a total, and normalised by cost so a cheap effective unit can
   * beat an expensive mismatched one.
   *
   * Only visible enemies count. Reading the whole board here would have the
   * agent countering units it has no way of knowing about, which is both
   * cheating and, under fog, unlearnable for anything imitating it.
   */
  private matchupValue(
    env: GameEnvironment, unitId: string, owner: Player, at: { x: number; y: number },
  ): number {
    const key = `${unitId}@${at.x},${at.y}`;
    const cached = this.matchups.get(key);
    if (cached !== undefined) return cached;

    const map = env.game.map;
    const enemies = map.units.filter(other =>
      owner.isEnemyUnit(other)
      && owner.getFieldVisible(other.x, other.y)
      && !other.isStealthed(owner));

    let score = 0;
    if (enemies.length > 0) {
      const uidBefore = map.getUnitUidCounter();
      const probe = map.addUnit(unitId, owner, at.x, at.y);
      let total = 0;
      for (const enemy of enemies) {
        // Base damage is a percentage of a full-health unit's value.
        const ours = bestBaseDamage(map, probe, enemy) / 100;
        const theirs = bestBaseDamage(map, enemy, probe) / 100;
        total += enemy.getCosts() * ours - probe.getCosts() * theirs;
      }
      score = total / enemies.length;
      map.removeUnit(probe);
      map.setUnitUidCounter(uidBefore);
    }
    this.matchups.set(key, score);
    return score;
  }

  private scoreBuild(
    env: GameEnvironment, context: TurnContext, action: ActionDescriptor,
  ): number {
    if (action.kind !== 'build') return 0;
    const player = context.self;
    const cost = this.buildCost(env, action);
    if (cost <= 0 || player.funds - cost < this.weights.reserveFunds) return 0;
    // Never buy a unit that cannot leave the factory.
    if (!this.canEverMove(env, action.unitId, player, action.at)) return 0;

    const capturers = player.units.filter(canCapture).length;
    const wantsCapturers = context.captures.length > 0 && capturers < 2 + context.captures.length / 3;

    const script = env.game.registry[action.unitId];
    const isFoot = Array.isArray(script?.actionList) && script.actionList.includes('ACTION_CAPTURE');

    // Spending is only worth it against the alternative of saving, so the score
    // is deliberately modest — an attack or a capture should outrank it.
    // Price is a weak proxy for usefulness and used to be the whole signal.
    let score = cost / 12;
    // What this unit is actually for, against what the enemy actually has.
    score += this.matchupValue(env, action.unitId, player, action.at)
      * this.weights.matchupWeight / 12;
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

/**
 * Where a transport can usefully put a passenger down: land tiles a capturer
 * could walk to an objective from, which is what makes a sea crossing worth
 * making at all.
 */
function landingSites(
  game: Game, self: Player, goals: Array<{ x: number; y: number }>,
): Array<{ x: number; y: number }> {
  const carrier = self.units.find(unit => unit.getLoadingPlace() > 0);
  const passenger = carrier?.getLoadedUnit(0) ?? self.units.find(canCapture);
  if (!passenger || goals.length === 0) return goals;

  const walkable = new Navigator(game.map, goals);
  const sites: Array<{ x: number; y: number }> = [];
  for (const goal of goals) {
    // The goal itself, plus anywhere with a land route to it, is a valid place
    // to land; the nearest such tile to the water is what the search will find.
    if (walkable.distance(passenger, goal.x, goal.y) !== UNREACHABLE) sites.push(goal);
  }
  return sites.length > 0 ? sites : goals;
}
