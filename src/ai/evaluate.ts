import type { Game } from '../game/game.ts';
import type { Unit, Player, Building } from '../host/index.ts';
import { computeMovementRange } from '../game/pathfinding.ts';
import { threatenedTiles } from '../game/threat.ts';
import type { Belief } from './belief.ts';

/**
 * Scoring primitives the heuristic agent reasons with.
 *
 * Everything is denominated in FUNDS, so damage, captures and production are
 * directly comparable: a unit is worth its build cost scaled by health, and a
 * building is worth roughly what it will earn or deny over the rest of the game.
 */

/** What a unit is worth right now — cost scaled by remaining health. */
export function unitValue(unit: Unit): number {
  return unit.getCosts() * (unit.getHp() / 10);
}

/**
 * What a building is worth to own.
 *
 * An HQ is priced far above anything else because capturing one ends the game;
 * production buildings are worth more than income-only ones because they
 * convert funds into board presence.
 */
export function buildingValue(building: Building): number {
  const id = building.getBuildingID();
  if (id === 'HQ') return 100_000;
  if (building.canBuildUnits()) return 18_000;
  const income = building.getBaseIncome();
  // Roughly ten turns of income, which is the horizon that decides most games.
  return Math.max(2_000, income * 10);
}

export interface ThreatMap {
  /**
   * Roughly what fraction of its health a unit standing here would expect to
   * lose next turn.
   *
   * Deliberately NOT denominated in the enemy's cost: what a tile costs us
   * depends on what WE put there, so callers multiply this by their own unit's
   * value. Pricing it by the attacker's cost made a heavy tank's mere presence
   * outweigh every attack on the board.
   */
  at(x: number, y: number): number;
}

/** Typical damage one attack lands, as a fraction of health. */
const TYPICAL_HIT = 0.5;

/**
 * Where the enemy can hit next turn.
 *
 * Computed once per turn rather than per candidate move: it is only an estimate,
 * and recomputing it inside the scoring loop dominated everything else.
 */
export function buildThreatMap(game: Game, self: Player): ThreatMap {
  const { map } = game;
  const threat = new Float64Array(map.width * map.height);

  for (const player of map.players) {
    if (!self.isEnemy(player) || player.isDefeated) continue;

    for (const enemy of player.units) {
      // Each enemy able to reach the tile contributes about one attack's worth.
      const contribution = TYPICAL_HIT * (enemy.getHp() / 10);
      // Shared with the range overlay the UI draws for a tapped enemy, so the
      // AI and the player are reading the same board.
      for (const tile of threatenedTiles(map, enemy)) {
        // A tile threatened by several units is worse than one threatened
        // once, so these accumulate — capped when read.
        threat[tile.y * map.width + tile.x] += contribution;
      }
    }
  }

  return {
    // Capped: beyond a point, more attackers cannot cost more than the unit.
    at: (x, y) => (map.onMap(x, y) ? Math.min(threat[y * map.width + x], 1.5) : 0),
  };
}

/**
 * Where the enemy can hit next turn, using only what this player knows.
 *
 * Units in view are priced exactly, through the same reach calculation the UI
 * draws. Remembered ones are an estimate: we know what type it was and roughly
 * where, so the reach is approximated as a diamond that widens by one tile per
 * day since the sighting — a tank last seen three days ago could be anywhere
 * within three moves of there — and its contribution decays with age, because
 * acting on a week-old sighting as if it were fact is its own mistake.
 *
 * With fog off every unit is "seen" and this reduces to the exact map.
 */
export function buildBeliefThreatMap(game: Game, self: Player, belief: Belief): ThreatMap {
  const { map } = game;
  const threat = new Float64Array(map.width * map.height);

  for (const known of belief.known()) {
    // The live unit supplies its type's statistics — how far it moves, how far
    // it shoots. Its current position is NOT read: that is the secret.
    const unit = map.getUnitByUid(known.uid);
    if (!unit) continue;
    const contribution = TYPICAL_HIT * (known.hp / 10) * Math.pow(STALENESS_DECAY, known.age);
    if (contribution <= 0.01) continue;

    if (known.seen) {
      for (const tile of threatenedTiles(map, unit)) {
        threat[tile.y * map.width + tile.x] += contribution;
      }
      continue;
    }

    const reach = unit.getMovementpoints() + unit.getMaxRange() + known.age;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > reach) continue;
        const x = known.x + dx;
        const y = known.y + dy;
        if (!map.onMap(x, y)) continue;
        threat[y * map.width + x] += contribution;
      }
    }
  }

  return { at: (x, y) => (map.onMap(x, y) ? Math.min(threat[y * map.width + x], 1.5) : 0) };
}

/** How much a sighting is discounted per day since it was made. */
const STALENESS_DECAY = 0.7;

/** Manhattan distance to the nearest tile matching a predicate, or Infinity. */
export function distanceToNearest(
  game: Game,
  from: { x: number; y: number },
  matches: (x: number, y: number) => boolean,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (let y = 0; y < game.map.height; y++) {
    for (let x = 0; x < game.map.width; x++) {
      if (!matches(x, y)) continue;
      const distance = Math.abs(x - from.x) + Math.abs(y - from.y);
      if (distance < best) best = distance;
    }
  }
  return best;
}

/** Buildings this player would gain by capturing. */
export function captureTargets(game: Game, self: Player): Array<{ x: number; y: number; value: number }> {
  const targets: Array<{ x: number; y: number; value: number }> = [];
  for (let y = 0; y < game.map.height; y++) {
    for (let x = 0; x < game.map.width; x++) {
      const building = game.map.getTerrain(x, y).getBuilding();
      if (!building) continue;
      const owner = building.getOwner();
      if (owner === self) continue;
      if (owner !== null && !self.isEnemy(owner)) continue;
      if (!CAPTURABLE.has(building.getBuildingID())) continue;
      targets.push({ x, y, value: buildingValue(building) });
    }
  }
  return targets;
}

/** ACTION_CAPTURE.capturableBuildings, mirrored so we can score before acting. */
const CAPTURABLE = new Set([
  'AIRPORT', 'FACTORY', 'HARBOUR', 'HQ', 'LABOR', 'MINE', 'PIPESTATION', 'RADAR',
  'TOWER', 'TOWN', 'TEMPORARY_AIRPORT', 'TEMPORARY_HARBOUR', 'OILRIG', 'POWERPLANT',
  'AMPHIBIOUSFACTORY', 'FIELD_BASE',
]);

export function isCapturable(building: Building | null): boolean {
  return building !== null && CAPTURABLE.has(building.getBuildingID());
}

/** Can this unit capture at all? Only foot units carry ACTION_CAPTURE. */
export function canCapture(unit: Unit): boolean {
  return unit.getActionList().includes('ACTION_CAPTURE');
}

/** Terrain defence at a tile, for preferring cover when parking a unit. */
export function terrainDefence(game: Game, unit: Unit, x: number, y: number): number {
  return game.map.getTerrain(x, y).getDefense(unit);
}
