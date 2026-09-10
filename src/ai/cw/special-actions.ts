import type { ActionDescriptor } from '../actions.ts';
import type { Unit } from '../../host/index.ts';
import { RocketTarget_Money } from '../../host/player.ts';
import { getCircle } from '../../host/globals.ts';
import { CwAction } from './actions.ts';
import type { CoreAI } from './coreai.ts';
import { TargetedUnitPathFindingSystem } from './targetedpfs.ts';
import { getClosestReachableMovePath, type Point } from './movement.ts';
import type { MoveTargetField } from './targets.ts';

type RandomIndex = (count: number) => number;
const position = (unit: Unit): Point => ({ x: unit.x, y: unit.y });
const descriptor = (unit: Unit, actionId: string, to: Point, field?: Point): ActionDescriptor => ({
  kind: 'unit', uid: unit.uid, actionId, to: { ...to }, ...(field ? { steps: [{ ...field }] } : {}),
});

/** CoreAI::moveFlares. Visibility-safe exception: score fogged area, not hidden enemy locations. */
export function moveFlares(ai: CoreAI, units: readonly Unit[], randomIndex: RandomIndex): ActionDescriptor | null {
  const script = ai.map.registry.ACTION_FLARE;
  const unfogRange = script?.getUnfogRange?.() ?? 2;
  for (const unit of units) {
    if (unit.getHasMoved() || !unit.hasAction(CwAction.FLARE)) continue;
    const range = ai.game.select(unit.x, unit.y);
    if (!range) continue;
    try {
      let bestScore = 0;
      let best: ActionDescriptor | null = null;
      // Native range enumeration is x-major. The hosted action currently allows
      // stationary flares only, but use its field step rather than assuming that.
      const positions = [...range.tiles.values()].sort((a, b) => a.x - b.x || a.y - b.y);
      for (const from of positions) {
        if (!from.canAct) continue;
        const step = ai.game.probeAction(CwAction.FLARE, unit, from);
        if (step.kind !== 'field') continue;
        for (const target of step.fields) {
          let score = 0;
          for (const offset of getCircle(0, unfogRange)) {
            const x = target.x + offset.x, y = target.y + offset.y;
            if (ai.map.onMap(x, y) && !ai.player.getFieldVisible(x, y)) score++;
          }
          if (score > bestScore || (score > 0 && score === bestScore && randomIndex(11) > 5)) {
            bestScore = score;
            best = descriptor(unit, CwAction.FLARE, { x: from.x, y: from.y }, target);
          }
        }
      }
      if (best !== null) return best;
    } finally { ai.game.clearSelection(); }
  }
  return null;
}

function advance(ai: CoreAI, unit: Unit, targets: MoveTargetField[], actionId: string): ActionDescriptor | null {
  if (!targets.length) return null;
  const search = new TargetedUnitPathFindingSystem(ai.map, unit, targets, { moveCostMap: ai.moveCostMap });
  const points = unit.getMovementpoints(position(unit));
  const target = search.getReachableTargetField(points);
  if (target.x < 0) return null;
  const range = ai.game.select(unit.x, unit.y);
  if (!range) return null;
  try {
    const path = getClosestReachableMovePath(ai, unit, range, target, points);
    if (!path.length) return null;
    const to = path[0];
    if (!to.canAct) return null;
    if (ai.game.probeAction(actionId, unit, to).kind !== 'done') return null;
    return descriptor(unit, actionId, { x: to.x, y: to.y });
  } finally { ai.game.clearSelection(); }
}

/** CoreAI::moveOoziums: pursue enemies using the unit's consuming wait action. */
export function moveOoziums(ai: CoreAI, units: readonly Unit[], enemies: readonly Unit[]): ActionDescriptor | null {
  const targets = enemies.filter(unit => !unit.isStealthed(ai.player))
    .map(unit => ({ x: unit.x, y: unit.y, z: 1 }));
  for (const unit of units) {
    if (unit.getHasMoved() || !unit.hasAction(CwAction.HOELLIUM_WAIT)) continue;
    const action = advance(ai, unit, targets, CwAction.HOELLIUM_WAIT);
    if (action) return action;
  }
  return null;
}

/** CoreAI::moveBlackBombs: maximize net blast value, otherwise approach an enemy. */
export function moveBlackBombs(
  ai: CoreAI, units: readonly Unit[], enemies: readonly Unit[], randomIndex: RandomIndex,
): ActionDescriptor | null {
  const targets = new Map<string, MoveTargetField>();
  for (const enemy of enemies) {
    if (enemy.isStealthed(ai.player)) continue;
    for (const offset of getCircle(1, 1)) {
      const x = enemy.x + offset.x, y = enemy.y + offset.y;
      if (ai.map.onMap(x, y)) targets.set(`${x},${y}`, { x, y, z: 1 });
    }
  }
  const script = ai.map.registry.ACTION_EXPLODE;
  const blast = getCircle(1, script?.getRange?.() ?? 2);
  const damage = script?.getDamage?.() ?? 4;
  for (const unit of units) {
    if (unit.getHasMoved() || !unit.hasAction(CwAction.EXPLODE)) continue;
    const range = ai.game.select(unit.x, unit.y);
    if (!range) continue;
    try {
      let maxDamage = 0;
      const best: Point[] = [];
      for (const to of [...range.tiles.values()].sort((a, b) => a.x - b.x || a.y - b.y)) {
        if (!to.canAct) continue;
        if (ai.game.probeAction(CwAction.EXPLODE, unit, to).kind !== 'field') continue;
        // Unlike native ignoreStealthed=true, hidden enemies cannot influence a
        // decision. Allies retain the upstream 1.2 loss multiplier.
        const score = ai.player.getRocketTargetDamage(to.x, to.y, blast, damage, 1.2, RocketTarget_Money, false);
        if (score > maxDamage) { best.length = 0; maxDamage = score; }
        if (score > 0 && score === maxDamage) best.push({ x: to.x, y: to.y });
      }
      if (best.length) {
        const to = best[randomIndex(best.length)];
        return descriptor(unit, CwAction.EXPLODE, to, to);
      }
      const action = advance(ai, unit, [...targets.values()], CwAction.WAIT);
      if (action) return action;
    } finally { ai.game.clearSelection(); }
  }
  return null;
}
