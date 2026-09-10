import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { snapshot } from '../src/game/snapshot.ts';
import { applyAction } from '../src/ai/actions.ts';
import { CoreAI } from '../src/ai/cw/coreai.ts';
import { NORMAL_AI_DEFAULTS } from '../src/ai/cw/config.ts';
import { InfluenceFrontMap } from '../src/ai/cw/influencefrontmap.ts';
import { selectMovementAction } from '../src/ai/cw/movement-actions.ts';
import { createUnitData } from '../src/ai/cw/unitdata.ts';

const { createMap, registry, animations } = bootstrap();
function fixture(id: string, terrain = 'PLAINS') {
  const map = createMap(7, 4, terrain);
  const player = map.addPlayer('os'), enemy = map.addPlayer('bm');
  player.team = 0; enemy.team = 1;
  const unit = map.addUnit(id, player, 2, 1);
  const game = new Game(map, registry, animations);
  const ai = new CoreAI(game, player, { ...NORMAL_AI_DEFAULTS });
  const data = createUnitData(unit, false, 2, [], 0, true);
  const influence = new InfluenceFrontMap(map, ai.islandMaps);
  influence.setOwner(player);
  const context = {
    ai, ownUnits: [data], enemyUnits: [] as ReturnType<typeof createUnitData>[], influence,
    targetOptions: { ...NORMAL_AI_DEFAULTS, enableNeutralTerrainAttack: false },
  };
  return { map, game, player, enemy, unit, data, context };
}

describe('NormalAI actions after movement', () => {
  it('probes support without consuming it, then resupplies from the destination', () => {
    const { map, game, player, unit, data, context } = fixture('APC');
    unit.setAmmo1(0); // no building materials: SUPPORTALL is the first available follow-up.
    const infantry = map.addUnit('INFANTRY', player, 4, 1);
    infantry.setFuel(1);
    const before = snapshot(game);
    const action = selectMovementAction(context, data, { x: 3, y: 1 }, [], [], () => 0);
    expect(action).toMatchObject({ actionId: 'ACTION_SUPPORTALL_RATION', to: { x: 3, y: 1 } });
    expect(snapshot(game)).toEqual(before);
    expect(applyAction(game, action!)).toBe(true);
    expect(infantry.getFuel()).toBe(infantry.getMaxFuel());
    expect(unit.hasMoved).toBe(true);
    expect(unit.x).toBe(3);
  });

  it('performs a final build action before support, following the unit action order', () => {
    const { map, game, player, unit, data, context } = fixture('APC');
    const infantry = map.addUnit('INFANTRY', player, 4, 1);
    infantry.setFuel(1);
    const action = selectMovementAction(context, data, { x: 3, y: 1 }, [], [], () => 0);
    expect(action).toMatchObject({ actionId: 'ACTION_BUILD_TEMP_AIRPORT' });
    expect(applyAction(game, action!)).toBe(true);
    expect(unit.x).toBe(3);
    expect(unit.getCapturePoints()).toBe(10);
    expect(unit.hasMoved).toBe(true);
    expect(infantry.getFuel()).toBe(1);
  });

  it('moves and stealths a submarine, and only surfaces where counter-damage is zero', () => {
    const { game, unit, data, context } = fixture('SUBMARINE', 'SEA');
    const dive = selectMovementAction(context, data, { x: 3, y: 1 }, [], [], () => 0);
    expect(dive).toMatchObject({ actionId: 'ACTION_STEALTH' });
    expect(unit.getHidden()).toBe(false);
    expect(applyAction(game, dive!)).toBe(true);
    expect(unit.getHidden()).toBe(true);
    expect(unit.x).toBe(3);
    unit.hasMoved = false;
    const surface = selectMovementAction(context, data, { x: 3, y: 1 }, [], [], () => 0);
    expect(surface).toMatchObject({ actionId: 'ACTION_UNSTEALTH' });
    expect(applyAction(game, surface!)).toBe(true);
    expect(unit.getHidden()).toBe(false);
  });

  it('does not surface into a cruiser counterattack', () => {
    const { map, enemy, unit, data, context } = fixture('SUBMARINE', 'SEA');
    unit.setHidden(true);
    const cruiser = map.addUnit('CRUISER', enemy, 4, 1);
    context.enemyUnits.push(createUnitData(cruiser, true, 2, [data], 0, true));
    map.vision.update();
    expect(selectMovementAction(context, data, { x: 3, y: 1 }, [], [], () => 0)).toBeNull();
    expect(unit.getHidden()).toBe(true);
    expect(unit.hasMoved).toBe(false);
  });

  it('selects a legal mine field and performs the placement after moving', () => {
    const { map, game, player, unit, data, context } = fixture('DESTROYER', 'SEA');
    const ammo = unit.getAmmo2();
    const before = snapshot(game);
    const action = selectMovementAction(context, data, { x: 3, y: 1 }, [], [], count => count - 1);
    expect(action).toMatchObject({ actionId: 'ACTION_PLACE_WATERMINE', steps: [{ x: 3, y: 2 }] });
    expect(snapshot(game)).toEqual(before);
    expect(applyAction(game, action!)).toBe(true);
    expect(unit.x).toBe(3);
    expect(unit.getAmmo2()).toBe(ammo - 1);
    expect(map.getUnitAt(3, 2)?.getUnitID()).toBe('WATERMINE');
    expect(map.getUnitAt(3, 2)?.getOwner()).toBe(player);
  });
});
