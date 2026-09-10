import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { GameEnums } from '../src/host/enums.ts';
import { unitVisibleToViewer } from '../src/render/visibility.ts';

const { createMap } = bootstrap();

function scenario(fog = GameEnums.Fog_Off) {
  const map = createMap(12, 5, 'SEA');
  const viewer = map.addPlayer('os');
  const enemy = map.addPlayer('bm');
  viewer.team = 0;
  enemy.team = 1;
  map.getGameRules().setFogMode(fog);
  const submarine = map.addUnit('SUBMARINE', enemy, 9, 2);
  submarine.hidden = true;
  map.vision.update();
  return { map, viewer, enemy, submarine };
}

describe('render and inspection visibility', () => {
  it('hides a dived enemy on a clear tile with fog disabled', () => {
    const { viewer, submarine } = scenario();
    expect(viewer.getFieldVisible(submarine.x, submarine.y)).toBe(true);
    expect(unitVisibleToViewer(submarine, viewer)).toBe(false);
  });

  it('shows a dived unit to its owner and an omniscient observer', () => {
    const { enemy, submarine } = scenario();
    expect(unitVisibleToViewer(submarine, enemy)).toBe(true);
    expect(unitVisibleToViewer(submarine, null)).toBe(true);
  });

  it('reveals a dived enemy when a viewer unit stands adjacent', () => {
    const { map, viewer, submarine } = scenario();
    map.addUnit('CRUISER', viewer, 8, 2);
    map.vision.update();
    expect(unitVisibleToViewer(submarine, viewer)).toBe(true);
  });

  it('keeps the viewing player visibility separate from the enemy owner', () => {
    const { viewer, enemy, submarine } = scenario(GameEnums.Fog_OfWar);
    submarine.hidden = false;
    expect(unitVisibleToViewer(submarine, viewer)).toBe(false);
    expect(unitVisibleToViewer(submarine, enemy)).toBe(true);
    expect(unitVisibleToViewer(submarine, null)).toBe(true);
  });
});
