import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { snapshot } from '../src/game/snapshot.ts';
import type { Player } from '../src/host/index.ts';
import { GameEnvironment } from '../src/ai/environment.ts';
import { NormalAi } from '../src/ai/cw/normalai.ts';
import { calculateCounterDamage, type ScoringContext } from '../src/ai/cw/scoring.ts';
import type { CoreAI } from '../src/ai/cw/coreai.ts';
import type { InfluenceFrontMap } from '../src/ai/cw/influencefrontmap.ts';
import type { MoveUnitData } from '../src/ai/cw/unitdata.ts';
import type { TargetScoringOptions } from '../src/ai/cw/targets.ts';

const { registry, createMap, animations, rng } = bootstrap();

// Inspect the actual integration cache: independently constructing a correct
// enemy datum would miss a refresh that supplies an empty opponent list.
interface ThreatCache {
  core: CoreAI;
  ownUnits: MoveUnitData[];
  enemyUnits: MoveUnitData[];
  influence: InfluenceFrontMap;
  refresh(game: Game, player: Player): void;
  targetOptions(): TargetScoringOptions;
}

function battlefield(width = 9, height = 7, ownX = 2, ownY = 3, enemyX = 5, enemyY = 3) {
  const map = createMap(width, height);
  const player = map.addPlayer('os');
  const enemyPlayer = map.addPlayer('bm');
  enemyPlayer.team = 1;
  const own = map.addUnit('INFANTRY', player, ownX, ownY);
  const enemy = map.addUnit('LIGHT_TANK', enemyPlayer, enemyX, enemyY);
  const game = new Game(map, registry, animations);
  const env = new GameEnvironment(map, registry, { rng }, game);
  // Isolate retaliation from the separate influence premium while still
  // checking the generated influence map itself.
  const ai = new NormalAi({ config: { influenceMultiplier: 0 } });
  ai.beginTurn(env);
  const cache = ai as unknown as ThreatCache;
  const refresh = () => cache.refresh(game, player);
  const context = (): ScoringContext => ({
    ai: cache.core, ownUnits: cache.ownUnits, enemyUnits: cache.enemyUnits,
    influence: cache.influence, targetOptions: cache.targetOptions(),
  });
  const risk = () => calculateCounterDamage(
    context(), cache.ownUnits.find(data => data.unit === own)!, own,
    null, 0, [], [], true);
  return { map, game, player, enemyPlayer, own, enemy, cache, refresh, risk };
}

describe('NormalAi enemy threats', () => {
  it('projects nearby enemy movement and influence without changing the match', () => {
    const { game, enemy, cache, refresh, risk } = battlefield();
    const before = snapshot(game);
    const randomBefore = rng.getState();
    refresh();

    expect(cache.enemyUnits[0].range?.tiles.size).toBeGreaterThan(1);
    expect(cache.influence.getInfluenceInfo(enemy.x, enemy.y).getEnemyInfluence()).toBeGreaterThan(0);
    // The tank is three tiles away: this damage requires an enemy move.
    expect(risk()).toBeGreaterThan(0);
    expect(snapshot(game)).toEqual(before);
    expect(rng.getState()).toBe(randomBefore);
  });

  it('can omit a distant enemy range while still exploring a nearby enemy', () => {
    const { map, enemyPlayer, cache, refresh } = battlefield(40, 7);
    const distant = map.addUnit('LIGHT_TANK', enemyPlayer, 38, 3);
    refresh();
    expect(cache.enemyUnits.find(data => data.unit === distant)?.range).toBeNull();
    expect(cache.enemyUnits.find(data => data.unit !== distant)?.range).not.toBeNull();
  });

  it('rebuilds enemy reach after a committed move vacates a blocking tile', () => {
    const { game, own, cache, refresh } = battlefield();
    refresh();
    const previous = cache.enemyUnits[0].range!;
    expect(previous.tiles.has('2,3')).toBe(false);
    expect(game.performAction('ACTION_WAIT', own, { x: 2, y: 2 })).toBe(true);
    const afterMove = snapshot(game);
    refresh();

    const rebuilt = cache.enemyUnits[0].range!;
    expect(rebuilt).not.toBe(previous);
    expect(rebuilt.tiles.has('2,3')).toBe(true);
    expect(cache.ownUnits[0].range!.tiles.get('2,2')?.cost).toBe(0);
    expect(snapshot(game)).toEqual(afterMove);
  });

  it('does not grant an extra movement point when evaluating retaliation across weighted terrain', () => {
    // A tank six steps from its firing tile cannot reach it when one step
    // costs two. The narrow corridor rules out a cheaper route around it.
    const { map, cache, refresh, risk } = battlefield(8, 1, 7, 0, 0, 0);
    map.setTerrainID(3, 0, 'FOREST');
    refresh();
    const enemyData = cache.enemyUnits[0];
    expect(enemyData.movementPoints).toBe(6);
    expect(enemyData.range!.tiles.get('6,0')?.cost).toBe(7);
    expect(risk()).toBe(0);

    map.setTerrainID(3, 0, 'PLAINS');
    refresh();
    expect(cache.enemyUnits[0].range!.tiles.get('6,0')?.cost).toBe(6);
    expect(risk()).toBeGreaterThan(0);
  });
});
