import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { BuildingHost, GameEnums, type Player } from '../src/host/index.ts';
import { CoreAI } from '../src/ai/cw/coreai.ts';
import { NORMAL_AI_DEFAULTS } from '../src/ai/cw/config.ts';
import { ProductionSystem } from '../src/ai/cw/production.ts';
import { applyAction } from '../src/ai/actions.ts';

const { createMap, registry } = bootstrap();
function fixture() {
  const map = createMap(21, 5, 'PLAINS');
  const player = map.addPlayer('os'), enemy = map.addPlayer('bm'); enemy.team = 1;
  const game = new Game(map, registry); player.funds = 10000; game.day = 10;
  const core = new CoreAI(game, player, { ...NORMAL_AI_DEFAULTS });
  const production = new ProductionSystem(() => 0.25);
  const building = (id: string, x: number, owner: Player = player) => {
    const b = new BuildingHost(map, id, owner);
    b.setTerrain(map.getTerrain(x, 2)); map.getTerrain(x, 2).building = b; b.init();
    return b;
  };
  return { map, player, enemy, game, core, production, building };
}

describe('captured production bases', () => {
  it('uses a newly captured airport without restarting the opening or reserving its own aircraft funds', () => {
    const { map, player, enemy, game, core, production, building } = fixture();
    const factory = building('FACTORY', 1);
    production.initialize(player, [factory]);
    // Consume the original opening, then occupy the land base with an existing unit.
    for (let i = 0; i < 6; i++) production.buildNextUnit(game, player, [factory], [], () => true);
    map.addUnit('INFANTRY', player, 1, 2);
    const airport = building('AIRPORT', 17, enemy); airport.setOwner(player);
    const action = production.chooseAction(game, core, [factory, airport], [], []);
    expect(action).toEqual({ kind: 'build', at: { x: 17, y: 2 }, unitId: 'K_HELI' });
    expect(applyAction(game, action!)).toBe(true);
    expect(player.funds).toBe(1000);
    expect(production.saveState()).toMatchObject({ initialProduction: [] });
    expect(production.chooseAction(game, core, [factory, airport], [], [])).toBeNull();
  });

  it('does not release a reserve into an unaffordable or forbidden aircraft purchase', () => {
    const { player, game, core, production, building } = fixture();
    const airport = building('AIRPORT', 17);
    player.funds = 8000;
    // Permit combat helicopters only: neither cash nor static-mobility guards
    // may be bypassed by the reserve-release retry.
    expect(production.chooseAction(game, core, [airport], [], [], (_at, id) => id === 'K_HELI')).toBeNull();
    player.funds = 10000;
    expect(production.chooseAction(game, core, [airport], [], [], () => false)).toBeNull();
    expect(production.chooseAction(game, core, [airport], [], [], (_at, id) => id === 'K_HELI'))
      .toMatchObject({ kind: 'build', unitId: 'K_HELI' });
    expect(player.funds).toBe(10000);
  });

  it('uses known enemy bases to locate the front when no enemy units are visible', () => {
    const { enemy, game, core, production, building } = fixture();
    const rear = building('FACTORY', 1), captured = building('FACTORY', 17);
    const enemyBase = building('HQ', 20, enemy);
    expect(production.chooseAction(game, core, [rear, captured], [], [enemyBase]))
      .toMatchObject({ kind: 'build', at: { x: 17, y: 2 } });
  });

  it('does not locate a front from shrouded enemy buildings', () => {
    const { map, enemy, game, core, production, building } = fixture();
    const rear = building('FACTORY', 1), captured = building('FACTORY', 17);
    const enemyBase = building('HQ', 20, enemy);
    map.rules.fogMode = GameEnums.Fog_OfShroud; map.vision.update();
    expect(production.chooseAction(game, core, [rear, captured], [], [enemyBase]))
      .toMatchObject({ kind: 'build', at: { x: 1, y: 2 } });
  });
});
