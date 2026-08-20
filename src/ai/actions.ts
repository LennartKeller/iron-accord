import type { Game } from '../game/game.ts';
import { actionableTiles } from '../game/pathfinding.ts';

/**
 * A move, described as plain data.
 *
 * Actions are serialisable and reference units by their stable `uid` rather
 * than by object, so a descriptor stays valid across a snapshot/restore cycle
 * and can be sent to a remote policy, logged to a replay, or used as a
 * reinforcement-learning action label.
 */
export type ActionDescriptor =
  | {
      kind: 'unit';
      /** Unit.uid of the acting unit. */
      uid: number;
      /** Commander Wars action id, e.g. ACTION_WAIT / ACTION_CAPTURE / ACTION_FIRE. */
      actionId: string;
      /** Tile the unit moves to before acting. */
      to: { x: number; y: number };
      /** Attack target, for ACTION_FIRE. */
      target?: { x: number; y: number };
      /**
       * Inputs for a multi-step action, consumed in order. A tile answers a
       * FIELD step, a string answers a MENU step. ACTION_MISSILE takes one tile;
       * the support family likewise.
       */
      steps?: Array<{ x: number; y: number } | string>;
    }
  | { kind: 'build'; at: { x: number; y: number }; unitId: string }
  | { kind: 'endTurn' };

export function actionKey(action: ActionDescriptor): string {
  switch (action.kind) {
    case 'unit':
      return `unit:${action.uid}:${action.actionId}:${action.to.x},${action.to.y}`
        + (action.target ? `:${action.target.x},${action.target.y}` : '')
        + (action.steps?.length
          ? ':' + action.steps.map(s => typeof s === 'string' ? s : `${s.x},${s.y}`).join('/')
          : '');
    case 'build':
      return `build:${action.at.x},${action.at.y}:${action.unitId}`;
    default:
      return 'endTurn';
  }
}

export interface EnumerateOptions {
  /** Cap destinations considered per unit; useful to bound a large branching factor. */
  maxDestinationsPerUnit?: number;
  /** Skip production entirely. */
  includeBuild?: boolean;
  /**
   * Cap the tiles enumerated for a multi-step FIELD choice. ACTION_MISSILE makes
   * the whole map selectable, which would otherwise dominate the branching
   * factor on a large map.
   */
  maxFieldChoices?: number;
}

/**
 * Every legal action for the player whose turn it is.
 *
 * Legality comes from the Commander Wars scripts: reachable tiles from the
 * pathfinder, then each action's own `canBePerformed` at that tile.
 */
export function enumerateActions(game: Game, options: EnumerateOptions = {}): ActionDescriptor[] {
  const actions: ActionDescriptor[] = [];
  if (game.over) return actions;

  const player = game.currentPlayer;

  for (const unit of [...player.units]) {
    if (unit.hasMoved) continue;
    const range = game.select(unit.x, unit.y);
    if (!range) continue;

    // actionableTiles, not stoppableTiles: a tile held by a friendly unit
    // cannot be stopped on but can be acted on, and that is precisely where
    // loading into a transport and joining a damaged unit happen. Enumerating
    // only stoppable tiles left the AI unable to board a transport at all —
    // ACTION_LOAD was never offered once in a whole match on an island map,
    // so its infantry never left the shore.
    let destinations = actionableTiles(range);
    const cap = options.maxDestinationsPerUnit;
    if (cap !== undefined && destinations.length > cap) {
      // Keep the cheapest moves; they include staying put.
      destinations = [...destinations].sort((a, b) => a.cost - b.cost).slice(0, cap);
    }

    for (const destination of destinations) {
      const at = { x: destination.x, y: destination.y };
      for (const available of game.availableActions(unit, at)) {
        if (available.id === 'ACTION_FIRE') {
          for (const target of game.attackTargets(unit, at)) {
            actions.push({
              kind: 'unit', uid: unit.uid, actionId: available.id, to: at,
              target: { x: target.x, y: target.y },
            });
          }
        } else {
          // Multi-step actions are enumerated with their first choice baked in;
          // anything deeper is left to a dedicated policy rather than exploded
          // combinatorially here.
          // probeAction, not beginAction: the latter performs a single-step
          // action on the spot, which would spend the unit during enumeration.
          const probe = game.probeAction(available.id, unit, at);
          if (probe.kind === 'field') {
            const cap = options.maxFieldChoices ?? 24;
            for (const field of probe.fields.slice(0, cap)) {
              actions.push({
                kind: 'unit', uid: unit.uid, actionId: available.id, to: at,
                steps: [{ x: field.x, y: field.y }],
              });
            }
          } else if (probe.kind === 'menu') {
            for (const entry of probe.entries) {
              actions.push({
                kind: 'unit', uid: unit.uid, actionId: available.id, to: at,
                steps: [entry.actionID],
              });
            }
          } else if (probe.kind === 'done') {
            // Nothing more to ask: a plain single-step action.
            actions.push({ kind: 'unit', uid: unit.uid, actionId: available.id, to: at });
          }
        }
      }
    }
  }
  game.clearSelection();

  if (options.includeBuild !== false) {
    for (let y = 0; y < game.map.height; y++) {
      for (let x = 0; x < game.map.width; x++) {
        if (!game.canProduceAt(x, y)) continue;
        const building = game.map.getTerrain(x, y).getBuilding()!;
        for (const option of game.buildOptions(building)) {
          if (option.affordable) actions.push({ kind: 'build', at: { x, y }, unitId: option.id });
        }
      }
    }
  }

  // Ending the turn is always available; it is how a turn terminates.
  actions.push({ kind: 'endTurn' });
  return actions;
}

/** Applies a descriptor. Returns false if it is no longer legal. */
export function applyAction(game: Game, action: ActionDescriptor): boolean {
  switch (action.kind) {
    case 'endTurn':
      game.endTurn();
      return true;

    case 'build':
      return game.buildUnit(action.at.x, action.at.y, action.unitId);

    case 'unit': {
      const unit = game.map.getUnitByUid(action.uid);
      if (!unit || unit.hasMoved || unit.getOwner() !== game.currentPlayer) return false;
      // select() populates the movement range the action is built against.
      if (!game.select(unit.x, unit.y)) return false;

      if (action.actionId === 'ACTION_FIRE') {
        if (!action.target) return false;
        return game.attack(unit, action.to, action.target);
      }

      if (action.steps && action.steps.length > 0) {
        let step = game.beginAction(action.actionId, unit, action.to);
        for (const input of action.steps) {
          if (step.kind === 'field' && typeof input !== 'string') step = game.provideField(input.x, input.y);
          else if (step.kind === 'menu' && typeof input === 'string') step = game.provideMenu(input);
          else break;
        }
        if (step.kind === 'done') return true;
        game.cancelAction();
        return false;
      }

      return game.performAction(action.actionId, unit, action.to);
    }
  }
}
