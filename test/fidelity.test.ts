import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import { computeMovementRange } from '../src/game/pathfinding.ts';
import { GameEnums, type GameMap } from '../src/host/index.ts';

const { registry, animations } = bootstrap();
const source = readMap(fs.readFileSync(path.join(cwRoot(), 'maps/2_player/60-ZWEITER KRIEG.map')));

let map: GameMap;
let game: Game;
beforeEach(() => {
  map = loadIntoGameMap(source, registry);
  game = new Game(map, registry, animations);
});

function findTerrain(id: string): { x: number; y: number } {
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (map.getTerrain(x, y).getTerrainID() === id) return { x, y };
    }
  }
  throw new Error(`no ${id} on this map`);
}

function findBuilding(id: string): { x: number; y: number } {
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (map.getTerrain(x, y).getBuilding()?.getBuildingID() === id) return { x, y };
    }
  }
  throw new Error(`no ${id} on this map`);
}

describe('a tile answers with its building', () => {
  it('reports the building id, not the terrain underneath', () => {
    const hq = findBuilding('HQ');
    // Terrain::getID returns the building id; movement tables and defence key
    // on it, so returning PLAINS made harbours impassable and cities defenceless.
    expect(map.getTerrain(hq.x, hq.y).getTerrainID()).toBe('PLAINS');
    expect(map.getTerrain(hq.x, hq.y).getID()).toBe('HQ');
  });

  it('gives buildings their own defence rating', () => {
    const infantry = map.addUnit('INFANTRY', map.getPlayer(0)!, 0, 0);
    expect(map.getTerrain(findBuilding('HQ').x, findBuilding('HQ').y).getDefense(infantry)).toBe(4);
    expect(map.getTerrain(findBuilding('TOWN').x, findBuilding('TOWN').y).getDefense(infantry)).toBe(3);
    const plains = findTerrain('PLAINS');
    expect(map.getTerrain(plains.x, plains.y).getDefense(infantry)).toBe(1);
  });
});

describe('capture progress', () => {
  it('is lost when the unit moves', () => {
    const unit = map.addUnit('INFANTRY', map.getPlayer(0)!, 3, 8);
    unit.setCapturePoints(15);
    unit.moveUnitToField(4, 8);
    expect(unit.getCapturePoints()).toBe(0);
  });

  it('still accumulates when capturing in place across turns', () => {
    const town = findBuilding('TOWN');
    const building = map.getTerrain(town.x, town.y).getBuilding()!;
    building.setOwner(null);
    const unit = map.addUnit('INFANTRY', map.getPlayer(0)!, town.x, town.y);
    unit.hasMoved = false;

    game.select(town.x, town.y);
    game.performAction('ACTION_CAPTURE', unit, town);
    expect(unit.getCapturePoints()).toBe(10);

    unit.hasMoved = false;
    game.select(town.x, town.y);
    game.performAction('ACTION_CAPTURE', unit, town);
    expect(building.getOwner()).toBe(map.getPlayer(0));
  });
});

describe('fuel', () => {
  it('lets upkeep drive fuel negative and destroys the unit', () => {
    const player = map.getPlayer(0)!;
    const fighter = map.addUnit('FIGHTER', player, 6, 3);
    fighter.setFuel(2);          // upkeep is 5 per turn
    game.endTurn();
    game.endTurn();
    expect(map.units).not.toContain(fighter);
  });

  it('refuels an aircraft on an airport but not on a factory', () => {
    const player = map.getPlayer(0)!;

    // BUILDING.getRepairTypes matches on unit type: a factory serves ground and
    // infantry, so it will not save a fighter.
    const factory = findBuilding('FACTORY');
    const grounded = map.addUnit('FIGHTER', player, factory.x, factory.y);
    grounded.setFuel(2);

    const airport = findBuilding('AIRPORT');
    map.getTerrain(airport.x, airport.y).getBuilding()!.setOwner(player);
    const serviced = map.addUnit('FIGHTER', player, airport.x, airport.y);
    serviced.setFuel(2);

    game.endTurn();
    game.endTurn();

    expect(map.units).not.toContain(grounded);
    expect(map.units).toContain(serviced);
    expect(serviced.fuel).toBeGreaterThan(0);
  });
});

describe('naval indirects', () => {
  it('may move and fire, per their own scripts', () => {
    const player = map.getPlayer(0)!;
    expect(map.addUnit('BATTLESHIP', player, 0, 0).canMoveAndFire()).toBe(true);
    expect(map.addUnit('AIRCRAFTCARRIER', player, 0, 1).canMoveAndFire()).toBe(true);
    // A land artillery piece still cannot.
    expect(map.addUnit('ARTILLERY', player, 3, 8).canMoveAndFire()).toBe(false);
  });
});

describe('vision', () => {
  beforeEach(() => {
    map.getGameRules().setFogMode(GameEnums.Fog_OfWar);
  });

  it('adds terrain vision bonuses', () => {
    const mountain = findTerrain('MOUNTAIN');
    const scout = map.addUnit('INFANTRY', map.getPlayer(0)!, mountain.x, mountain.y);
    // Infantry see 2 normally, 5 from a mountain — the classic scouting play.
    expect(scout.vision).toBe(2);
    expect(scout.getVision()).toBe(5);
  });

  it('lights only its own tile from a building by default', () => {
    expect(map.getGameRules().getBuildingVision()).toBe(0);
  });

  it('conceals units in forest until a viewer is adjacent', () => {
    const forest = findTerrain('FOREST');
    const viewer = map.getPlayer(0)!;
    const scout = map.addUnit('INFANTRY', viewer, forest.x + 2, forest.y);
    const hider = map.addUnit('INFANTRY', map.getPlayer(1)!, forest.x, forest.y);
    map.vision.update();

    expect(viewer.getFieldVisible(forest.x, forest.y)).toBe(false);
    expect(hider.isStealthed(viewer)).toBe(true);
    expect(scout.isAttackable(hider)).toBe(false);

    scout.moveUnitToField(forest.x + 1, forest.y);
    map.vision.update();
    expect(viewer.getFieldVisible(forest.x, forest.y)).toBe(true);
    expect(scout.isAttackable(hider)).toBe(true);
  });

  it('does not let an unseen enemy block movement', () => {
    const viewer = map.getPlayer(0)!;
    // Infantry move 3 but see 2, so a unit 3 away is reachable yet unseen.
    const runner = map.addUnit('INFANTRY', viewer, 3, 8);
    const open = computeMovementRange(map, runner).tiles.size;

    const ghost = map.addUnit('INFANTRY', map.getPlayer(1)!, 3, 11);
    map.vision.update();
    expect(viewer.getFieldVisible(ghost.x, ghost.y)).toBe(false);
    // Blocking here would silently reveal exactly where the enemy stands.
    expect(computeMovementRange(map, runner).tiles.size).toBe(open);
  });

  it('protects a dived submarine from units that cannot see it', () => {
    const sub = map.addUnit('SUBMARINE', map.getPlayer(1)!, 0, 0);
    const bomber = map.addUnit('BOMBER', map.getPlayer(0)!, 1, 0);
    map.vision.update();
    expect(bomber.isAttackable(sub, true)).toBe(true);
    sub.setHidden(true);
    expect(bomber.isAttackable(sub, true)).toBe(false);
  });

  it('reveals a dived submarine to an adjacent unit', () => {
    // game/unit.cpp:3599 — the adjacency escape applies to status stealth too,
    // so the sub is revealed and scripts/general/unit.js canAttackStealthedUnit
    // lets a naval direct attacker depth-charge it. Without this, a dived sub
    // parked next to a cruiser is permanently invulnerable.
    const sub = map.addUnit('SUBMARINE', map.getPlayer(1)!, 0, 0);
    const cruiser = map.addUnit('CRUISER', map.getPlayer(0)!, 1, 0);
    sub.setHidden(true);
    map.vision.update();
    expect(sub.isStealthed(map.getPlayer(0)!)).toBe(false);
    expect(cruiser.isAttackable(sub)).toBe(true);

    // A bomber next to the sub also reveals it, but is still refused by
    // canAttackStealthedUnit — air cannot hit a dived naval unit.
    const bomber = map.addUnit('BOMBER', map.getPlayer(0)!, 0, 1);
    map.vision.update();
    expect(bomber.isAttackable(sub)).toBe(false);
  });
});

describe('unit type vocabulary', () => {
  it('uses the bitmask values the scripts compare against', () => {
    // game/GameEnums.h:178 — a bitmask, not an ordinal sequence.
    expect(GameEnums.UnitType_Ground).toBe(1);
    expect(GameEnums.UnitType_Hovercraft).toBe(2);
    expect(GameEnums.UnitType_Infantry).toBe(4);
    expect(GameEnums.UnitType_Air).toBe(8);
    expect(GameEnums.UnitType_Naval).toBe(16);
    expect(GameEnums.AiTypes_Human).toBe(0);
  });

  it('makes repair-type matching work', () => {
    const factory = findBuilding('FACTORY');
    const building = map.getTerrain(factory.x, factory.y).getBuilding()!;
    expect(building.getRepairTypes()).toEqual([1, 4]);
    const infantry = map.addUnit('INFANTRY', map.getPlayer(0)!, factory.x, factory.y);
    expect(infantry.getUnitType()).toBe(GameEnums.UnitType_Infantry);
  });
});

describe('unit limit', () => {
  it('blocks production once the cap is reached', () => {
    const factory = findBuilding('FACTORY');
    const player = map.getTerrain(factory.x, factory.y).getBuilding()!.getOwner()!;
    player.funds = 50_000;
    map.getGameRules().unitLimit = 1;
    expect(game.canProduceAt(factory.x, factory.y)).toBe(true);

    map.addUnit('INFANTRY', player, 5, 5);
    expect(game.canProduceAt(factory.x, factory.y)).toBe(false);
    expect(game.buildUnit(factory.x, factory.y, 'INFANTRY')).toBe(false);
  });
});

describe('multi-step actions', () => {
  it('drives ACTION_MISSILE through its field step', () => {
    const player = map.getPlayer(0)!;
    let silo: { x: number; y: number } | null = null;
    for (let y = 0; y < map.height && !silo; y++) {
      for (let x = 0; x < map.width; x++) {
        if (map.getTerrain(x, y).getBuilding()?.getBuildingID() === 'SILO_ROCKET') { silo = { x, y }; break; }
      }
    }
    expect(silo).not.toBeNull();

    const unit = map.addUnit('INFANTRY', player, silo!.x, silo!.y);
    unit.hasMoved = false;
    const victims = [[10, 7], [11, 7], [10, 8]]
      .map(([x, y]) => map.addUnit('INFANTRY', map.getPlayer(1)!, x, y));
    map.vision.update();
    game.select(silo!.x, silo!.y);

    expect(game.availableActions(unit, silo!).map(a => a.id)).toContain('ACTION_MISSILE');

    const step = game.beginAction('ACTION_MISSILE', unit, silo!);
    expect(step.kind).toBe('field');
    // ACTION_MISSILE calls setAllFields(true) and adds no points, which means
    // every on-map tile is selectable rather than none.
    if (step.kind === 'field') expect(step.fields.length).toBe(map.width * map.height);

    expect(game.provideField(10, 7).kind).toBe('done');
    for (const victim of victims) expect(victim.getHp()).toBeLessThan(10);
    expect(unit.hasMoved).toBe(true);
  });

  it('can be cancelled mid-way', () => {
    const player = map.getPlayer(0)!;
    let silo: { x: number; y: number } | null = null;
    for (let y = 0; y < map.height && !silo; y++) {
      for (let x = 0; x < map.width; x++) {
        if (map.getTerrain(x, y).getBuilding()?.getBuildingID() === 'SILO_ROCKET') { silo = { x, y }; break; }
      }
    }
    const unit = map.addUnit('INFANTRY', player, silo!.x, silo!.y);
    unit.hasMoved = false;
    game.select(silo!.x, silo!.y);

    expect(game.beginAction('ACTION_MISSILE', unit, silo!).kind).toBe('field');
    game.cancelAction();
    expect(game.pending).toBeNull();
    expect(unit.hasMoved).toBe(false);
  });
});

describe('timed bonuses', () => {
  it('apply to combat and expire on schedule', () => {
    const unit = map.addUnit('INFANTRY', map.getPlayer(0)!, 3, 8);
    const position = { x: 3, y: 8 };
    const before = unit.getBonusOffensive(null, position, null, position, false, 0);

    unit.addOffensiveBonus(50, 2);
    expect(unit.getBonusOffensive(null, position, null, position, false, 0)).toBe(before + 50);

    // Durations tick at the owner's turn start.
    game.endTurn(); game.endTurn();
    expect(unit.getBonusOffensive(null, position, null, position, false, 0)).toBe(before + 50);
    game.endTurn(); game.endTurn();
    expect(unit.getBonusOffensive(null, position, null, position, false, 0)).toBe(before);
  });
});

describe('terrain field bonuses', () => {
  it('applies the desert offence penalty', () => {
    const desertMap = loadIntoGameMap(source, registry);
    const unit = desertMap.addUnit('INFANTRY', desertMap.getPlayer(0)!, 0, 0);
    const terrain = desertMap.getTerrain(0, 0);
    // DESERT.getOffensiveFieldBonus returns -20; a hardcoded 0 silently removed
    // the main positioning consideration on desert maps.
    const desertScript = registry.DESERT;
    expect(typeof desertScript?.getOffensiveFieldBonus).toBe('function');
    const value = desertScript.getOffensiveFieldBonus(
      terrain, unit, 0, 0, null, 0, 0, false, null, 0, desertMap);
    expect(value).toBe(-20);
  });
});

describe('destructible structures', () => {
  it('can be targeted and damaged', () => {
    // Terrain with HP (meteors, pipes, walls) is a legal attack target even
    // though no unit stands on it.
    const plains = findTerrain('PLAINS');
    const terrain = map.getTerrain(plains.x, plains.y);
    terrain.setHp(50);

    const tank = map.addUnit('HEAVY_TANK', map.getPlayer(0)!, plains.x + 1, plains.y);
    tank.hasMoved = false;
    map.vision.update();

    const targets = game.attackTargets(tank, { x: tank.x, y: tank.y });
    const structure = targets.find(t => t.x === plains.x && t.y === plains.y);
    expect(structure).toBeDefined();
    expect(structure!.kind).toBe('terrain');
    expect(structure!.unit).toBeNull();
  });
});
