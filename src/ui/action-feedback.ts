import type { Game } from '../game/game.ts';
import { computeMovementRange, pathTo } from '../game/pathfinding.ts';
import type { Unit } from '../host/unit.ts';
import type { LiveUnit } from '../render/renderer.ts';

type Point = { x: number; y: number };
export interface ActionFeedback {
  movement?: { uid: number; path: Point[]; unit: LiveUnit };
  effects: Array<Point & { text: string; color: string }>;
}

/** Capture only information already visible to the viewer, before rules execute. */
export function captureFeedback(game: Game, visible: LiveUnit[], mover: Unit | null, to: Point | null) {
  const units = visible.map(sprite => {
    const unit = sprite.uid === undefined ? null : game.map.getUnitByUid(sprite.uid);
    return { sprite, unit, hp: unit?.getHp() ?? 0 };
  });
  const moving = units.find(entry => entry.unit === mover);
  const route = moving && mover && to
    ? pathTo(computeMovementRange(game.map, mover), to.x, to.y).map(({ x, y }) => ({ x, y })) : [];
  const owner = to ? game.map.getTerrain(to.x, to.y)?.getBuilding()?.getOwnerID() : undefined;
  const capture = mover?.getCapturePoints() ?? 0;
  return (): ActionFeedback => {
    const effects: ActionFeedback['effects'] = [];
    let movement: ActionFeedback['movement'];
    if (moving && mover && to) {
      const last = route.findIndex(point => point.x === mover.x && point.y === mover.y);
      if (last > 0) movement = { uid: mover.uid, path: route.slice(0, last + 1), unit: moving.sprite };
      const trapped = mover.hasMoved && (mover.x !== to.x || mover.y !== to.y)
        && game.map.units.includes(mover);
      if (trapped) effects.push({ x: mover.x, y: mover.y, text: 'TRAP!', color: '#ffc857' });
      else if (owner !== undefined && game.map.getTerrain(to.x, to.y).getBuilding()?.getOwnerID() !== owner) {
        effects.push({ ...to, text: 'CAPTURED', color: '#85e5ac' });
      } else if (mover.getCapturePoints() > capture) {
        effects.push({ ...to, text: `CAPTURE ${mover.getCapturePoints()}/20`, color: '#85e5ac' });
      }
    }
    for (const { sprite, unit, hp } of units) {
      if (!unit || unit.getHp() >= hp) continue;
      const loss = Math.round((hp - Math.max(0, unit.getHp())) * 10) / 10;
      effects.push({ x: unit.x, y: unit.y, text: `−${loss} HP`, color: '#ff8a80' });
    }
    return { movement, effects };
  };
}
