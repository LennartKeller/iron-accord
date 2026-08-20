import { describe, it, expect } from 'vitest';
import { bootstrap, unitIds } from '../src/game/bootstrap.node.ts';
import { GameEnums, Qt, Unit } from '../src/host/index.ts';

const { registry, createMap } = bootstrap();

function freshMap() {
  const map = createMap(3, 3, 'PLAINS');
  map.addPlayer('OS');
  map.addPlayer('BM');
  return map;
}

/** Runs Commander Wars' own ACTION_FIRE.calcDamage against the host shim. */
function calcDamage(
  map: ReturnType<typeof freshMap>,
  attacker: Unit, weaponID: string, defender: Unit,
  attackerHp = 10,
): number {
  return registry.ACTION_FIRE.calcDamage(
    null,
    attacker, weaponID, Qt.point(attacker.x, attacker.y), attackerHp,
    defender, Qt.point(defender.x, defender.y),
    false,
    GameEnums.LuckDamageMode_Off,
  );
}

describe('ACTION_FIRE damage pipeline', () => {
  it('reproduces every weapon/defender pairing from the scripts themselves', () => {
    const map = freshMap();
    map.getGameRules().setTerrainDefense(0); // isolate base damage
    const os = map.getPlayer(0)!;
    const bm = map.getPlayer(1)!;
    const ids = unitIds(registry);

    let verified = 0;
    const mismatches: string[] = [];

    for (const attackerId of ids) {
      const attacker = new Unit(map, attackerId, os, 0, 0);
      for (const weaponID of [attacker.getWeapon1ID(), attacker.getWeapon2ID()]) {
        if (!weaponID || !registry[weaponID]?.damageTable) continue;
        for (const defenderId of ids) {
          const defender = new Unit(map, defenderId, bm, 1, 1);
          // Oracle is the weapon script's own getBaseDamage — NOT a lookup in its
          // damageTable. WEAPON_TANKHUNTER_GUN delegates to WEAPON_HEAVY_TANK_GUN
          // and leaves its own table as dead data.
          const expected = registry[weaponID].getBaseDamage(defender);
          if (!(expected > 0)) continue;

          const actual = calcDamage(map, attacker, weaponID, defender);
          if (Math.abs(actual - expected) > 1e-6) {
            mismatches.push(`${attackerId}/${weaponID} -> ${defenderId}: ${actual} != ${expected}`);
          } else {
            verified++;
          }
        }
      }
    }

    expect(mismatches).toEqual([]);
    expect(verified).toBeGreaterThan(2500);
  });

  it('applies terrain defense with the HP-reduction malus', () => {
    const map = freshMap();
    const os = map.getPlayer(0)!;
    const bm = map.getPlayer(1)!;
    const attacker = new Unit(map, 'INFANTRY', os, 0, 0);

    // game/unit.cpp: bonus += terrainDefense * rules.terrainDefense * (hpRounded / 10)
    // general/weapon.js: damage = hp/10 * (base * off)/100 * ((200 - def)/100)
    for (const [terrain, hp, expected] of [
      ['PLAINS', 10, 49.5],
      ['PLAINS', 5, 52.25],
      ['FOREST', 10, 38.5],
      ['FOREST', 5, 46.75],
      ['MOUNTAIN', 10, 33.0],
      ['MOUNTAIN', 5, 44.0],
    ] as Array<[string, number, number]>) {
      map.setTerrainID(1, 1, terrain);
      const defender = new Unit(map, 'INFANTRY', bm, 1, 1);
      defender.setHp(hp);
      expect(calcDamage(map, attacker, 'WEAPON_INFANTRY_MG', defender)).toBeCloseTo(expected, 6);
    }
  });

  it('reads terrain defense stars from the terrain scripts', () => {
    const map = freshMap();
    for (const [terrain, stars] of [['PLAINS', 1], ['FOREST', 3], ['MOUNTAIN', 4]] as Array<[string, number]>) {
      map.setTerrainID(1, 1, terrain);
      expect(map.getTerrain(1, 1).getBaseDefense()).toBe(stars);
    }
  });

  it('scales damage with attacker HP', () => {
    const map = freshMap();
    const os = map.getPlayer(0)!;
    const bm = map.getPlayer(1)!;
    const attacker = new Unit(map, 'INFANTRY', os, 0, 0);
    const defender = new Unit(map, 'INFANTRY', bm, 1, 1);

    const full = calcDamage(map, attacker, 'WEAPON_INFANTRY_MG', defender, 10);
    const half = calcDamage(map, attacker, 'WEAPON_INFANTRY_MG', defender, 5);
    expect(half).toBeCloseTo(full / 2, 6);
  });
});

describe('movement tables', () => {
  it('reads movement costs from the scripts', () => {
    const cost = (terrainId: string) =>
      registry.MOVEMENTTABLE.getMovementpointsFromTable(
        { getID: () => terrainId }, registry.MOVE_FEET.movementpointsTable);
    expect(cost('PLAINS')).toBe(1);
    expect(cost('FOREST')).toBe(1);
    expect(cost('MOUNTAIN')).toBe(2);
  });
});
