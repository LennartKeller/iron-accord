import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { snapshot } from '../src/game/snapshot.ts';
import { BuildingHost, type Player } from '../src/host/index.ts';
import { NormalAi } from '../src/ai/cw/normalai.ts';
import { ProductionSystem } from '../src/ai/cw/production.ts';
import { applyAction } from '../src/ai/actions.ts';

const { createMap, registry, animations, rng } = bootstrap();
function factory() {
  const map = createMap(7, 3, 'PLAINS');
  const player = map.addPlayer('os'), enemy = map.addPlayer('bm');
  player.team = 0; enemy.team = 1;
  player.funds = 50000;
  const game = new Game(map, registry, animations);
  const building = new BuildingHost(map, 'FACTORY', player);
  building.setTerrain(map.getTerrain(1, 1));
  map.getTerrain(1, 1).building = building;
  building.init();
  const ai = new NormalAi();
  const probe = (id: string) => (ai as unknown as {
    canBuildHere(game: Game, player: Player, at: { x: number; y: number }, id: string): boolean;
  }).canBuildHere(game, player, { x: 1, y: 1 }, id);
  return { map, player, enemy, game, building, probe };
}

describe('production planning safeguards', () => {
  it('probes an apparently empty factory without replacing its hidden occupant or consuming UIDs', () => {
    const { map, player, enemy, game, probe } = factory();
    const hidden = map.addUnit('INFANTRY', enemy, 1, 1);
    hidden.setHidden(true);
    expect(hidden.isStealthed(player)).toBe(true);
    const before = snapshot(game), uid = map.getUnitUidCounter(), random = rng.getState();
    expect(probe('INFANTRY')).toBe(true);
    expect(probe('LIGHT_TANK')).toBe(true);
    expect(map.getUnitAt(1, 1)).toBe(hidden);
    expect(map.getUnitByUid(hidden.uid)).toBe(hidden);
    expect(map.getUnitUidCounter()).toBe(uid);
    expect(rng.getState()).toBe(random);
    expect(snapshot(game)).toEqual(before);
  });

  it('rechecks static mobility when terrain changes instead of caching a stranded result', () => {
    const { map, probe } = factory();
    expect(probe('PIPERUNNER')).toBe(false);
    map.setTerrainID(2, 1, 'PIPELINE');
    expect(probe('PIPERUNNER')).toBe(true);
    map.setTerrainID(2, 1, 'PLAINS');
    expect(probe('PIPERUNNER')).toBe(false);
  });

  it('ignores temporary visible blockers when deciding whether a unit can leave its factory', () => {
    const { map, enemy, game, probe } = factory();
    map.setTerrainID(2, 1, 'PIPELINE');
    const blocker = map.addUnit('INFANTRY', enemy, 2, 1);
    const before = snapshot(game);
    expect(probe('PIPERUNNER')).toBe(true);
    expect(snapshot(game)).toEqual(before);
    map.removeUnit(blocker);
    expect(probe('PIPERUNNER')).toBe(true);
  });

  it('keeps weighted unit IDs aligned after excluding an expensive candidate', () => {
    const { game, player, building } = factory();
    player.funds = 5000;
    const production = new ProductionSystem(() => 0.5);
    production.initialize(player, [building]);
    const state = JSON.parse(JSON.stringify(production.saveState()));
    state.initialProduction = [];
    state.forcedProduction = [];
    state.buildDistribution = [['FILTERED_GROUP', {
      unitIds: ['HEAVY_TANK', 'INFANTRY', 'MECH'], chance: [100, 0, 100], totalChance: 200,
      distribution: 100, maxUnitDistribution: 1, buildMode: 0,
    }]];
    production.loadState(state, player, [building]);
    production.updateActive([building]);
    const action = production.buildNextUnit(game, player, [building], [], (_at, id) =>
      game.buildOptions(building).some(option => option.id === id && option.affordable));
    expect(action).toMatchObject({ kind: 'build', unitId: 'MECH' });
    expect(applyAction(game, action!)).toBe(true);
    expect(game.map.getUnitAt(1, 1)?.getUnitID()).toBe('MECH');
    expect(player.funds).toBe(5000 - player.getCosts('MECH'));
  });
});
