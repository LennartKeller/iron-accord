import { describe, it, expect } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { Belief } from '../src/ai/belief.ts';
import { buildBeliefThreatMap } from '../src/ai/evaluate.ts';
import { GameEnums, type GameMap } from '../src/host/index.ts';

const { registry, animations, createMap } = bootstrap();

/** Two players on opposing teams, fog configurable. */
function scenario(fog: number) {
  const map: GameMap = createMap(15, 5, 'PLAINS');
  map.addPlayer('os');
  map.addPlayer('bm');
  map.getPlayer(0)!.team = 0;
  map.getPlayer(1)!.team = 1;
  map.getGameRules().setFogMode(fog);
  return map;
}

describe('Belief', () => {
  it('sees only what the player can see', () => {
    const map = scenario(GameEnums.Fog_OfWar);
    const me = map.getPlayer(0)!;
    map.addUnit('INFANTRY', me, 0, 2);                 // vision 2
    map.addUnit('LIGHT_TANK', map.getPlayer(1)!, 1, 2); // adjacent: visible
    map.addUnit('LIGHT_TANK', map.getPlayer(1)!, 14, 2); // far away: hidden
    map.vision.update();
    const game = new Game(map, registry, animations);

    const belief = new Belief(me);
    belief.observe(game);

    expect(belief.known().map(k => k.x)).toEqual([1]);
    expect(belief.visibleUnits()).toHaveLength(1);
  });

  it('erases a memory it can see is wrong', () => {
    // Keeping the old tile in view means watching the tank leave, which is
    // knowledge too — the memory must not survive being disproved.
    const map = scenario(GameEnums.Fog_OfWar);
    const me = map.getPlayer(0)!;
    map.addUnit('INFANTRY', me, 0, 2);
    const enemy = map.addUnit('LIGHT_TANK', map.getPlayer(1)!, 1, 2);
    map.vision.update();
    const game = new Game(map, registry, animations);

    const belief = new Belief(me);
    belief.observe(game);
    enemy.x = 13;
    map.vision.update();
    game.day = 2;
    belief.observe(game);
    expect(belief.known()).toHaveLength(0);
  });

  it('remembers a unit that walks out of sight, and ages it', () => {
    const map = scenario(GameEnums.Fog_OfWar);
    const me = map.getPlayer(0)!;
    const scout = map.addUnit('INFANTRY', me, 0, 2);
    const enemy = map.addUnit('LIGHT_TANK', map.getPlayer(1)!, 1, 2);
    map.vision.update();
    const game = new Game(map, registry, animations);

    const belief = new Belief(me);
    belief.observe(game);
    expect(belief.visibleUnits()).toHaveLength(1);

    // Both sides withdraw, so the sighting itself falls out of view. We should
    // still know the tank exists and where it was — forgetting outright walks
    // us into the same ambush every turn. (Had we kept watching that tile we
    // would instead have *seen* it leave, which correctly erases the memory.)
    enemy.x = 13;
    scout.x = 0; scout.y = 0;
    map.vision.update();
    game.day = 3;
    belief.observe(game);

    const known = belief.known();
    expect(known).toHaveLength(1);
    expect(known[0].seen).toBe(false);
    expect(known[0].x).toBe(1);          // the last place we actually saw it
    expect(known[0].age).toBe(2);
  });

  it('knows everything when fog is off', () => {
    const map = scenario(GameEnums.Fog_Off);
    const me = map.getPlayer(0)!;
    map.addUnit('INFANTRY', me, 0, 2);
    map.addUnit('LIGHT_TANK', map.getPlayer(1)!, 14, 2);
    map.vision.update();
    const game = new Game(map, registry, animations);

    const belief = new Belief(me);
    belief.observe(game);
    expect(belief.visibleUnits()).toHaveLength(1);
    expect(belief.unexploredFraction()).toBe(0);
  });
});

describe('belief threat map', () => {
  it('ignores enemies the player has never seen', () => {
    // The heart of playing fog honestly: an unseen tank must not make tiles
    // look dangerous, or the agent is reacting to information it does not have.
    const map = scenario(GameEnums.Fog_OfWar);
    const me = map.getPlayer(0)!;
    map.addUnit('INFANTRY', me, 0, 2);
    map.addUnit('LIGHT_TANK', map.getPlayer(1)!, 14, 2);
    map.vision.update();
    const game = new Game(map, registry, animations);

    const belief = new Belief(me);
    belief.observe(game);
    const threat = buildBeliefThreatMap(game, me, belief);

    expect(threat.at(13, 2)).toBe(0);
    expect(threat.at(14, 2)).toBe(0);
  });

  it('spreads a remembered sighting wider as it ages', () => {
    const map = scenario(GameEnums.Fog_OfWar);
    const me = map.getPlayer(0)!;
    const scout = map.addUnit('INFANTRY', me, 0, 2);
    const enemy = map.addUnit('LIGHT_TANK', map.getPlayer(1)!, 1, 2);
    map.vision.update();
    const game = new Game(map, registry, animations);

    const belief = new Belief(me);
    belief.observe(game);
    enemy.x = 13;
    scout.x = 0; scout.y = 0;
    map.vision.update();
    game.day = 2;
    belief.observe(game);

    // Still remembered around its last sighting, and the uncertainty has grown
    // outward rather than the threat vanishing.
    const threat = buildBeliefThreatMap(game, me, belief);
    expect(threat.at(1, 2)).toBeGreaterThan(0);
    expect(threat.at(8, 2)).toBeGreaterThan(0);
  });
});
