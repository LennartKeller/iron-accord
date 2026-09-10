import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Game } from '../src/game/game.ts';
import { restore, snapshot, withRollback } from '../src/game/snapshot.ts';
import { GameEnums } from '../src/host/index.ts';

const { registry, animations, createMap } = bootstrap();

function scenario(fog = GameEnums.Fog_OfWar) {
  const map = createMap(12, 3, 'PLAINS');
  const owner = map.addPlayer('os');
  const enemy = map.addPlayer('bm');
  const ally = map.addPlayer('ge');
  owner.team = ally.team = 0;
  enemy.team = 1;
  map.getGameRules().setFogMode(fog);
  map.addUnit('INFANTRY', owner, 0, 1);
  const hidden = map.addUnit('INFANTRY', enemy, 8, 1);
  hidden.hidden = true;
  map.setTerrainID(8, 1, 'FOREST');
  const game = new Game(map, registry, animations);
  return { map, owner, enemy, ally, hidden, game };
}

describe('temporary encounter vision', () => {
  it('reveals a concealed, status-stealthed occupant without an adjacent scout', () => {
    const { map, owner, enemy, ally, hidden } = scenario();
    expect(hidden.isStealthed(owner)).toBe(true);
    owner.addVisionField(8, 1, 1, true);
    expect(owner.getFieldVisible(8, 1)).toBe(true);
    expect(owner.getFieldDirectVisible(8, 1)).toBe(true);
    expect(hidden.isStealthed(owner)).toBe(false);
    expect(hidden.isStealthed(ally)).toBe(false);
    expect(enemy.getFieldDirectVisible(8, 1)).toBe(false);
    expect(owner.getFieldVisible(9, 1)).toBe(false);
    for (let i = 0; i < 3; i++) map.vision.update();
    expect(hidden.isStealthed(owner)).toBe(false);
    ally.expireVisionFields();
    map.vision.update();
    expect(hidden.isStealthed(ally)).toBe(false);
    owner.expireVisionFields();
    map.vision.update();
    expect(hidden.isStealthed(owner)).toBe(true);
    expect(hidden.isStealthed(ally)).toBe(true);
  });

  it('distinguishes normal clear vision from direct stealth detection', () => {
    const { owner, hidden } = scenario(GameEnums.Fog_Off);
    expect(owner.getFieldVisible(8, 1)).toBe(true);
    expect(owner.getFieldDirectVisible(8, 1)).toBe(false);
    owner.addVisionField(8, 1);
    expect(hidden.isStealthed(owner)).toBe(true);
    owner.addVisionField(8, 1, 1, true);
    expect(hidden.isStealthed(owner)).toBe(false);
  });

  it('preserves longer reveals and direct view when the same tile is revealed again', () => {
    const { map, owner, hidden } = scenario();
    owner.addVisionField(8, 1, 2, true);
    owner.addVisionField(8, 1, 1, false);
    owner.expireVisionFields();
    map.vision.update();
    expect(hidden.isStealthed(owner)).toBe(false);
    owner.expireVisionFields();
    map.vision.update();
    expect(hidden.isStealthed(owner)).toBe(true);
  });

  it('snapshots and rolls back encounter visibility and its remaining duration', () => {
    const { map, owner, game } = scenario();
    const unseen = snapshot(game);
    owner.addVisionField(8, 1, 2, true);
    const revealed = snapshot(game);
    withRollback(game, () => {
      owner.expireVisionFields();
      owner.expireVisionFields();
      owner.addVisionField(10, 1, 1, true);
      map.vision.update();
      expect(owner.getFieldDirectVisible(8, 1)).toBe(false);
    });
    expect(snapshot(game)).toEqual(revealed);
    expect(map.getUnitAt(8, 1)!.isStealthed(owner)).toBe(false);
    expect(owner.getFieldDirectVisible(10, 1)).toBe(false);
    restore(game, unseen);
    expect(map.getUnitAt(8, 1)!.isStealthed(owner)).toBe(true);
    restore(game, revealed);
    owner.expireVisionFields();
    map.vision.update();
    expect(map.getUnitAt(8, 1)!.isStealthed(owner)).toBe(false);
  });
});
