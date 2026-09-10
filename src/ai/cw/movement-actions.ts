import type { ActionDescriptor } from '../actions.ts';
import type { BuildingHost } from '../../host/index.ts';
import { key } from '../../game/pathfinding.ts';
import { CwAction } from './actions.ts';
import type { Point } from './movement.ts';
import { calculateCounterDamage, type ScoringContext } from './scoring.ts';
import type { MoveUnitData } from './unitdata.ts';

/**
 * normalai.cpp:1190-1257: actions tried at the selected movement destination
 * after the first attack attempt and before the final attack/capture/wait pass.
 * Probing must not perform even a single-step action while the AI is deciding.
 */
export function selectMovementAction(
  context: ScoringContext, data: MoveUnitData, to: Point,
  buildings: readonly BuildingHost[], enemyBuildings: readonly BuildingHost[],
  randomIndex: (count: number) => number,
): ActionDescriptor | null {
  const game = context.ai.game;
  const unit = data.unit;
  const range = game.select(unit.x, unit.y);
  if (!range) return null;
  try {
    if (!range.tiles.get(key(to.x, to.y))?.canAct) return null;
    const offered = new Set(game.availableActions(unit, to).map(option => option.id));
    const descriptor = (actionId: string): ActionDescriptor => ({
      kind: 'unit', uid: unit.uid, actionId, to: { x: to.x, y: to.y },
    });
    const final = (actionId: string) => offered.has(actionId)
      && game.probeAction(actionId, unit, to).kind === 'done';

    // The source interleaves SUPPORTALL and BUILD in the unit's action-list order.
    for (const actionId of data.actions) {
      if ((actionId.startsWith(CwAction.SUPPORTALL) || actionId.startsWith(CwAction.BUILD))
          && final(actionId)) return descriptor(actionId);
    }
    if (data.actions.includes(CwAction.STEALTH) && final(CwAction.STEALTH)) {
      return descriptor(CwAction.STEALTH);
    }
    if (data.actions.includes(CwAction.UNSTEALTH) && final(CwAction.UNSTEALTH)
        && calculateCounterDamage(context, data, to, null, 0, buildings, enemyBuildings, true) <= 0) {
      return descriptor(CwAction.UNSTEALTH);
    }
    for (const actionId of data.actions) {
      if (!actionId.startsWith(CwAction.PLACE) || !offered.has(actionId)) continue;
      const step = game.probeAction(actionId, unit, to);
      if (step.kind !== 'field' || step.fields.length === 0) continue;
      const field = step.fields[randomIndex(step.fields.length)];
      if (!field) continue;
      return {
        kind: 'unit', uid: unit.uid, actionId, to: { x: to.x, y: to.y },
        steps: [{ x: field.x, y: field.y }],
      };
    }
    return null;
  } finally {
    game.clearSelection();
  }
}
