import type { Game } from '../../game/game.ts';
import type { BuildingHost } from '../../host/index.ts';
import type { ActionDescriptor } from '../actions.ts';
import type { MenuEntry } from '../../host/stepdata.ts';

/** CoreAI::useBuilding: buildings act before the ordinary unit ladder. */
export function selectBuildingAction(
  game: Game, buildings: readonly BuildingHost[], randomIndex: (count: number) => number,
  chooseMenu?: (building: BuildingHost, actionId: string, entries: Omit<MenuEntry, 'icon'>[]) => string | null,
): ActionDescriptor | null {
  for (const building of buildings) {
    const at = { x: building.getX(), y: building.getY() };
    for (const actionId of building.getActionList()) {
      if (actionId === 'ACTION_BUILD_UNITS') continue;
      const steps: Array<{ x: number; y: number } | string> = [];
      for (let guard = 0; guard < 64; guard++) {
        const state = game.probeBuildingAction(at, actionId, steps);
        if (state.kind === 'done') return { kind: 'building', at, actionId, steps };
        if (state.kind === 'field') {
          if (!state.fields.length) break;
          // CoreAI::pickFallbackBuildingActionTarget uses the most valuable
          // occupant. Hidden occupants remain excluded by this host's boundary.
          let best: { x: number; y: number } | undefined;
          let bestValue = -Infinity;
          for (const point of state.fields) {
            const unit = game.map.getUnitAt(point.x, point.y);
            if (!unit || unit.isStealthed(game.currentPlayer)) continue;
            const value = Math.trunc(unit.getCoUnitValue());
            if (value > bestValue) { best = point; bestValue = value; }
          }
          steps.push(best ?? state.fields[randomIndex(state.fields.length)]);
        } else if (state.kind === 'menu') {
          if (!state.entries.length) break;
          const selection = chooseMenu
            ? chooseMenu(building, actionId, state.entries)
            : state.entries[randomIndex(state.entries.length)].actionID;
          if (selection === null || !state.entries.some(entry => entry.actionID === selection)) break;
          steps.push(selection);
        } else break;
      }
    }
  }
  return null;
}
