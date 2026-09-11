import type { Game } from '../game/game.ts';
import { computeMovementRange, type MovementRange } from '../game/pathfinding.ts';
import { GameEnums, MAX_UNIT_HP, type BuildingHost, type Unit } from '../host/index.ts';
import type { ActionDescriptor } from './actions.ts';
import { DamagePredictor } from './cw/damage.ts';
import { isKnownBuilding, visibleUnitAt } from './cw/visibility.ts';

export interface OffensivePlan {
  targetUid: number;
  actions: ActionDescriptor[];
  /** Expected funds destroyed minus immediate and subsequent own losses. */
  score: number;
  evaluatedSequences: number;
}
export interface OffensiveOptions {
  targetUid?: number;
  excludedTargets?: ReadonlySet<number>;
  /** A previously started offensive may need only one remaining finisher. */
  minParticipants?: number;
}

type Position = { x: number; y: number };
interface Candidate { unit: Unit; to: Position; risk: number }
interface Sequence {
  choices: Candidate[];
  damage: number;
  loss: number;
  checkpoints: Array<{ damage: number; loss: number }>;
}
const MAX_TARGETS = 6;
const MAX_ACTORS = 8;
const MAX_POSITIONS = 3;
const MAX_PARTICIPANTS = 4;
const BEAM_WIDTH = 12;
const MAX_FORECASTS = 12_000;
const MAX_SEQUENCES = 2_000;
const distance = (a: Position, b: Position) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const same = (a: Position, b: Position) => a.x === b.x && a.y === b.y;

/**
 * Experimental same-turn focus fire, separate from the Commander Wars port.
 * Searches only apparent board state, without mutating units or simulating the
 * live game. We reserve distinct units/endpoints and require a profitable kill.
 * The caller must replan after every actual action: damage is an expectation,
 * and an unseen blocker can still interrupt a legal-looking route.
 *
 * This first version does not plan movement-only orders, newly vacated firing
 * positions, capture exploitation or multi-turn staging. Search breadth and
 * damage forecasts are bounded independently of army size.
 */
export function planOffensive(game: Game, options: OffensiveOptions = {}): OffensivePlan | null {
  if (game.over) return null;
  const { map, currentPlayer: player } = game;
  const minimum = Math.max(1, Math.min(MAX_PARTICIPANTS, options.minParticipants ?? 2));
  const predictor = new DamagePredictor(map);
  const enemies = map.units.filter(unit => player.isEnemyUnit(unit)
    && unit.getHp() > 0 && visibleUnitAt(map, player, unit.x, unit.y) === unit);
  const knownBuildings: BuildingHost[] = [];
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
    const building = map.getTerrain(x, y).getBuilding();
    if (building && isKnownBuilding(building, player)) knownBuildings.push(building);
  }
  const headquarters = knownBuildings.filter(building => building.getOwner() === player
    && building.getBuildingID() === 'HQ');
  const hqCapturers = enemies.filter(enemy => enemy.hasAction('ACTION_CAPTURE')
    && headquarters.some(hq => same(enemy, hq.getPosition())));
  const actors = player.units.filter(unit => !unit.getHasMoved() && unit.getHp() > 0
    && unit.hasAction('ACTION_FIRE') && visibleUnitAt(map, player, unit.x, unit.y) === unit)
    .filter(unit => {
      const building = unit.getTerrain().getBuilding();
      return !(building && isKnownBuilding(building, player) && building.getOwner() !== player
        && (building.getOwner() === null || player.isEnemy(building.getOwner())) && unit.hasAction('ACTION_CAPTURE'));
    });
  if (actors.length < minimum) return null;
  // An immediate HQ capture threat takes precedence over an unrelated attack.
  const targets = enemies.filter(unit => (options.targetUid === undefined || unit.uid === options.targetUid)
    && !options.excludedTargets?.has(unit.uid)
    && actors.filter(actor => distance(actor, unit) <= actor.getMovementpoints() + actor.getMaxRange()
      && actor.isAttackable(unit, true)).length >= minimum
    && (hqCapturers.length === 0 || hqCapturers.includes(unit)))
    .sort((a, b) => b.getCoUnitValue() - a.getCoUnitValue() || a.uid - b.uid).slice(0, MAX_TARGETS);
  const ranges = new Map<number, MovementRange>();
  const rangeOf = (unit: Unit) => {
    let range = ranges.get(unit.uid);
    if (!range) {
      range = computeMovementRange(map, unit, { visibilityPlayer: player,
        // A killed blocker or a participant's vacated origin can open a route.
        // Allowing every hostile crossing overestimates future reach safely.
        ignoreEnemies: player.isEnemyUnit(unit) ? 'all' : 'off' });
      ranges.set(unit.uid, range);
    }
    return range;
  };
  let forecasts = 0;
  let evaluatedSequences = 0;
  let best: OffensivePlan | null = null;
  const predict = (attacker: Unit, at: Position, defender: Unit, taken: number, to: Position) => {
    if (++forecasts > MAX_FORECASTS) return null;
    return predictor.calcVirtualUnitDamage(attacker, 0, at, defender, taken, to,
      GameEnums.LuckDamageMode_Average, GameEnums.LuckDamageMode_Average, true);
  };

  for (const target of targets) {
    if (forecasts >= MAX_FORECASTS || evaluatedSequences >= MAX_SEQUENCES) break;
    const candidates: Candidate[] = [];
    const nearby = actors.filter(unit => distance(unit, target) <= unit.getMovementpoints() + unit.getMaxRange()
      && unit.isAttackable(target, true))
      .sort((a, b) => predictor.getBaseDamage(b, target) * b.getHp()
        - predictor.getBaseDamage(a, target) * a.getHp() || a.uid - b.uid).slice(0, MAX_ACTORS);
    for (const unit of nearby) {
      if (forecasts >= MAX_FORECASTS) break;
      const positions: Candidate[] = [];
      const firingTiles = [...rangeOf(unit).tiles.values()].filter(tile => {
        if (!tile.canStop || !tile.canAct || (!same(unit, tile)
          && (!unit.canMoveAndFire(tile) || unit.getBaseMovementCosts(tile.x, tile.y) <= 0))) return false;
        const dist = distance(tile, target);
        if (dist < unit.getMinRange() || dist > unit.getMaxRange()) return false;
        return unit.isAttackable(target, true, tile);
      }).sort((a, b) => unit.getTerrainDefense(b.x, b.y) - unit.getTerrainDefense(a.x, a.y)
        || a.cost - b.cost || a.y - b.y || a.x - b.x).slice(0, 6);
      for (const tile of firingTiles) {
        if (forecasts >= MAX_FORECASTS) break;
        if (!tile.canStop || !tile.canAct || tile.cost > unit.getMovementpoints()) continue;
        const occupant = visibleUnitAt(map, player, tile.x, tile.y);
        if (occupant && occupant !== unit) continue;
        if (!same(unit, tile) && !unit.canMoveAndFire(tile)) continue;
        if (!unit.isAttackable(target, true, tile)) continue;
        // Do not move the last physical HQ blocker out of a capturer's reach.
        if (!same(unit, tile) && headquarters.some(hq => same(unit, hq.getPosition()))
          && enemies.some(enemy => enemy !== target && enemy.hasAction('ACTION_CAPTURE')
            && distance(enemy, unit) <= enemy.getMovementpoints())) continue;
        let risk = 0;
        for (const enemy of enemies) {
          if (enemy === target || !enemy.hasAction('ACTION_FIRE') || !enemy.isAttackable(unit, true)) continue;
          if (distance(enemy, tile) > enemy.getMovementpoints() + enemy.getMaxRange()) continue;
          let worst = 0;
          for (const firing of rangeOf(enemy).tiles.values()) {
            if (!firing.canAct) continue;
            const occupant = visibleUnitAt(map, player, firing.x, firing.y);
            const couldBeVacated = occupant === target || (occupant !== null && actors.includes(occupant));
            if (!firing.canStop && !couldBeVacated) continue;
            if (!same(enemy, firing) && !enemy.canMoveAndFire(firing)) continue;
            const dist = distance(firing, tile);
            if (dist < enemy.getMinRange(firing) || dist > enemy.getMaxRange(firing)) continue;
            const result = predict(enemy, firing, unit, 0, tile);
            if (!result) { worst = Infinity; break; }
            worst = Math.max(worst, Math.max(0, result.x) / (MAX_UNIT_HP * MAX_UNIT_HP) * unit.getUnitCosts());
          }
          risk += worst;
          if (risk >= unit.getCoUnitValue()) break;
        }
        for (const building of knownBuildings) risk += Math.max(0, predictor.calcBuildingDamage(player, unit, tile, building));
        if (!Number.isFinite(risk)) continue;
        positions.push({ unit, to: { x: tile.x, y: tile.y }, risk: Math.min(unit.getCoUnitValue(), risk) });
      }
      positions.sort((a, b) => a.risk - b.risk
        || unit.getTerrainDefense(b.to.x, b.to.y) - unit.getTerrainDefense(a.to.x, a.to.y)
        || distance(unit, a.to) - distance(unit, b.to) || a.to.y - b.to.y || a.to.x - b.to.x);
      candidates.push(...positions.slice(0, MAX_POSITIONS));
    }
    const targetHp = target.getHp() * MAX_UNIT_HP;
    const targetValue = target.getCoUnitValue();
    let bestSoloScore = -Infinity;
    let beam: Sequence[] = [{ choices: [], damage: 0, loss: 0, checkpoints: [] }];
    for (let depth = 1; depth <= MAX_PARTICIPANTS && forecasts < MAX_FORECASTS; depth++) {
      const next: Sequence[] = [];
      for (const sequence of beam) for (const candidate of candidates) {
        if (evaluatedSequences >= MAX_SEQUENCES || forecasts >= MAX_FORECASTS) break;
        if (sequence.choices.some(choice => choice.unit === candidate.unit || same(choice.to, candidate.to))) continue;
        const result = predict(candidate.unit, candidate.to, target, sequence.damage, target);
        if (!result || result.x <= 0) continue;
        evaluatedSequences++;
        const damage = Math.min(targetHp, sequence.damage + result.x);
        const counter = Math.max(0, result.width) / (MAX_UNIT_HP * MAX_UNIT_HP) * candidate.unit.getUnitCosts();
        const loss = sequence.loss + Math.min(candidate.unit.getCoUnitValue(), counter + candidate.risk);
        const choices = [...sequence.choices, candidate];
        if (damage >= targetHp) {
          const score = targetValue - loss;
          if (choices.length === 1) bestSoloScore = Math.max(bestSoloScore, score);
          // The wrapper re-evaluates the remaining objective after every shot.
          // Do not promise a suffix it would reject even with exact predictions.
          const continuable = sequence.checkpoints.every(checkpoint =>
            (targetHp - checkpoint.damage) / targetHp * targetValue > loss - checkpoint.loss);
          if (choices.length >= minimum && score > 0
            && continuable && (minimum === 1 || score > bestSoloScore) && (!best || score > best.score)) {
            best = {
              targetUid: target.uid, score, evaluatedSequences,
              actions: choices.map(choice => ({ kind: 'unit', uid: choice.unit.uid,
                actionId: 'ACTION_FIRE', to: choice.to, target: { x: target.x, y: target.y } })),
            };
          }
        } else if (loss < targetValue) next.push({ choices, damage, loss,
          checkpoints: [...sequence.checkpoints, { damage, loss }] });
      }
      next.sort((a, b) => (b.damage / targetHp * targetValue - b.loss)
        - (a.damage / targetHp * targetValue - a.loss));
      beam = next.slice(0, BEAM_WIDTH);
      if (!beam.length) break;
    }
  }
  if (best) best.evaluatedSequences = evaluatedSequences;
  return best;
}
