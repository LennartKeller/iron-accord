import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import {
  GameEnvironment, HeuristicAgent, RandomAgent, playMatch, enumerateActions,
  buildingValue, unitValue, buildThreatMap,
} from '../src/ai/index.ts';
import { canCapture } from '../src/ai/evaluate.ts';

const { registry, animations, rng } = bootstrap();

function loadGame(file: string) {
  const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), file))), registry);
  const game = new Game(map, registry, animations);
  const env = new GameEnvironment(map, registry, { maxDays: 30, maxFieldChoices: 6, rng, seed: 99 }, game);
  return { map, game, env };
}

const CROSSPATHS = 'maps/pre_deployed/Crosspaths.map';

describe('evaluation', () => {
  it('prices an HQ far above anything else', () => {
    const { map } = loadGame(CROSSPATHS);
    let hq = null, other = null;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const b = map.getTerrain(x, y).getBuilding();
        if (!b) continue;
        if (b.getBuildingID() === 'HQ') hq = b; else other = b;
      }
    }
    expect(hq).not.toBeNull();
    if (other) expect(buildingValue(hq!)).toBeGreaterThan(buildingValue(other) * 4);
  });

  it('values a unit by cost scaled with health', () => {
    const { map } = loadGame(CROSSPATHS);
    const unit = map.addUnit('HEAVY_TANK', map.getPlayer(0)!, 3, 3);
    const full = unitValue(unit);
    unit.setHp(5);
    expect(unitValue(unit)).toBeCloseTo(full / 2, 6);
  });

  it('marks tiles the enemy can reach as threatened', () => {
    const { map, game } = loadGame(CROSSPATHS);
    const self = map.getPlayer(0)!;
    const enemy = map.addUnit('LIGHT_TANK', map.getPlayer(1)!, 5, 5);
    map.vision.update();

    const threat = buildThreatMap(game, self);
    expect(threat.at(enemy.x, enemy.y)).toBeGreaterThan(0);
    // Far corner should be out of a tank's reach on this map.
    expect(threat.at(0, 0)).toBe(0);
  });
});

describe('heuristic agent', () => {
  it('captures rather than waiting when it is standing on an enemy HQ', () => {
    const { map, game, env } = loadGame(CROSSPATHS);
    const player = map.getPlayer(0)!;
    const infantry = player.units.find(canCapture)!;

    let hq: { x: number; y: number } | null = null;
    for (let y = 0; y < map.height && !hq; y++) {
      for (let x = 0; x < map.width; x++) {
        const b = map.getTerrain(x, y).getBuilding();
        if (b?.getBuildingID() === 'HQ' && b.getOwner() !== player) { hq = { x, y }; break; }
      }
    }
    infantry.moveUnitToField(hq!.x, hq!.y);
    infantry.hasMoved = false;
    map.vision.update();

    const agent = new HeuristicAgent();
    agent.beginTurn(env);
    const mine = enumerateActions(game, { maxFieldChoices: 4 })
      .filter(a => a.kind === 'unit' && a.uid === infantry.uid);
    const chosen = agent.selectAction(env, mine);
    expect(chosen?.kind).toBe('unit');
    if (chosen?.kind === 'unit') expect(chosen.actionId).toBe('ACTION_CAPTURE');
  });

  it('does not park a non-capturing unit on a capture target', () => {
    const { map, game, env } = loadGame(CROSSPATHS);
    const player = map.getPlayer(0)!;
    const tank = player.units.find(u => !canCapture(u))!;

    let hq: { x: number; y: number } | null = null;
    for (let y = 0; y < map.height && !hq; y++) {
      for (let x = 0; x < map.width; x++) {
        const b = map.getTerrain(x, y).getBuilding();
        if (b?.getBuildingID() === 'HQ' && b.getOwner() !== player) { hq = { x, y }; break; }
      }
    }
    // Standing next to the objective, the tank must not choose to sit on it —
    // doing so blocks our own infantry from ever capturing.
    tank.moveUnitToField(hq!.x, hq!.y - 1);
    tank.hasMoved = false;
    map.vision.update();

    const agent = new HeuristicAgent();
    agent.beginTurn(env);
    const mine = enumerateActions(game, { maxFieldChoices: 4 })
      .filter(a => a.kind === 'unit' && a.uid === tank.uid);
    const chosen = agent.selectAction(env, mine);
    if (chosen?.kind === 'unit') {
      expect(chosen.to).not.toEqual(hq);
    }
  });

  it('avoids a suicidal trade in favour of an even one', () => {
    const { map, game, env } = loadGame(CROSSPATHS);
    const player = map.getPlayer(0)!;
    const enemy = map.getPlayer(1)!;
    for (const unit of [...map.units]) map.removeUnit(unit);

    // An infantry can hurt another infantry, but throwing itself at a heavy
    // tank loses far more value than it deals.
    const infantry = map.addUnit('INFANTRY', player, 4, 4);
    infantry.hasMoved = false;
    map.addUnit('INFANTRY', enemy, 5, 4);
    map.addUnit('HEAVY_TANK', enemy, 3, 4);
    map.vision.update();

    const agent = new HeuristicAgent();
    agent.beginTurn(env);
    const attacks = enumerateActions(game, { maxFieldChoices: 4 })
      .filter(a => a.kind === 'unit' && a.actionId === 'ACTION_FIRE' && a.uid === infantry.uid);
    expect(attacks.length).toBeGreaterThan(1);

    const chosen = agent.selectAction(env, attacks);
    expect(chosen?.kind).toBe('unit');
    if (chosen?.kind === 'unit') expect(chosen.target).toEqual({ x: 5, y: 4 });
  });

  it('scores damage in funds, so hurting an expensive unit can beat a cheap kill', () => {
    const { map, game, env } = loadGame(CROSSPATHS);
    const player = map.getPlayer(0)!;
    const enemy = map.getPlayer(1)!;
    for (const unit of [...map.units]) map.removeUnit(unit);

    const tank = map.addUnit('HEAVY_TANK', player, 4, 4);
    tank.hasMoved = false;
    map.addUnit('INFANTRY', enemy, 5, 4);
    map.addUnit('HEAVY_TANK', enemy, 3, 4);
    map.vision.update();

    const agent = new HeuristicAgent();
    agent.beginTurn(env);
    const attacks = enumerateActions(game, { maxFieldChoices: 4 })
      .filter(a => a.kind === 'unit' && a.actionId === 'ACTION_FIRE' && a.uid === tank.uid);
    const chosen = agent.selectAction(env, attacks);

    // Killing the infantry returns ~1350 in value; landing ~55% on a 12000-cost
    // tank returns far more even after the counter, so the tank is the target.
    if (chosen?.kind === 'unit') expect(chosen.target).toEqual({ x: 3, y: 4 });
  });

  it('beats a random opponent from either seat', async () => {
    for (const seat of [0, 1]) {
      const { env } = loadGame(CROSSPATHS);
      env.reset(4242);
      const agents = seat === 0
        ? [new HeuristicAgent(), new RandomAgent(3)]
        : [new RandomAgent(3), new HeuristicAgent()];
      const result = await playMatch(env, agents, { maxSteps: 4000 });
      expect(result.winner).toBe(seat);
    }
  });

  it('reaches the same result twice from the same seed', async () => {
    const run = async () => {
      const { env } = loadGame(CROSSPATHS);
      env.reset(77);
      return playMatch(env, [new HeuristicAgent(), new HeuristicAgent()], { maxSteps: 4000 });
    };
    expect(await run()).toEqual(await run());
  });
});
