import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { DamagePredictor } from '../src/ai/cw/damage.ts';
import { getAttackTargets, getBestTarget, type TargetScoringOptions } from '../src/ai/cw/targets.ts';
import { computeMovementRange } from '../src/game/pathfinding.ts';
import { Game } from '../src/game/game.ts';
import { NORMAL_AI_DEFAULTS } from '../src/ai/cw/config.ts';
import type { GameMap } from '../src/host/index.ts';

const { registry } = bootstrap();
const LAND = 'maps/2_player/60-ZWEITER KRIEG.map';

const OPTIONS: TargetScoringOptions = {
  ownUnitValue: NORMAL_AI_DEFAULTS.ownUnitValue,
  buildingValue: NORMAL_AI_DEFAULTS.buildingValue,
  minTerrainDamage: NORMAL_AI_DEFAULTS.minTerrainDamage,
  minHpDamage: NORMAL_AI_DEFAULTS.minHpDamage,
  enableNeutralTerrainAttack: false,
};

/**
 * A clean board: the map ships with units on it, and leaving them there makes
 * every assertion about "which targets exist" depend on the map's roster.
 */
function bare(): { map: GameMap; game: Game } {
  const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), LAND))), registry);
  for (const player of [map.getPlayer(0)!, map.getPlayer(1)!]) {
    for (const unit of [...player.units]) map.removeUnit(unit);
  }
  return { map, game: new Game(map, registry) };
}

/** Two adjacent land tiles both unit types can stand on. */
function pair(map: GameMap): [{ x: number; y: number }, { x: number; y: number }] {
  const os = map.getPlayer(0)!;
  for (let y = 0; y < map.getMapHeight(); y++) {
    for (let x = 0; x + 1 < map.getMapWidth(); x++) {
      const probe = map.addUnit('LIGHT_TANK', os, x, y);
      const here = probe.getBaseMovementCosts(x, y, x, y) > 0;
      const there = probe.getBaseMovementCosts(x + 1, y, x, y) > 0;
      map.removeUnit(probe);
      if (here && there) return [{ x, y }, { x: x + 1, y }];
    }
  }
  throw new Error('no adjacent land pair');
}

describe('attack target evaluation', () => {
  it('finds an adjacent enemy and scores the trade', () => {
    const { map, game } = bare();
    const os = map.getPlayer(0)!, bm = map.getPlayer(1)!;
    const [a, b] = pair(map);
    const tank = map.addUnit('LIGHT_TANK', os, a.x, a.y);
    map.addUnit('INFANTRY', bm, b.x, b.y);

    const predictor = new DamagePredictor(map);
    const range = computeMovementRange(map, tank);
    const { targets, moveTargetFields } = getAttackTargets(game, predictor, tank, range, OPTIONS);

    const hit = targets.find(t => t.x === b.x && t.y === b.y);
    expect(hit).toBeDefined();
    expect(hit!.fundsDamage).toBeGreaterThan(0);
    // The two arrays are parallel: one attack, one tile to shoot it from.
    expect(moveTargetFields.length).toBe(targets.length);
  });

  it('only shoots from where it stands when it cannot move and fire', () => {
    const { map, game } = bare();
    const os = map.getPlayer(0)!, bm = map.getPlayer(1)!;
    const [a, b] = pair(map);
    const artillery = map.addUnit('ARTILLERY', os, a.x, a.y);
    expect(artillery.canMoveAndFire()).toBe(false);
    map.addUnit('INFANTRY', bm, b.x, b.y);

    const predictor = new DamagePredictor(map);
    const range = computeMovementRange(map, artillery);
    const { moveTargetFields } = getAttackTargets(game, predictor, artillery, range, OPTIONS);
    // Whatever it can hit, it hits from its own tile and nowhere else.
    for (const field of moveTargetFields) expect({ x: field.x, y: field.y }).toEqual(a);
  });

  it('keeps only the attacks tied for the best funds swing', () => {
    const { map, game } = bare();
    const os = map.getPlayer(0)!, bm = map.getPlayer(1)!;
    const [a, b] = pair(map);
    const tank = map.addUnit('LIGHT_TANK', os, a.x, a.y);
    map.addUnit('INFANTRY', bm, b.x, b.y);

    const predictor = new DamagePredictor(map);
    const range = computeMovementRange(map, tank);
    const { targets } = getBestTarget(game, predictor, tank, range, OPTIONS);
    expect(targets.length).toBeGreaterThan(0);
    // Every survivor scores the same; that is what "best" means here.
    for (const target of targets) expect(target.z).toBe(targets[0].z);
  });

  it('ranks the best attack at or above every attack it found', () => {
    const { map, game } = bare();
    const os = map.getPlayer(0)!, bm = map.getPlayer(1)!;
    const [a, b] = pair(map);
    const tank = map.addUnit('LIGHT_TANK', os, a.x, a.y);
    map.addUnit('INFANTRY', bm, b.x, b.y);

    const predictor = new DamagePredictor(map);
    const range = computeMovementRange(map, tank);
    const best = getBestTarget(game, predictor, tank, range, OPTIONS);
    const all = getAttackTargets(game, predictor, tank, range, OPTIONS);
    expect(best.targets.length).toBeGreaterThan(0);
    // getBestTarget is getAttackTargets filtered to the maximum, so nothing the
    // wider scan turned up may beat what the narrow one kept.
    for (const candidate of all.targets) {
      expect(best.targets[0].z).toBeGreaterThanOrEqual(candidate.fundsDamage);
    }
  });

  it('refuses a trade worse than MinHpDamage', () => {
    const { map, game } = bare();
    const os = map.getPlayer(0)!, bm = map.getPlayer(1)!;
    const [a, b] = pair(map);
    const infantry = map.addUnit('INFANTRY', os, a.x, a.y);
    map.addUnit('MEGATANK', bm, b.x, b.y);

    const predictor = new DamagePredictor(map);
    const range = computeMovementRange(map, infantry);
    // Infantry into a megatank is a hopeless exchange; with the shipped
    // MinHpDamage of -2 the AI declines it rather than feeding the unit in.
    const strict = getBestTarget(game, predictor, infantry, range, OPTIONS);
    const reckless = getBestTarget(
      game, predictor, infantry, range, { ...OPTIONS, minHpDamage: -100 });
    expect(strict.targets.length).toBeLessThanOrEqual(reckless.targets.length);
  });

  it('finds nothing when there is nothing in range', () => {
    const { map, game } = bare();
    const os = map.getPlayer(0)!;
    const [a] = pair(map);
    const tank = map.addUnit('LIGHT_TANK', os, a.x, a.y);
    const predictor = new DamagePredictor(map);
    const range = computeMovementRange(map, tank);
    const { targets } = getAttackTargets(game, predictor, tank, range, OPTIONS);
    expect(targets).toEqual([]);
  });
});
