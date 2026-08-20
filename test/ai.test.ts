import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import { snapshot, restore, withRollback } from '../src/game/snapshot.ts';
import { GameEnvironment, RandomAgent, playMatch, enumerateActions, applyAction, actionKey } from '../src/ai/index.ts';
import { GameEnums } from '../src/host/index.ts';

const { registry, animations, rng } = bootstrap();
const source = readMap(fs.readFileSync(path.join(cwRoot(), 'maps/2_player/60-ZWEITER KRIEG.map')));

function newGame() {
  const map = loadIntoGameMap(source, registry);
  return { map, game: new Game(map, registry, animations) };
}

/** A compact fingerprint of everything that should survive a rollback. */
function fingerprint(game: Game): string {
  return JSON.stringify({
    day: game.day,
    player: game.currentPlayerIndex,
    funds: game.map.players.map(p => p.funds),
    units: game.map.units.map(u => [u.uid, u.getUnitID(), u.x, u.y, u.getHp(), u.fuel, u.ammo1, u.hasMoved]),
  });
}

describe('turn-start effects', () => {
  it('burns fuel on aircraft each turn', () => {
    const { map, game } = newGame();
    const bomber = map.addUnit('BOMBER', map.getPlayer(0)!, 6, 3);
    const before = bomber.fuel;
    game.endTurn();
    game.endTurn();
    // bomber.js pays 5 fuel of upkeep in its startOfTurn hook
    expect(bomber.fuel).toBe(before - 5);
  });

  it('repairs and resupplies a unit on an owned building', () => {
    const { map, game } = newGame();
    const player = map.getPlayer(0)!;
    let factory: { x: number; y: number } | null = null;
    for (let y = 0; y < map.height && !factory; y++) {
      for (let x = 0; x < map.width; x++) {
        const building = map.getTerrain(x, y).getBuilding();
        if (building?.getBuildingID() === 'FACTORY' && building.getOwner() === player) {
          factory = { x, y };
          break;
        }
      }
    }
    const unit = map.addUnit('INFANTRY', player, factory!.x, factory!.y);
    unit.setHp(4);
    unit.setAmmo1(2);
    unit.setFuel(10);

    game.endTurn();
    game.endTurn();

    expect(unit.getHp()).toBe(6);              // BUILDING.replenishUnit heals 2
    expect(unit.getAmmo1()).toBe(unit.maxAmmo1);
    expect(unit.fuel).toBe(unit.maxFuel);
  });

  it('does not heal a unit past full', () => {
    const { map, game } = newGame();
    const unit = map.addUnit('INFANTRY', map.getPlayer(0)!, 3, 8);
    game.endTurn();
    game.endTurn();
    expect(unit.getHp()).toBe(10);
  });
});

describe('snapshot and restore', () => {
  it('returns the game to an identical state', () => {
    const { map, game } = newGame();
    const attacker = map.addUnit('INFANTRY', map.getPlayer(0)!, 5, 8);
    map.addUnit('INFANTRY', map.getPlayer(1)!, 6, 8);
    attacker.hasMoved = false;
    map.vision.update();

    const before = fingerprint(game);
    const saved = snapshot(game);

    game.select(5, 8);
    game.attack(attacker, { x: 5, y: 8 }, { x: 6, y: 8 });
    game.endTurn();
    expect(fingerprint(game)).not.toBe(before);

    restore(game, saved);
    expect(fingerprint(game)).toBe(before);
  });

  it('preserves unit identity so actions stay valid after a rollback', () => {
    const { map, game } = newGame();
    const unit = map.addUnit('INFANTRY', map.getPlayer(0)!, 3, 8);
    const uid = unit.uid;

    withRollback(game, () => {
      game.select(3, 8);
      game.moveSelected(3, 6);
    });

    const restored = map.getUnitByUid(uid);
    expect(restored).not.toBeNull();
    expect(restored!.x).toBe(3);
    expect(restored!.y).toBe(8);
  });

  it('restores fog mode and captured buildings', () => {
    const { map, game } = newGame();
    map.getGameRules().setFogMode(GameEnums.Fog_OfWar);
    const saved = snapshot(game);

    map.getGameRules().setFogMode(GameEnums.Fog_Off);
    for (const building of game.ownedBuildings(map.getPlayer(1)!)) {
      building.setOwner(map.getPlayer(0) ?? null);
    }

    restore(game, saved);
    expect(map.getGameRules().getFogMode()).toBe(GameEnums.Fog_OfWar);
    expect(game.ownedBuildings(map.getPlayer(1)!).length).toBeGreaterThan(0);
  });
});

describe('agent interface', () => {
  it('enumerates legal actions as serialisable descriptors', () => {
    const { map, game } = newGame();
    map.addUnit('INFANTRY', map.getPlayer(0)!, 3, 8);
    for (const unit of map.units) unit.hasMoved = false;

    const actions = enumerateActions(game);
    expect(actions.length).toBeGreaterThan(1);
    expect(actions.some(a => a.kind === 'endTurn')).toBe(true);
    // Descriptors must survive a round trip through JSON to be usable as
    // RL action labels or replay entries.
    for (const action of actions.slice(0, 20)) {
      expect(JSON.parse(JSON.stringify(action))).toEqual(action);
      expect(actionKey(action)).toBeTruthy();
    }
  });

  it('applies an enumerated action and rejects a stale one', () => {
    const { map, game } = newGame();
    const unit = map.addUnit('INFANTRY', map.getPlayer(0)!, 3, 8);
    unit.hasMoved = false;

    const move = enumerateActions(game).find(
      a => a.kind === 'unit' && a.uid === unit.uid && a.actionId === 'ACTION_WAIT'
        && (a.to.x !== 3 || a.to.y !== 8));
    expect(move).toBeDefined();
    expect(applyAction(game, move!)).toBe(true);
    expect(unit.hasMoved).toBe(true);

    // Same descriptor again: the unit has already acted.
    expect(applyAction(game, move!)).toBe(false);
  });

  it('encodes an observation with the documented shape', () => {
    const { map, game } = newGame();
    const env = new GameEnvironment(map, registry, {}, game);
    const observation = env.observe();

    expect(observation.spec.height).toBe(map.height);
    expect(observation.spec.width).toBe(map.width);
    expect(observation.planes.length).toBe(
      observation.spec.channels * observation.spec.height * observation.spec.width);
    expect(observation.spec.channelNames).toHaveLength(observation.spec.channels);
    expect(observation.scalars.length).toBe(observation.spec.scalarNames.length);
    // Everything is normalised; a policy should never see a wild magnitude.
    for (const value of observation.planes) expect(Math.abs(value)).toBeLessThanOrEqual(1);
    for (const value of observation.scalars) expect(Math.abs(value)).toBeLessThanOrEqual(1);
  });

  it('plays a deterministic match from a seed', async () => {
    const run = async () => {
      const { map, game } = newGame();
      // The script RNG is shared across games, so it must be reseeded per
      // episode or combat luck carries over and two runs diverge.
      const env = new GameEnvironment(map, registry, { maxDays: 30, rng, seed: 4242 }, game);
      env.reset();
      return playMatch(env, [new RandomAgent(7), new RandomAgent(8)], { maxSteps: 3000 });
    };
    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
    expect(first.steps).toBeGreaterThan(0);
  });

  it('penalises an illegal action instead of throwing', () => {
    const { map, game } = newGame();
    const env = new GameEnvironment(map, registry, {}, game);
    const result = env.step({ kind: 'unit', uid: 99999, actionId: 'ACTION_WAIT', to: { x: 0, y: 0 } });
    expect(result.info.accepted).toBe(false);
    expect(result.reward).toBeLessThan(0);
  });
});

describe('action enumeration is side-effect free', () => {
  function siloGame() {
    const map = loadIntoGameMap(source, registry);
    const game = new Game(map, registry, animations);
    let silo: { x: number; y: number } | null = null;
    for (let y = 0; y < map.height && !silo; y++) {
      for (let x = 0; x < map.width; x++) {
        if (map.getTerrain(x, y).getBuilding()?.getBuildingID() === 'SILO_ROCKET') { silo = { x, y }; break; }
      }
    }
    return { map, game, silo: silo! };
  }

  it('does not spend units or damage anything while listing moves', () => {
    const { map, game, silo } = siloGame();
    const unit = map.addUnit('INFANTRY', map.getPlayer(0)!, silo.x, silo.y);
    unit.hasMoved = false;
    const victim = map.addUnit('INFANTRY', map.getPlayer(1)!, 10, 7);
    map.vision.update();

    const hp = victim.getHp();
    const funds = map.getPlayer(0)!.funds;
    const actions = enumerateActions(game, { maxFieldChoices: 5 });

    // beginAction performs single-step actions immediately; enumeration must
    // use the non-performing probe or merely considering a move spends the unit.
    expect(actions.length).toBeGreaterThan(0);
    expect(unit.hasMoved).toBe(false);
    expect(victim.getHp()).toBe(hp);
    expect(map.getPlayer(0)!.funds).toBe(funds);
  });

  it('enumerates multi-step actions with their input baked in', () => {
    const { map, game, silo } = siloGame();
    const unit = map.addUnit('INFANTRY', map.getPlayer(0)!, silo.x, silo.y);
    unit.hasMoved = false;
    map.addUnit('INFANTRY', map.getPlayer(1)!, 10, 7);
    map.vision.update();

    const actions = enumerateActions(game, { maxFieldChoices: 40 });
    const missiles = actions.filter(a => a.kind === 'unit' && a.actionId === 'ACTION_MISSILE');
    expect(missiles.length).toBeGreaterThan(1);
    for (const missile of missiles) {
      expect(missile.kind).toBe('unit');
      if (missile.kind === 'unit') expect(missile.steps).toHaveLength(1);
      // Descriptors stay serialisable even with their step inputs.
      expect(JSON.parse(JSON.stringify(missile))).toEqual(missile);
    }
  });

  it('applies a multi-step action from its descriptor', () => {
    const { map, game, silo } = siloGame();
    const unit = map.addUnit('INFANTRY', map.getPlayer(0)!, silo.x, silo.y);
    unit.hasMoved = false;
    const victim = map.addUnit('INFANTRY', map.getPlayer(1)!, 10, 7);
    map.vision.update();

    const strike = {
      kind: 'unit' as const, uid: unit.uid, actionId: 'ACTION_MISSILE',
      to: { x: silo.x, y: silo.y }, steps: [{ x: 10, y: 7 }],
    };
    expect(applyAction(game, strike)).toBe(true);
    expect(victim.getHp()).toBeLessThan(10);
    expect(unit.hasMoved).toBe(true);
  });
});
