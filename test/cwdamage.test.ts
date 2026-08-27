import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { DamagePredictor, calcFundsDamage } from '../src/ai/cw/damage.ts';
import { Game } from '../src/game/game.ts';
import { GameEnums, type GameMap } from '../src/host/index.ts';

const { registry } = bootstrap();
const LAND = 'maps/2_player/60-ZWEITER KRIEG.map';
function load(): GameMap {
  return loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), LAND))), registry);
}
/** An empty tile, so added units do not stack with the map's own. */
function free(map: GameMap, from = 0): { x: number; y: number } {
  let seen = 0;
  for (let y = 0; y < map.getMapHeight(); y++) {
    for (let x = 0; x < map.getMapWidth(); x++) {
      if (map.getUnitAt(x, y)) continue;
      if (seen++ === from) return { x, y };
    }
  }
  throw new Error('no free tile');
}

describe('DamagePredictor', () => {
  it('reads weapon base damage from the weapon scripts', () => {
    const map = load();
    const predictor = new DamagePredictor(map);
    const os = map.getPlayer(0)!;
    const a = free(map, 0), b = free(map, 1);
    const tank = map.addUnit('LIGHT_TANK', os, a.x, a.y);
    const infantry = map.addUnit('INFANTRY', os, b.x, b.y);

    // A tank hurts infantry more than infantry hurts a tank; that ordering is
    // the whole basis of the AI's matchup reasoning.
    expect(predictor.getBaseDamage(tank, infantry))
      .toBeGreaterThan(predictor.getBaseDamage(infantry, tank));
  });

  it('reports -1 when a weapon cannot hurt a target at all', () => {
    const map = load();
    const predictor = new DamagePredictor(map);
    const os = map.getPlayer(0)!;
    const a = free(map, 0), b = free(map, 1);
    const infantry = map.addUnit('INFANTRY', os, a.x, a.y);
    const fighter = map.addUnit('FIGHTER', os, b.x, b.y);
    // Rifles do not reach a fighter. -1, not 0, is what marks "no answer to
    // this unit" and drives the AI to build a counter.
    expect(predictor.getBaseDamage(infantry, fighter)).toBeLessThan(0);
  });

  it('caches base damage per weapon and defender type', () => {
    const map = load();
    const predictor = new DamagePredictor(map);
    const os = map.getPlayer(0)!;
    const a = free(map, 0), b = free(map, 1);
    const tank = map.addUnit('LIGHT_TANK', os, a.x, a.y);
    const infantry = map.addUnit('INFANTRY', os, b.x, b.y);
    const first = predictor.getBaseDamage(tank, infantry);
    expect(predictor.getBaseDamage(tank, infantry)).toBe(first);
  });

  it('agrees with the engine on a real attack preview', () => {
    const map = load();
    const game = new Game(map, registry);
    const predictor = new DamagePredictor(map);
    const os = map.getPlayer(0)!, bm = map.getPlayer(1)!;
    const a = free(map, 0);
    const tank = map.addUnit('LIGHT_TANK', os, a.x, a.y);
    // Put a victim right next to it so a plain adjacent attack is legal.
    const b = { x: a.x + 1, y: a.y };
    const victim = map.addUnit('INFANTRY', bm, b.x, b.y);
    expect(map.getUnitAt(b.x, b.y)).toBe(victim);

    const preview = game.previewBattle(tank, a, b);
    const virtual = predictor.calcVirtualUnitDamage(
      tank, 0, a, victim, 0, b,
      GameEnums.LuckDamageMode_Average, GameEnums.LuckDamageMode_Average);
    expect(preview).not.toBeNull();
    // Same script, same inputs: the prediction the AI scores on must be the
    // one the engine will actually resolve.
    expect(virtual.x).toBeCloseTo(preview!.attacker, 5);
  });

  it('values a kill above a trade in funds', () => {
    const map = load();
    const os = map.getPlayer(0)!, bm = map.getPlayer(1)!;
    const a = free(map, 0), b = free(map, 1);
    const tank = map.addUnit('LIGHT_TANK', os, a.x, a.y);
    const victim = map.addUnit('INFANTRY', bm, b.x, b.y);

    const clean = calcFundsDamage({ x: 100, y: 0, width: -1, height: 0 }, tank, victim, 1);
    const traded = calcFundsDamage({ x: 100, y: 0, width: 40, height: 0 }, tank, victim, 1);
    expect(clean.fundsDamage).toBeGreaterThan(traded.fundsDamage);
    // A counter-attack costs hp on our side of the ledger too.
    expect(traded.hpDamage).toBeLessThan(clean.hpDamage);
  });

  it('caps damage at the defender"s remaining hp', () => {
    const map = load();
    const os = map.getPlayer(0)!, bm = map.getPlayer(1)!;
    const a = free(map, 0), b = free(map, 1);
    const tank = map.addUnit('LIGHT_TANK', os, a.x, a.y);
    const victim = map.addUnit('INFANTRY', bm, b.x, b.y);
    victim.hp = 3;

    // Overkill is not worth extra funds: 100% damage onto a 3hp unit destroys
    // 3hp of value, not 10.
    const result = calcFundsDamage({ x: 100, y: 0, width: -1, height: 0 }, tank, victim, 1);
    expect(result.atkHpDamage).toBe(3);
    expect(result.fundsDamage).toBeCloseTo(victim.getUnitCosts() * 3 / 10, 5);
  });

  it('weights own losses by OwnUnitValue', () => {
    const map = load();
    const os = map.getPlayer(0)!, bm = map.getPlayer(1)!;
    const a = free(map, 0), b = free(map, 1);
    const tank = map.addUnit('LIGHT_TANK', os, a.x, a.y);
    const victim = map.addUnit('INFANTRY', bm, b.x, b.y);
    const battle = { x: 60, y: 0, width: 40, height: 0 };

    const cheap = calcFundsDamage(battle, tank, victim, 1);
    const precious = calcFundsDamage(battle, tank, victim, 3);
    // Valuing your own units more makes the same trade look worse.
    expect(precious.fundsDamage).toBeLessThan(cheap.fundsDamage);
  });
});
