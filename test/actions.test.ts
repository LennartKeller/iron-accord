import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap, resolveBuildingSprites } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import { GameEnums, type GameMap, type Building } from '../src/host/index.ts';

const { registry, animations } = bootstrap();
const source = readMap(fs.readFileSync(path.join(cwRoot(), 'maps/2_player/60-ZWEITER KRIEG.map')));

function newGame(): { map: GameMap; game: Game } {
  const map = loadIntoGameMap(source, registry);
  return { map, game: new Game(map, registry, animations) };
}

function findBuilding(map: GameMap, id: string, owner: 'neutral' | number): { x: number; y: number } | null {
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const building = map.getTerrain(x, y).getBuilding();
      if (!building || building.getBuildingID() !== id) continue;
      const buildingOwner = building.getOwner();
      const matches = owner === 'neutral'
        ? buildingOwner === null
        : buildingOwner?.getPlayerID() === owner;
      if (matches) return { x, y };
    }
  }
  return null;
}

describe('action menu', () => {
  it('offers only what the Commander Wars scripts allow', () => {
    const { map, game } = newGame();
    const infantry = map.addUnit('INFANTRY', map.getPlayer(0)!, 3, 8);
    infantry.hasMoved = false;
    game.select(3, 8);

    const onOpenGround = game.availableActions(infantry, { x: 3, y: 8 }).map(a => a.id);
    expect(onOpenGround).toContain('ACTION_WAIT');
    expect(onOpenGround).not.toContain('ACTION_CAPTURE');

    const town = findBuilding(map, 'TOWN', 'neutral')!;
    expect(town).not.toBeNull();
    const onTown = game.availableActions(infantry, town).map(a => a.id);
    expect(onTown).toContain('ACTION_CAPTURE');
  });

  it('labels actions from the scripts', () => {
    const { map, game } = newGame();
    const infantry = map.addUnit('INFANTRY', map.getPlayer(0)!, 3, 8);
    infantry.hasMoved = false;
    game.select(3, 8);
    const wait = game.availableActions(infantry, { x: 3, y: 8 }).find(a => a.id === 'ACTION_WAIT');
    expect(wait?.label).toBe('Wait');
  });
});

describe('capture', () => {
  it('takes two turns at full HP and transfers the building', () => {
    const { map, game } = newGame();
    const town = findBuilding(map, 'TOWN', 'neutral')!;
    const infantry = map.addUnit('INFANTRY', map.getPlayer(0)!, town.x, town.y - 1);
    infantry.hasMoved = false;
    const building = map.getTerrain(town.x, town.y).getBuilding()!;
    expect(building.getOwner()).toBeNull();

    game.select(infantry.x, infantry.y);
    game.performAction('ACTION_CAPTURE', infantry, town);
    // Capture rate is the unit's rounded HP, so a full-health infantry needs two.
    expect(infantry.getCapturePoints()).toBe(10);
    expect(building.getOwner()).toBeNull();
    expect(infantry.hasMoved).toBe(true);

    infantry.hasMoved = false;
    game.select(infantry.x, infantry.y);
    game.performAction('ACTION_CAPTURE', infantry, town);
    expect(building.getOwner()).toBe(map.getPlayer(0));
    expect(infantry.getCapturePoints()).toBe(0);
  });

  it('captures more slowly when damaged', () => {
    const { map, game } = newGame();
    const town = findBuilding(map, 'TOWN', 'neutral')!;
    const infantry = map.addUnit('INFANTRY', map.getPlayer(0)!, town.x, town.y - 1);
    infantry.setHp(5);
    infantry.hasMoved = false;
    game.select(infantry.x, infantry.y);
    game.performAction('ACTION_CAPTURE', infantry, town);
    expect(infantry.getCapturePoints()).toBe(5);
  });
});

describe('combat', () => {
  let map: GameMap;
  let game: Game;
  beforeEach(() => { ({ map, game } = newGame()); });

  it('lists attackable enemies and previews the exchange', () => {
    const attacker = map.addUnit('INFANTRY', map.getPlayer(0)!, 5, 8);
    map.addUnit('INFANTRY', map.getPlayer(1)!, 6, 8);
    attacker.hasMoved = false;
    map.vision.update();

    expect(game.attackTargets(attacker, { x: 5, y: 8 })).toHaveLength(1);
    const preview = game.previewBattle(attacker, { x: 5, y: 8 }, { x: 6, y: 8 })!;
    expect(preview.attacker).toBeGreaterThan(0);
    expect(preview.defender).toBeGreaterThan(0);   // adjacent infantry counters
  });

  it('applies damage, spends ammo and lets the defender counter', () => {
    const attacker = map.addUnit('INFANTRY', map.getPlayer(0)!, 5, 8);
    const defender = map.addUnit('INFANTRY', map.getPlayer(1)!, 6, 8);
    attacker.hasMoved = false;
    map.vision.update();

    const ammoBefore = attacker.getAmmo1();
    game.select(5, 8);
    expect(game.attack(attacker, { x: 5, y: 8 }, { x: 6, y: 8 })).toBe(true);

    expect(defender.getHp()).toBeLessThan(10);
    expect(attacker.getHp()).toBeLessThan(10);     // counter-attack landed
    expect(attacker.getAmmo1()).toBe(ammoBefore - 1);
    expect(attacker.hasMoved).toBe(true);
  });

  it('removes a unit destroyed outright, with no counter', () => {
    const tank = map.addUnit('HEAVY_TANK', map.getPlayer(0)!, 5, 6);
    const victim = map.addUnit('INFANTRY', map.getPlayer(1)!, 6, 6);
    tank.hasMoved = false;
    map.vision.update();

    game.select(5, 6);
    game.attack(tank, { x: 5, y: 6 }, { x: 6, y: 6 });
    expect(victim.getHp()).toBeLessThanOrEqual(0);
    expect(map.units).not.toContain(victim);
    expect(tank.getHp()).toBe(10);
  });

  it('will not target allies', () => {
    const attacker = map.addUnit('INFANTRY', map.getPlayer(0)!, 5, 8);
    map.addUnit('INFANTRY', map.getPlayer(0)!, 6, 8);
    attacker.hasMoved = false;
    map.vision.update();
    expect(game.attackTargets(attacker, { x: 5, y: 8 })).toHaveLength(0);
  });
});

describe('production', () => {
  it('prices from the unit scripts and marks what is affordable', () => {
    const { map, game } = newGame();
    const factory = findBuilding(map, 'FACTORY', 0)!;
    const building = map.getTerrain(factory.x, factory.y).getBuilding() as Building;
    const options = game.buildOptions(building);

    expect(options.length).toBeGreaterThan(10);
    const infantry = options.find(o => o.id === 'INFANTRY')!;
    expect(infantry.cost).toBe(1000);
    expect(infantry.affordable).toBe(true);
    expect(options.find(o => o.id === 'MEGATANK')!.affordable).toBe(false);
  });

  it('spawns a spent unit and charges the player', () => {
    const { map, game } = newGame();
    const factory = findBuilding(map, 'FACTORY', 0)!;
    const player = map.getPlayer(0)!;
    const fundsBefore = player.funds;

    expect(game.canProduceAt(factory.x, factory.y)).toBe(true);
    expect(game.buildUnit(factory.x, factory.y, 'INFANTRY')).toBe(true);

    const built = map.getUnitAt(factory.x, factory.y)!;
    expect(built.getUnitID()).toBe('INFANTRY');
    expect(built.getOwner()).toBe(player);
    expect(built.hasMoved).toBe(true);            // cannot act the turn it is built
    expect(player.funds).toBe(fundsBefore - 1000);
    expect(game.canProduceAt(factory.x, factory.y)).toBe(false);  // tile now occupied
  });

  it('refuses what the player cannot afford', () => {
    const { map, game } = newGame();
    const factory = findBuilding(map, 'FACTORY', 0)!;
    expect(game.buildUnit(factory.x, factory.y, 'MEGATANK')).toBe(false);
    expect(map.getUnitAt(factory.x, factory.y)).toBeNull();
  });
});

describe('production gating', () => {
  it('lets only buildings whose actionList says so produce units', () => {
    const { map } = newGame();
    const seen = new Map<string, boolean>();
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const building = map.getTerrain(x, y).getBuilding();
        if (building) seen.set(building.getBuildingID(), building.canBuildUnits());
      }
    }
    expect(seen.get('FACTORY')).toBe(true);
    expect(seen.get('AIRPORT')).toBe(true);
    // TOWN and HQ both declare a full constructionList, but neither lists
    // ACTION_BUILD_UNITS — that list is dead data.
    expect(seen.get('TOWN')).toBe(false);
    expect(seen.get('HQ')).toBe(false);
  });

  it('refuses to produce at a town even though it has a construction list', () => {
    const { map, game } = newGame();
    const town = findBuilding(map, 'TOWN', 'neutral')!;
    const building = map.getTerrain(town.x, town.y).getBuilding()!;
    building.setOwner(map.getPlayer(0) ?? null);
    expect(building.getConstructionList().length).toBeGreaterThan(0);
    expect(game.canProduceAt(town.x, town.y)).toBe(false);
    expect(game.buildUnit(town.x, town.y, 'INFANTRY')).toBe(false);
  });
});

describe('fog of war', () => {
  it('reveals only around units and owned buildings', () => {
    const { map } = newGame();
    map.getGameRules().setFogMode(GameEnums.Fog_OfWar);
    const player = map.getPlayer(0)!;
    const unit = map.addUnit('INFANTRY', player, 5, 8);
    map.vision.update();

    expect(player.getFieldVisible(unit.x, unit.y)).toBe(true);
    expect(player.getFieldVisible(unit.x + 1, unit.y)).toBe(true);   // vision 2
    expect(player.getFieldVisible(unit.x + 9, unit.y)).toBe(false);
  });

  it('leaves unseen tiles Fogged, not Shrouded, under standard fog', () => {
    const { map } = newGame();
    map.getGameRules().setFogMode(GameEnums.Fog_OfWar);
    const player = map.getPlayer(0)!;
    map.addUnit('INFANTRY', player, 5, 8);
    map.vision.update();

    // Fogged means the terrain and any building stay visible and only units are
    // hidden; treating it as Shrouded makes buildings appear to "de-fog" when a
    // unit walks past, which is not how Advance Wars behaves.
    expect(player.getFieldVisibleType(0, 0)).toBe(GameEnums.VisionType_Fogged);
    expect(player.getFieldVisibleType(5, 8)).toBe(GameEnums.VisionType_Clear);
  });

  it('shrouds the map only in Fog_OfShroud', () => {
    const { map } = newGame();
    map.getGameRules().setFogMode(GameEnums.Fog_OfShroud);
    const player = map.getPlayer(0)!;
    map.addUnit('INFANTRY', player, 5, 8);
    map.vision.update();
    expect(player.getFieldVisibleType(0, 0)).toBe(GameEnums.VisionType_Shrouded);
  });

  it('sees everything with fog off', () => {
    const { map } = newGame();
    const player = map.getPlayer(0)!;
    map.vision.update();
    expect(player.getFieldVisible(0, 0)).toBe(true);
    expect(player.getFieldVisible(map.width - 1, map.height - 1)).toBe(true);
  });

  it('shares vision between allies', () => {
    const { map } = newGame();
    map.getGameRules().setFogMode(GameEnums.Fog_OfWar);
    const a = map.getPlayer(0)!;
    const b = map.getPlayer(1)!;
    b.team = a.team;                                // same team => allies
    map.addUnit('INFANTRY', b, 15, 8);
    map.vision.update();
    expect(a.getFieldVisible(15, 8)).toBe(true);
  });
});

describe('captured buildings', () => {
  it('re-resolves its sprites for the new owner', () => {
    const { map, game } = newGame();
    const town = findBuilding(map, 'TOWN', 'neutral')!;
    const building = map.getTerrain(town.x, town.y).getBuilding()!;

    resolveBuildingSprites(map, registry);
    const neutralSprites = building.sprites.map(s => s.id);
    expect(neutralSprites.some(id => id.includes('neutral'))).toBe(true);

    building.setOwner(map.getPlayer(0) ?? null);
    resolveBuildingSprites(map, registry);
    const ownedSprites = building.sprites.map(s => s.id);

    // Resolving again must replace the previous owner's sprites, not append to
    // them — otherwise a captured building keeps rendering its old colours.
    expect(ownedSprites.some(id => id.includes('neutral'))).toBe(false);
    expect(ownedSprites).not.toEqual(neutralSprites);
    expect(ownedSprites.length).toBeLessThanOrEqual(neutralSprites.length + 1);
  });
});

describe('victory', () => {
  it('ends when a player loses their HQ and has nothing left', () => {
    const { map, game } = newGame();
    const loserHq = findBuilding(map, 'HQ', 1)!;
    const building = map.getTerrain(loserHq.x, loserHq.y).getBuilding()!;

    // Hand every P2 holding to P1, HQ included.
    for (const owned of game.ownedBuildings(map.getPlayer(1)!)) {
      owned.setOwner(map.getPlayer(0) ?? null);
    }
    building.setOwner(map.getPlayer(0) ?? null);

    const over = game.checkGameOver();
    expect(over).not.toBeNull();
    expect(over!.winner).toBe(0);
    expect(map.getPlayer(1)!.isDefeated).toBe(true);
  });
});

describe('transport', () => {
  it('offers Load when moving onto an allied transport', () => {
    const { map, game } = newGame();
    const player = map.getPlayer(0)!;
    const apc = map.addUnit('APC', player, 3, 8);
    const infantry = map.addUnit('INFANTRY', player, 4, 8);
    infantry.hasMoved = false;
    apc.hasMoved = false;
    map.vision.update();

    const range = game.select(4, 8)!;
    const apcTile = range.tiles.get('3,8')!;
    // The transport's tile is not somewhere the infantry can simply stop, but it
    // is a legal action target — which is exactly how loading works.
    expect(apcTile.canStop).toBe(false);
    expect(apcTile.canAct).toBe(true);
    expect(game.availableActions(infantry, { x: 3, y: 8 }).map(a => a.id)).toContain('ACTION_LOAD');
  });

  it('takes cargo off the board and puts it back on unload', () => {
    const { map, game } = newGame();
    const player = map.getPlayer(0)!;
    const apc = map.addUnit('APC', player, 3, 8);
    const infantry = map.addUnit('INFANTRY', player, 4, 8);
    infantry.hasMoved = false;
    map.vision.update();

    game.select(4, 8);
    game.performAction('ACTION_LOAD', infantry, { x: 3, y: 8 });

    expect(apc.getLoadedUnitCount()).toBe(1);
    expect(map.units).not.toContain(infantry);   // carried units are untargetable
    expect(map.getUnitAt(4, 8)).toBeNull();

    apc.hasMoved = false;
    const targets = game.unloadTargets(apc, 0);
    expect(targets.length).toBeGreaterThan(0);
    expect(game.unloadUnit(apc, 0, targets[0].x, targets[0].y)).toBe(true);

    expect(apc.getLoadedUnitCount()).toBe(0);
    expect(map.units).toContain(infantry);
    expect(map.getUnitAt(targets[0].x, targets[0].y)).toBe(infantry);
  });

  it('respects transport lists and capacity', () => {
    const { map } = newGame();
    const player = map.getPlayer(0)!;
    const apc = map.addUnit('APC', player, 3, 8);
    const infantry = map.addUnit('INFANTRY', player, 4, 8);
    const tank = map.addUnit('HEAVY_TANK', player, 5, 8);

    expect(apc.canLoad(infantry)).toBe(true);
    expect(apc.canLoad(tank)).toBe(false);      // not in APC's transport list

    apc.loadUnit(infantry);
    const second = map.addUnit('MECH', player, 6, 8);
    expect(apc.canLoad(second)).toBe(false);    // capacity is 1
  });

  it('will not unload a boat across open coastline', () => {
    const { map, game } = newGame();
    const player = map.getPlayer(0)!;
    const find = (id: string) => {
      for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
          if (map.getTerrain(x, y).getTerrainID() === id) return { x, y };
        }
      }
      return null;
    };
    const sea = find('SEA')!;
    const beach = find('BEACH')!;

    const atSea = map.addUnit('LANDER', player, sea.x, sea.y);
    atSea.loadUnit(map.addUnit('INFANTRY', player, 3, 8));
    // ACTION_UNLOAD requires the cargo to be able to stand on the transport's
    // own tile. Infantry cannot stand on sea, so a lander in open water has
    // nowhere to disembark even with land next to it.
    expect(game.unloadTargets(atSea, 0)).toEqual([]);

    const atBeach = map.addUnit('LANDER', player, beach.x, beach.y);
    atBeach.loadUnit(map.addUnit('INFANTRY', player, 4, 8));
    expect(game.unloadTargets(atBeach, 0).length).toBeGreaterThan(0);
  });

  it('will not load an enemy unit', () => {
    const { map } = newGame();
    const apc = map.addUnit('APC', map.getPlayer(0)!, 3, 8);
    const enemy = map.addUnit('INFANTRY', map.getPlayer(1)!, 4, 8);
    expect(apc.canLoad(enemy)).toBe(false);
  });

  it('only offers empty, passable adjacent tiles for unloading', () => {
    const { map, game } = newGame();
    const player = map.getPlayer(0)!;
    const apc = map.addUnit('APC', player, 3, 8);
    const infantry = map.addUnit('INFANTRY', player, 4, 8);
    apc.loadUnit(infantry);
    map.addUnit('MECH', player, 3, 7);          // blocks one side

    const targets = game.unloadTargets(apc, 0);
    expect(targets.some(t => t.x === 3 && t.y === 7)).toBe(false);
    for (const target of targets) {
      expect(Math.abs(target.x - apc.x) + Math.abs(target.y - apc.y)).toBe(1);
      expect(map.getUnitAt(target.x, target.y)).toBeNull();
    }
  });
});

describe('game configuration', () => {
  it('clamps out-of-range values', async () => {
    const { sanitizeConfig, defaultConfig } = await import('../src/game/config.ts');
    const config = defaultConfig(2, ['OS', 'BM']);
    const abused = sanitizeConfig({
      ...config,
      startingFunds: -5000,
      unitLimit: -3,
      fundsModifier: -1,
      seats: config.seats.map(seat => ({ ...seat, team: -2 })),
    });
    expect(abused.startingFunds).toBe(0);
    expect(abused.unitLimit).toBe(0);
    expect(abused.fundsModifier).toBeGreaterThan(0);
    for (const seat of abused.seats) expect(seat.team).toBeGreaterThanOrEqual(0);
  });

  it('caps absurdly large values', async () => {
    const { sanitizeConfig, defaultConfig, LIMITS } = await import('../src/game/config.ts');
    const config = defaultConfig(2, ['OS', 'BM']);
    const abused = sanitizeConfig({ ...config, startingFunds: 1e9, unitLimit: 1e6 });
    expect(abused.startingFunds).toBe(LIMITS.startingFunds.max);
    expect(abused.unitLimit).toBe(LIMITS.unitLimit.max);
  });

  it('treats a zero unit limit as unlimited, matching the engine', () => {
    const { map, game } = newGame();
    map.getGameRules().unitLimit = 0;
    const factory = findBuilding(map, 'FACTORY', 0)!;
    map.getPlayer(0)!.funds = 50_000;
    // ACTION_BUILD_UNITS tests `unitLimit <= 0`, so zero must not block building.
    expect(game.canProduceAt(factory.x, factory.y)).toBe(true);
  });
});
