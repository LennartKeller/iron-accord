import { unitValue, buildingValue, isCapturable, canCapture, type ThreatMap } from './evaluate.ts';
import { threatenedTiles } from '../game/threat.ts';
import type { Belief } from './belief.ts';
import type { Game } from '../game/game.ts';
import type { Player } from '../host/index.ts';

export interface PositionWeights {
  /** Worth of a point of income per remaining day, against a unit's cost. */
  incomeHorizon: number;
  /** Fraction of a unit's value charged for standing where it can be shot. */
  exposure: number;
  /** Value of a point of capture progress already banked. */
  captureProgress: number;
  /** Value of having the enemies we know about actually in view. */
  contact: number;
  /** Pull toward the nearest thing worth taking, per tile of distance saved. */
  objective: number;
  /** Value of a tile of the board revealed, under shroud. */
  scouting: number;
}

export const DEFAULT_POSITION_WEIGHTS: PositionWeights = {
  incomeHorizon: 6,
  exposure: 0.3,
  captureProgress: 40,
  contact: 600,
  objective: 110,
  scouting: 900,
};

/**
 * What a whole position is worth to a player, in funds.
 *
 * This is the piece the greedy agent has no equivalent of: it scores individual
 * actions, so it cannot tell whether a turn as a whole left the army better or
 * worse off. A planner needs to compare finished turns, which means pricing a
 * board rather than a move.
 *
 * Everything is read through `belief`, so the same function serves a fogged
 * game — an enemy army we have not found is not counted against us, which is
 * exactly why finding it has value, expressed here as the `contact` term.
 */
export function evaluatePosition(
  game: Game,
  self: Player,
  belief: Belief,
  threat: ThreatMap,
  weights: PositionWeights = DEFAULT_POSITION_WEIGHTS,
): number {
  if (game.over) {
    // Terminal positions dwarf anything positional; a loss must never look
    // like a good trade.
    if (game.over.winningTeam === self.getTeam()) return 1e9;
    return -1e9;
  }

  let score = 0;

  for (const unit of self.units) {
    score += unitValue(unit);
    score -= unit.getCosts() * threat.at(unit.x, unit.y) * weights.exposure;
    score += unit.getCapturePoints() * weights.captureProgress;
  }

  // Only enemies we know about. An unfound army costs us nothing here, which is
  // what makes contact worth paying for below.
  for (const known of belief.known()) {
    const unit = game.map.getUnitByUid(known.uid);
    if (unit) score -= unit.getCosts() * (known.hp / 10);
  }

  for (let y = 0; y < game.map.height; y++) {
    for (let x = 0; x < game.map.width; x++) {
      const building = game.map.getTerrain(x, y).getBuilding();
      if (!building || !belief.isExplored(x, y)) continue;
      const owner = building.getOwner();
      const worth = buildingValue(building);
      if (owner === self) score += worth;
      else if (owner && self.isEnemy(owner)) score -= worth;
      // Neutral capturables are potential, not possession: no credit yet.
    }
  }

  score += self.funds;
  score += income(game, self) * weights.incomeHorizon;

  // Knowing where the enemy is has value in itself — it is what lets every
  // other term above be trusted. Deliberately a *fraction* of what we know
  // about rather than a count: counting would make destroying an enemy unit
  // lower the score, so the agent would avoid winning fights.
  const known = belief.known().length;
  score += (known === 0 ? 1 : belief.visibleUnits().length / known) * weights.contact;
  score -= belief.unexploredFraction() * weights.scouting * game.map.width * game.map.height / 100;

  // Progress toward something worth taking. Without this a position is scored
  // purely on what is already owned, so standing still looks exactly as good
  // as advancing and the agent turtles — which is how the first version of
  // this evaluation lost to the greedy agent it was meant to beat.
  score -= approachCost(game, self, belief) * weights.objective;

  return score;
}

/** Summed distance from each unit to the nearest objective it cares about. */
function approachCost(game: Game, self: Player, belief: Belief): number {
  const targets: Array<{ x: number; y: number }> = [];
  let enemyHq: { x: number; y: number } | null = null;
  for (let y = 0; y < game.map.height; y++) {
    for (let x = 0; x < game.map.width; x++) {
      const building = game.map.getTerrain(x, y).getBuilding();
      if (!building || !belief.isExplored(x, y)) continue;
      const owner = building.getOwner();
      if (building.getBuildingID() === 'HQ' && owner && self.isEnemy(owner)) enemyHq = { x, y };
      if (owner === self || !isCapturable(building)) continue;
      if (owner !== null && !self.isEnemy(owner)) continue;
      targets.push({ x, y });
    }
  }

  let total = 0;
  for (const unit of self.units) {
    const pool = canCapture(unit) && targets.length > 0 ? targets : (enemyHq ? [enemyHq] : []);
    let nearest = Infinity;
    for (const target of pool) {
      nearest = Math.min(nearest, Math.abs(unit.x - target.x) + Math.abs(unit.y - target.y));
    }
    if (Number.isFinite(nearest)) total += nearest;
  }
  return total;
}

function income(game: Game, self: Player): number {
  let total = 0;
  for (let y = 0; y < game.map.height; y++) {
    for (let x = 0; x < game.map.width; x++) {
      const building = game.map.getTerrain(x, y).getBuilding();
      if (building?.getOwner() === self && isCapturable(building)) total += 1;
    }
  }
  return total;
}

/**
 * Tiles this player's own units cover, as a crude measure of board control.
 * Exported for tests and for anyone tuning the planner by hand.
 */
export function coveredTiles(game: Game, self: Player): number {
  const covered = new Set<number>();
  for (const unit of self.units) {
    for (const tile of threatenedTiles(game.map, unit)) {
      covered.add(tile.y * game.map.width + tile.x);
    }
  }
  return covered.size;
}
