import { describe, expect, it } from 'vitest';
import { ProductionSystem } from '../src/ai/cw/production.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { BuildingHost } from '../src/host/building.ts';

const { createMap, registry, animations } = bootstrap();

describe('production persistence', () => {
  it('preserves its original distribution and remaining opening purchases after capturing an airport', () => {
    const map = createMap(4, 1, 'PLAINS');
    const player = map.addPlayer('os');
    const game = new Game(map, registry, animations);
    const building = (id: string, x: number) => {
      const host = new BuildingHost(map, id, player);
      host.setTerrain(map.getTerrain(x, 0));
      map.getTerrain(x, 0).building = host;
      host.init();
      return host;
    };
    const factory = building('FACTORY', 0);
    const retained = new ProductionSystem(() => 0.25);
    retained.initialize(player, [factory]);
    retained.updateActive([factory]);
    // Spend one of the six opening purchases before the match is saved.
    expect(retained.buildNextUnit(game, player, [factory], [], () => true)?.kind).toBe('build');
    const airport = building('AIRPORT', 1);
    const owned = [factory, airport];
    const saved = JSON.parse(JSON.stringify(retained.saveState()));
    const resumed = new ProductionSystem(() => 0.25);
    resumed.loadState(saved, player, owned);
    expect(resumed.ready).toBe(true);
    expect(resumed.saveState()).toEqual(saved);
    expect(saved.initialProduction).toEqual([{ unitIds: ['INFANTRY'], count: 5 }]);
    // A fresh initialization would restart the six opening purchases. Resume
    // preserves the remaining queue and the uninterrupted distribution.
    const restarted = new ProductionSystem(() => 0.25);
    restarted.initialize(player, owned);
    expect(restarted.saveState()).not.toEqual(saved);
    resumed.updateActive(owned);
    retained.updateActive(owned);
    expect(resumed.buildNextUnit(game, player, owned, [], () => true))
      .toEqual(retained.buildNextUnit(game, player, owned, [], () => true));
    expect(resumed.saveState()).toEqual(retained.saveState());
  });

  it('rejects malformed saved distributions before changing an existing system', () => {
    const map = createMap(1, 1, 'PLAINS');
    const player = map.addPlayer('os');
    const production = new ProductionSystem(() => 0.25);
    production.initialize(player, []);
    const before = production.saveState();
    const broken = JSON.parse(JSON.stringify(before));
    broken.buildDistribution[0][1].chance = [null];
    production.loadState(broken, player, []);
    expect(production.saveState()).toEqual(before);
  });
});
