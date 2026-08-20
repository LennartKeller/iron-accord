import { computeMovementRange } from './pathfinding.ts';
import type { GameMap, Unit } from '../host/index.ts';

export interface ThreatenedTile {
  x: number;
  y: number;
  /** True where the unit can strike without moving first. */
  fromHere: boolean;
}

/**
 * Every tile a unit could attack on its next turn.
 *
 * Two cases, and the split is the engine's own: a unit that can move and fire
 * threatens everything within weapon range of anywhere it can stop, while an
 * indirect — artillery, rockets, a battleship — must already be in position, so
 * it only threatens the ring around the tile it stands on. `canMoveAndFire` is
 * a script call per unit type rather than a range test, so it is asked here
 * rather than inferred from the unit having range.
 *
 * Range is Manhattan distance between the unit's min and max range, matching
 * Unit::canAttackWithWeapon. Terrain does not block a shot in Advance Wars.
 */
export function threatenedTiles(map: GameMap, unit: Unit): ThreatenedTile[] {
  // Being armed is a weapon question, not a range one: every unit script sets a
  // range whether or not it has anything to fire, so an APC claims range 1.
  // Ammo counts too — a rocket launcher with none left threatens nothing.
  const usable = (unit.getWeapon1ID() !== '' && unit.hasAmmo1())
    || (unit.getWeapon2ID() !== '' && unit.hasAmmo2());
  if (!usable) return [];

  const minRange = unit.getMinRange();
  const maxRange = unit.getMaxRange();
  if (maxRange <= 0) return [];

  const origins = unit.canMoveAndFire()
    ? [...computeMovementRange(map, unit).tiles.values()].filter(tile => tile.canStop)
    : [{ x: unit.x, y: unit.y }];

  const found = new Map<number, ThreatenedTile>();
  for (const origin of origins) {
    for (let dy = -maxRange; dy <= maxRange; dy++) {
      for (let dx = -maxRange; dx <= maxRange; dx++) {
        const distance = Math.abs(dx) + Math.abs(dy);
        if (distance < minRange || distance > maxRange) continue;
        const x = origin.x + dx;
        const y = origin.y + dy;
        if (!map.onMap(x, y)) continue;

        const key = y * map.width + x;
        const fromHere = Math.abs(unit.x - x) + Math.abs(unit.y - y) >= minRange
          && Math.abs(unit.x - x) + Math.abs(unit.y - y) <= maxRange;
        const existing = found.get(key);
        if (existing) existing.fromHere ||= fromHere;
        else found.set(key, { x, y, fromHere });
      }
    }
  }
  return [...found.values()];
}
