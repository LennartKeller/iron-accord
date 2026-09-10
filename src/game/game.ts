import { ANIMATION_RUNNER_KEY } from '../host/animation.ts';
import { GameAction, GameEnums, type GameMap, type Unit, type Player, type Building, type AnimationRunner } from '../host/index.ts';
import type { ScriptRegistry } from '../scripts/types.ts';
import { computeMovementRange, pathTo, key, type MovementRange, type ReachableTile } from './pathfinding.ts';

/**
 * Turn state and the actions a player can take.
 *
 * Deliberately thin: it owns whose turn it is and what each unit has already
 * done, and delegates every rule it can to the Commander Wars scripts through
 * the host objects.
 */

export interface MoveResult {
  moved: boolean;
  path: ReachableTile[];
  cost: number;
  reason?: 'not-your-unit' | 'already-moved' | 'unreachable' | 'occupied';
}

/** Where a multi-step action has got to. */
export type ActionStep =
  | { kind: 'done' }
  | { kind: 'invalid' }
  | { kind: 'field'; fields: Array<{ x: number; y: number }> }
  | { kind: 'menu'; entries: Array<{ text: string; actionID: string; cost: number; enabled: boolean }> };

/** One entry in the unit action menu. */
export interface ActionOption {
  id: string;
  label: string;
  icon: string;
}

export interface GameOptions {
  /** Victory rule values by rule id; anything omitted keeps the script default. */
  victoryRules?: Record<string, number[]>;
}

export type GameOverReason = 'hq-captured' | 'no-units' | 'rule';

/** Kept for the two conditions the UI and tests name directly. */
const REASON_BY_RULE: Record<string, GameOverReason> = {
  VICTORYRULE_NOHQ: 'hq-captured',
  VICTORYRULE_NOUNITS: 'no-units',
};

export interface GameOver {
  /** A surviving player; with teams, one representative of the winning side. */
  winner: number;
  winningTeam: number;
  /** The victory rule that ended it, for naming it in the UI. */
  ruleID: string | null;
  reason: GameOverReason;
}

export class Game {
  readonly map: GameMap;
  readonly registry: ScriptRegistry;
  readonly animations: AnimationRunner | null;
  currentPlayerIndex = 0;
  over: GameOver | null = null;

  /**
   * The day, read straight off the map. The scripts ask the map for it
   * (map.getCurrentDay), so keeping a second copy on Game would leave every
   * day-based victory rule — turn limits, capture and score races — frozen on
   * day one.
   */
  get day(): number { return this.map.currentDay; }
  set day(value: number) { this.map.currentDay = value; }

  /** The unit currently picked up, and where it can go. */
  selected: Unit | null = null;
  range: MovementRange | null = null;
  /** Where a picked-up unit is being moved to, before its action is chosen. */
  pendingDestination: { x: number; y: number } | null = null;

  constructor(
    map: GameMap,
    registry: ScriptRegistry,
    animations: AnimationRunner | null = null,
    options: GameOptions = {},
  ) {
    this.map = map;
    this.registry = registry;
    // Falling back to the runner the scripts are already attached to: an
    // omitted argument used to mean capture never completed and matches ended
    // on day two, with nothing logged. Pass one explicitly to override.
    this.animations = animations
      ?? ((registry as Record<string, unknown>)[ANIMATION_RUNNER_KEY] as AnimationRunner | undefined)
      ?? null;
    // A new game starts at the top of day one whatever the map was saved at,
    // matching the seat reset above. Rules that read the day must see 1.
    this.map.currentPlayerIndex = 0;
    this.day = 1;
    this.map.vision.update();

    // objects/ruleselection.cpp then GameRules::onGameStart: build every rule
    // the scripts define — each one seeds its own state from the starting
    // position — then drop the ones that are switched off.
    const rules = this.map.getGameRules();
    rules.attach(this.map, registry);
    rules.createDefaultVictoryRules();
    for (const [ruleID, values] of Object.entries(options.victoryRules ?? {})) {
      values.forEach((value, item) => rules.getVictoryRule(ruleID)?.setRuleValue(value, item));
    }
    rules.onGameStart();

    this.beginTurn(this.currentPlayer);
    this.map.vision.update();
  }

  get currentPlayer(): Player {
    return this.map.players[this.currentPlayerIndex];
  }

  // --- actions ------------------------------------------------------------

  /**
   * Builds a GameAction the way the engine does: the unit, where it came from,
   * and the path it would take. Action scripts read all of that.
   */
  private buildAction(actionID: string, unit: Unit, destination: { x: number; y: number },
                      range: MovementRange | null = this.range): GameAction {
    const action = new GameAction(this.map, actionID);
    action.setTargetUnit(unit);
    action.setTarget({ x: unit.x, y: unit.y });
    const route = range ? pathTo(range, destination.x, destination.y) : [];
    const points = route.length > 0
      ? route.map(tile => ({ x: tile.x, y: tile.y }))
      : [{ x: destination.x, y: destination.y }];
    action.setMovepath(points, route.at(-1)?.cost ?? 0);
    return action;
  }

  /** Validate at the execution boundary, including calls made without UI selection. */
  private prepareAction(actionID: string, unit: Unit, destination: { x: number; y: number }): GameAction | null {
    if (!this.canControl(unit) || !unit.getActionList().includes(actionID)
        || !Number.isInteger(destination.x) || !Number.isInteger(destination.y)
        || !this.map.onMap(destination.x, destination.y)) return null;
    const range = computeMovementRange(this.map, unit);
    if (!range.tiles.get(key(destination.x, destination.y))?.canAct) return null;
    const action = this.buildAction(actionID, unit, destination, range);
    try { return action.canBePerformed() ? action : null; }
    catch (error) { console.warn(`canBePerformed ${actionID} failed`, error); return null; }
  }

  /**
   * The menu for a unit at a destination: every action its script offers whose
   * `canBePerformed` agrees, asked of the Commander Wars scripts directly.
   */
  availableActions(unit: Unit, destination: { x: number; y: number }): ActionOption[] {
    const options: ActionOption[] = [];
    for (const actionID of unit.getActionList()) {
      const script = this.registry[actionID];
      if (!script?.canBePerformed) continue;
      const action = this.buildAction(actionID, unit, destination);
      let allowed = false;
      try { allowed = script.canBePerformed(action, this.map) === true; }
      // Still treated as not-allowed, but never silently: a throw here would
      // otherwise delete the action from the menu and the AI's enumeration
      // with no signal at all.
      catch (error) { console.warn(`canBePerformed ${actionID} failed`, error); }
      if (!allowed) continue;
      options.push({
        id: actionID,
        label: safeCall(() => script.getActionText?.(this.map)) ?? prettify(actionID),
        icon: safeCall(() => script.getIcon?.(this.map)) ?? '',
      });
    }
    return options;
  }

  /**
   * Runs an action script. The script moves the unit, applies its effect and
   * marks the unit done; queued end-of-animation callbacks are then flushed,
   * which is where capture and combat actually resolve.
   */
  performAction(actionID: string, unit: Unit, destination: { x: number; y: number },
                configure?: (action: GameAction) => void): boolean {
    if (this.over) return false;               // a decided game is read-only
    const script = this.registry[actionID];
    if (!script?.perform) return false;
    const action = this.prepareAction(actionID, unit, destination);
    if (!action) return false;
    configure?.(action);

    return this.runPrepared(action, unit, destination);
  }

  /** Reconstruct a building order without applying any of its effects. */
  private prepareBuildingAction(
    at: { x: number; y: number }, actionID: string,
    inputs: ReadonlyArray<{ x: number; y: number } | string>,
  ): GameAction | null {
    if (this.over || !Number.isInteger(at.x) || !Number.isInteger(at.y) || !this.map.onMap(at.x, at.y)) return null;
    const building = this.map.getTerrain(at.x, at.y).getBuilding();
    if (!building || building.getOwner() !== this.currentPlayer || actionID === 'ACTION_BUILD_UNITS'
      || !building.getActionList().includes(actionID)) return null;
    const action = new GameAction(this.map, actionID);
    action.setTarget(at);
    try {
      if (!action.canBePerformed()) return null;
      for (const input of inputs) {
        const step = this.stepState(action);
        if (step.kind === 'field' && typeof input !== 'string'
          && step.fields.some(point => point.x === input.x && point.y === input.y)) {
          action.writeDataInt32(input.x);
          action.writeDataInt32(input.y);
        } else if (step.kind === 'menu' && typeof input === 'string') {
          const entry = step.entries.find(entry => entry.actionID === input);
          if (!entry) return null;
          action.writeDataString(input);
          action.setCosts(action.getCosts() + entry.cost);
        } else return null;
        action.setInputStep(action.getInputStep() + 1);
      }
      return action;
    } catch { return null; }
  }

  probeBuildingAction(at: { x: number; y: number }, actionID: string,
    inputs: ReadonlyArray<{ x: number; y: number } | string> = []): ActionStep {
    const action = this.prepareBuildingAction(at, actionID, inputs);
    return action ? this.stepState(action) : { kind: 'invalid' };
  }

  /** Validate every menu/field choice before committing a building action. */
  performBuildingAction(at: { x: number; y: number }, actionID: string,
    inputs: ReadonlyArray<{ x: number; y: number } | string> = []): boolean {
    const action = this.prepareBuildingAction(at, actionID, inputs);
    if (!action || !action.isFinalStep() || !action.canBePerformed()) return false;
    return this.runPrepared(action, null, at);
  }

  // --- multi-step actions -------------------------------------------------

  /** An action mid-way through collecting its inputs. */
  pending: { action: GameAction; unit: Unit; destination: { x: number; y: number }; state?: ActionStep } | null = null;

  /**
   * What the driver needs next: a tile, a menu choice, or nothing (the action
   * has been performed).
   */
  private stepState(action: GameAction): ActionStep {
    // Order matters and both calls are side-effecting: ACTION_UNLOAD writes to
    // the buffer and advances the step from inside them.
    if (action.isFinalStep()) return { kind: 'done' };

    const type = action.getStepInputType();
    if (type === 'FIELD') {
      const data = action.getMarkedFieldStepData();
      const points = data.getPoints().map(p => ({ x: p.x, y: p.y }));
      if (data.getAllFields() && points.length === 0) {
        // setAllFields(true) means every on-map tile is selectable.
        for (let y = 0; y < this.map.height; y++) {
          for (let x = 0; x < this.map.width; x++) points.push({ x, y });
        }
      }
      return { kind: 'field', fields: points };
    }
    if (type === 'MENU') {
      const data = action.getMenuStepData();
      if (!data.validData()) return { kind: 'invalid' };
      return { kind: 'menu', entries: data.getEntries().filter(entry => entry.enabled) };
    }
    return { kind: 'invalid' };
  }

  /**
   * What an action would ask for, WITHOUT performing it.
   *
   * Enumeration must not mutate the game — `beginAction` performs single-step
   * actions immediately, which would spend the unit just for being considered.
   * The side effects of `isFinalStep` / `getStepInputType` land on the throwaway
   * GameAction, not on the board.
   */
  probeAction(actionID: string, unit: Unit, destination: { x: number; y: number }): ActionStep {
    const action = this.buildAction(actionID, unit, destination);
    if (!action.canBePerformed()) return { kind: 'invalid' };
    return this.stepState(action);
  }

  /**
   * Starts an action, collecting inputs step by step. Single-step actions
   * complete immediately and report 'done'.
   */
  beginAction(actionID: string, unit: Unit, destination: { x: number; y: number }): ActionStep {
    if (this.over) return { kind: 'invalid' }; // a decided game is read-only
    const action = this.prepareAction(actionID, unit, destination);
    if (!action) return { kind: 'invalid' };
    this.pending = { action, unit, destination };
    return this.advance();
  }

  /** Supplies a chosen tile for a FIELD step. */
  provideField(x: number, y: number): ActionStep {
    if (!this.pending || !this.canControl(this.pending.unit)) return { kind: 'invalid' };
    const state = this.pending.state;
    if (state?.kind !== 'field' || !state.fields.some(field => field.x === x && field.y === y)) {
      return { kind: 'invalid' };
    }
    this.pending.action.writeDataInt32(x);
    this.pending.action.writeDataInt32(y);
    this.pending.action.setInputStep(this.pending.action.getInputStep() + 1);
    return this.advance();
  }

  /** Supplies a chosen menu entry. */
  provideMenu(actionID: string, _cost = 0): ActionStep {
    if (!this.pending || !this.canControl(this.pending.unit)) return { kind: 'invalid' };
    const state = this.pending.state;
    const entry = state?.kind === 'menu' ? state.entries.find(entry => entry.actionID === actionID) : undefined;
    if (!entry) return { kind: 'invalid' };
    const action = this.pending.action;
    action.writeDataString(actionID);
    action.setCosts(action.getCosts() + entry.cost);
    action.setInputStep(action.getInputStep() + 1);
    return this.advance();
  }

  /** Throws away a partially-entered action; there is no single-step undo. */
  cancelAction(): void { this.pending = null; }

  /** Runs the collected action once no more input is needed. */
  private advance(): ActionStep {
    if (!this.pending) return { kind: 'invalid' };
    const { action, unit, destination } = this.pending;

    // Bounded: a script with no isFinalStep override would otherwise spin.
    for (let guard = 0; guard < 64; guard++) {
      const state = this.stepState(action);
      if (state.kind !== 'done') {
        this.pending.state = state;
        return state;
      }

      this.pending = null;
      const performed = this.runPrepared(action, unit, destination);
      return performed ? { kind: 'done' } : { kind: 'invalid' };
    }
    this.pending = null;
    return { kind: 'invalid' };
  }

  /** Replace the planned action with CW's trap action at the first collision. */
  private trapAction(action: GameAction): GameAction | null {
    const unit = action.getTargetUnit();
    const path = action.getMovePath();
    if (!unit || path.length < 2) return null;
    const costs = [0];
    for (let i = 1; i < path.length; i++) {
      const point = path[i];
      const previous = path[i - 1];
      const occupant = this.map.getUnitAt(point.x, point.y);
      const step = unit.getMovementCosts(point.x, point.y, previous.x, previous.y);
      // Oozium's own wait action consumes a visible enemy on its destination.
      // Hidden collisions still trap instead of revealing a target to planning.
      const consumesEnemy = i === path.length - 1 && action.getActionID() === 'ACTION_HOELLIUM_WAIT'
        && unit.getIgnoreUnitCollision() && occupant && !occupant.isStealthed(unit.getOwner());
      const collision = occupant && occupant !== unit && unit.getOwner().isEnemyUnit(occupant)
        && !consumesEnemy && (!unit.getIgnoreUnitCollision() || i === path.length - 1);
      if (collision || step < 0) {
        // A preceding ally or zero-cost transit tile is not a legal stopping
        // place. Back up to the last empty, occupiable tile (or the origin).
        let stop = i - 1;
        while (stop > 0) {
          const at = path[stop];
          const before = path[stop - 1];
          if (!this.map.getUnitAt(at.x, at.y)
              && unit.getMovementCosts(at.x, at.y, before.x, before.y) > 0) break;
          stop--;
        }
        const trap = new GameAction(this.map, 'ACTION_TRAP');
        trap.setTargetUnit(unit);
        trap.setTarget(action.getTarget());
        trap.setMovepath(path.slice(0, stop + 1), costs[stop]);
        trap.writeDataInt32(point.x);
        trap.writeDataInt32(point.y);
        return trap;
      }
      costs.push(costs[i - 1] + step);
    }
    return null;
  }

  /** Performs an action whose inputs are already in its buffer. */
  private runPrepared(action: GameAction, _unit: Unit | null, _destination: { x: number; y: number }): boolean {
    action = this.trapAction(action) ?? action;
    const script = this.registry[action.getActionID()];
    if (!script?.perform) return false;
    if (action.getActionID() === 'ACTION_TRAP') {
      action.startReading();
      this.currentPlayer.addVisionField(action.readDataInt32(), action.readDataInt32(), 1, true);
    }
    try {
      script.perform(action, this.map);
    } catch (error) {
      console.warn(`action ${action.getActionID()} failed`, error);
      return false;
    }
    this.animations?.flush(this.map);
    this.cleanupDead();
    this.clearSelection();
    this.map.vision.update();
    this.checkGameOver();
    return true;
  }

  // --- transport ----------------------------------------------------------

  /** Units a transport is carrying, with their index. */
  cargoOf(transport: Unit): Array<{ index: number; unit: Unit }> {
    return transport.loaded.map((unit, index) => ({ index, unit }));
  }

  /**
   * Script-defined drop fields at the transport's planned destination.
   * A throwaway action preserves the original cargo indexes and lets the script
   * treat the transport's origin as vacated without moving anything on the board.
   * Hidden occupants remain apparent drop options; execution still requires an
   * empty tile, just like ACTION_UNLOAD.performPostAnimation.
   */
  unloadTargets(
    transport: Unit, cargoIndex: number,
    at: { x: number; y: number } = transport,
  ): Array<{ x: number; y: number }> {
    if (!Number.isInteger(cargoIndex) || !transport.loaded[cargoIndex]
      || !Number.isInteger(at.x) || !Number.isInteger(at.y) || !this.map.onMap(at.x, at.y)) return [];
    const action = new GameAction(this.map, 'ACTION_UNLOAD');
    action.setTargetUnit(transport);
    action.setMovepath([{ x: at.x, y: at.y }], 0);
    const fields = this.registry.ACTION_UNLOAD?.getUnloadFields?.(action, cargoIndex, this.map);
    return Array.isArray(fields) ? fields.map(field => ({ x: field.x, y: field.y })) : [];
  }

  /**
   * Moves a transport to its destination without ending its turn, so it can
   * unload afterwards. Advance Wars lets a transport move and then drop cargo;
   * the fuel is charged for the move exactly as a normal move would.
   */
  moveForUnload(transport: Unit, x: number, y: number): boolean {
    if (!this.canControl(transport)) return false;
    if (transport.x === x && transport.y === y) return true;
    if (this.unloadOrigin) return false;
    const range = computeMovementRange(this.map, transport);
    const tile = range.tiles.get(key(x, y));
    if (!tile || !tile.canStop) return false;
    const action = this.buildAction('ACTION_WAIT', transport, { x, y }, range);
    const trap = this.trapAction(action);
    if (trap) {
      this.runPrepared(trap, transport, { x, y });
      return false; // the unload is interrupted; this move cannot be cancelled
    }
    // Remember where it came from: until a drop commits the unload, the move
    // is provisional. Without this a cancelled unload leaves the transport at
    // its destination, still unspent — free extra moves, once per cancel.
    this.unloadOrigin = { unit: transport, x: transport.x, y: transport.y, fuel: transport.fuel };
    transport.fuel = Math.max(0, transport.fuel - tile.cost);
    transport.moveUnitToField(x, y);
    this.map.vision.update();
    return true;
  }

  /** A transport relocated by moveForUnload, until a drop commits the move. */
  private unloadOrigin: { unit: Unit; x: number; y: number; fuel: number } | null = null;

  /**
   * Abandons an unload after moveForUnload: the transport returns to where it
   * stood, fuel included — in Commander Wars a cancelled multi-step action
   * never happened. Returns whether anything was put back, so the UI knows to
   * redraw. A bare x/y write is right here: this is an undo, not a move, and
   * the forward moveUnitToField already cleared any capture points.
   */
  cancelUnloadMove(): boolean {
    const origin = this.unloadOrigin;
    this.unloadOrigin = null;
    if (!origin || origin.unit.hasMoved) return false;
    origin.unit.x = origin.x;
    origin.unit.y = origin.y;
    origin.unit.fuel = origin.fuel;
    this.map.vision.update();
    return true;
  }

  /** Drops a carried unit onto a tile. The unit is spent for the turn. */
  unloadUnit(transport: Unit, cargoIndex: number, x: number, y: number): boolean {
    if (!this.canControl(transport)) return false;
    const cargo = transport.loaded[cargoIndex];
    if (!cargo) return false;
    if (this.map.getUnitAt(x, y)
      || !this.unloadTargets(transport, cargoIndex).some(t => t.x === x && t.y === y)) return false;

    transport.unloadUnit(cargo, { x, y });
    transport.hasMoved = true;
    // The drop commits the transport's move; it must not snap back now.
    this.unloadOrigin = null;
    this.map.vision.update();
    return true;
  }

  /** Transports on this tile that could take the given unit. */
  transportAt(x: number, y: number, unit: Unit): Unit | null {
    const occupant = this.map.getUnitAt(x, y);
    return occupant && occupant.canLoad(unit) ? occupant : null;
  }

  // --- production ---------------------------------------------------------

  /** What a building can build for the current player, with prices. */
  buildOptions(building: Building): Array<{ id: string; cost: number; affordable: boolean }> {
    const player = building.getOwner();
    if (!player) return [];
    return building.getConstructionList().map(unitID => {
      const script = this.registry[unitID];
      const cost = Number(safeCall(() => script?.getBaseCost?.(null, this.map)) ?? 0);
      return { id: unitID, cost, affordable: player.funds >= cost };
    });
  }

  /** True when this tile can start production for the current player. */
  canProduceAt(x: number, y: number): boolean {
    if (this.over) return false;               // a decided game is read-only
    if (!Number.isInteger(x) || !Number.isInteger(y) || !this.map.onMap(x, y)) return false;
    const building = this.map.getTerrain(x, y).getBuilding();
    if (!building || building.getOwner() !== this.currentPlayer) return false;
    if (this.map.getUnitAt(x, y)) return false;
    // The building's action list is the gate, not its construction list.
    if (!building.canBuildUnits() || building.getConstructionList().length === 0) return false;
    // ACTION_BUILD_UNITS refuses production once the owner is at the cap.
    const limit = this.map.getGameRules().getUnitLimit();
    return limit <= 0 || this.currentPlayer.units.length < limit;
  }

  /**
   * Builds a unit through ACTION_BUILD_UNITS. The action carries the chosen unit
   * id and its cost; the script spawns it, charges the player and marks it spent.
   */
  buildUnit(x: number, y: number, unitID: string): boolean {
    if (this.over) return false;               // a decided game is read-only
    if (!Number.isInteger(x) || !Number.isInteger(y) || !this.map.onMap(x, y)) return false;
    const building = this.map.getTerrain(x, y).getBuilding();
    const player = building?.getOwner();
    if (!building || player !== this.currentPlayer) return false;
    // Gate here as well as in canProduceAt: the UI is not the only caller.
    if (!building.canBuildUnits()) return false;
    if (this.map.getUnitAt(x, y)) return false;
    const limit = this.map.getGameRules().getUnitLimit();
    if (limit > 0 && player.units.length >= limit) return false;

    const option = this.buildOptions(building).find(entry => entry.id === unitID);
    if (!option || !option.affordable) return false;

    const script = this.registry.ACTION_BUILD_UNITS;
    if (!script?.perform) return false;

    const action = new GameAction(this.map, 'ACTION_BUILD_UNITS');
    action.setTarget({ x, y });
    action.setInputStep(1);
    action.setCosts(option.cost);
    action.writeDataString(unitID);

    try {
      script.perform(action, this.map);
    } catch (error) {
      console.warn('ACTION_BUILD_UNITS failed', error);
      return false;
    }
    this.animations?.flush(this.map);
    this.map.vision.update();
    return true;
  }

  // --- combat -------------------------------------------------------------

  /**
   * Tiles the unit could attack from a given position.
   *
   * Units are not the only targets: ACTION_FIRE also hits enemy buildings with
   * HP and destructible terrain (pipes, walls, gates), using the weapon's
   * `getEnviromentDamage`. Skipping those made every pipe indestructible, which
   * makes maps built around breaching one unwinnable.
   */
  attackTargets(
    unit: Unit, from: { x: number; y: number },
  ): Array<{ x: number; y: number; unit: Unit | null; kind: 'unit' | 'building' | 'terrain' }> {
    const targets: Array<{ x: number; y: number; unit: Unit | null; kind: 'unit' | 'building' | 'terrain' }> = [];
    const min = unit.getMinRange();
    const max = unit.getMaxRange();

    for (let dy = -max; dy <= max; dy++) {
      for (let dx = -max; dx <= max; dx++) {
        const distance = Math.abs(dx) + Math.abs(dy);
        if (distance < min || distance > max) continue;
        const x = from.x + dx;
        const y = from.y + dy;
        if (!this.map.onMap(x, y)) continue;

        const defender = this.map.getUnitAt(x, y);
        if (defender && defender !== unit) {
          if (unit.isAttackable(defender, false, { x: from.x, y: from.y })) {
            targets.push({ x, y, unit: defender, kind: 'unit' });
          }
          continue;
        }
        if (defender === unit) continue;

        // An empty tile can still be a target if something on it has HP.
        const terrain = this.map.getTerrain(x, y);
        const building = terrain.getBuilding();
        if (building && building.getHp() > 0 && unit.getOwner().isEnemy(building.getOwner())) {
          if (this.environmentDamage(unit, terrain.getID()) > 0) {
            targets.push({ x, y, unit: null, kind: 'building' });
          }
          continue;
        }
        if (terrain.getHp() > 0 && this.environmentDamage(unit, terrain.getID()) > 0) {
          targets.push({ x, y, unit: null, kind: 'terrain' });
        }
      }
    }
    return targets;
  }

  /** Damage this unit's weapons do to a structure, from the weapon scripts. */
  private environmentDamage(unit: Unit, environmentId: string): number {
    let best = 0;
    for (const [index, weaponID] of [[0, unit.getWeapon1ID()], [1, unit.getWeapon2ID()]] as Array<[number, string]>) {
      if (!weaponID) continue;
      if (index === 0 && !unit.hasAmmo1()) continue;
      if (index === 1 && !unit.hasAmmo2()) continue;
      const damage = safeCall(() => this.registry[weaponID]?.getEnviromentDamage?.(environmentId));
      if (typeof damage === 'number' && damage > best) best = damage;
    }
    return best;
  }

  /**
   * Damage preview for a prospective attack, using ACTION_FIRE.calcBattleDamage.
   * Returns attacker and counter damage as HP percentages.
   */
  previewBattle(unit: Unit, from: { x: number; y: number }, target: { x: number; y: number }):
      { attacker: number; defender: number } | null {
    const action = this.buildAction('ACTION_FIRE', unit, from);
    const result = safeCall(() => this.registry.ACTION_FIRE?.calcBattleDamage(
      this.map, action, target.x, target.y, GameEnums.LuckDamageMode_Average));
    if (!result) return null;
    return { attacker: Math.max(0, result.x), defender: Math.max(0, result.width) };
  }

  /**
   * Attacks a tile. ACTION_FIRE expects the battle to be resolved up front and
   * the numbers written into the action, which is what the engine does too.
   */
  attack(unit: Unit, from: { x: number; y: number }, target: { x: number; y: number }): boolean {
    const action = this.prepareAction('ACTION_FIRE', unit, from);
    if (!action || !this.attackTargets(unit, from).some(tile => tile.x === target.x && tile.y === target.y)) return false;
    const trap = this.trapAction(action);
    if (trap) return this.runPrepared(trap, unit, from);
    const result = safeCall(() => this.registry.ACTION_FIRE?.calcBattleDamage(
      this.map, action, target.x, target.y, GameEnums.LuckDamageMode_On));
    if (!result) return false;

    return this.performAction('ACTION_FIRE', unit, from, prepared => {
      prepared.writeDataInt32(target.x);
      prepared.writeDataInt32(target.y);
      // GameAction::writeDataInt32 truncates toward zero; rounding would
      // occasionally turn a 59.6 roll into a kill that Commander Wars would not.
      prepared.writeDataInt32(Math.trunc(result.x));
      prepared.writeDataInt32(Math.trunc(result.y));
      prepared.writeDataInt32(Math.trunc(result.width));
      prepared.writeDataInt32(Math.trunc(result.height));
    });
  }

  /** Units reduced to zero HP leave the board, running their death hooks. */
  cleanupDead(): void {
    for (const unit of [...this.map.units]) {
      if (unit.getHp() > 0) continue;
      unit.onDeath();
      this.map.removeUnit(unit);
    }
  }

  unitAt(x: number, y: number): Unit | null {
    return this.map.getUnitAt(x, y);
  }

  /**
   * Can the current player act with this unit right now? A finished game is
   * read-only: endTurn already refuses and enumerateActions returns nothing,
   * so letting selection through here would leave the human UI as the one
   * caller that can still rewrite a decided board.
   */
  canControl(unit: Unit | null): unit is Unit {
    return this.over === null && unit !== null
      && unit.getOwner() === this.currentPlayer && !unit.hasMoved
      && this.map.units.includes(unit) && unit.getHp() > 0;
  }

  /**
   * Picks a unit up. Returns the tiles it can reach, or null if the tap did not
   * land on a unit this player may move.
   */
  select(x: number, y: number): MovementRange | null {
    const unit = this.unitAt(x, y);
    if (!this.canControl(unit)) {
      this.clearSelection();
      return null;
    }
    this.selected = unit;
    this.range = computeMovementRange(this.map, unit);
    return this.range;
  }

  clearSelection(): void {
    this.selected = null;
    this.range = null;
    this.pendingDestination = null;
  }

  /** The route the selected unit would take to a tile, for path previews. */
  previewPath(x: number, y: number): ReachableTile[] {
    if (!this.range) return [];
    return pathTo(this.range, x, y);
  }

  /**
   * Moves the selected unit. Fuel drops by the path cost
   * (game/unit.cpp: Unit::moveUnitAction) and the unit is marked as done.
   */
  moveSelected(x: number, y: number): MoveResult {
    const unit = this.selected;
    const range = this.range;
    if (!unit || !range) return { moved: false, path: [], cost: 0, reason: 'not-your-unit' };
    if (unit.hasMoved) return { moved: false, path: [], cost: 0, reason: 'already-moved' };

    if (!this.canControl(unit)) return { moved: false, path: [], cost: 0, reason: 'not-your-unit' };
    const currentRange = computeMovementRange(this.map, unit);
    const tile = currentRange.tiles.get(key(x, y));
    if (!tile) return { moved: false, path: [], cost: 0, reason: 'unreachable' };
    if (!tile.canStop) return { moved: false, path: [], cost: 0, reason: 'occupied' };

    const path = pathTo(currentRange, x, y);
    const trap = this.trapAction(this.buildAction('ACTION_WAIT', unit, { x, y }, currentRange));
    if (trap) {
      const cost = trap.getCosts();
      const stoppedPath = path.slice(0, trap.getMovePathLength());
      return { moved: this.runPrepared(trap, unit, { x, y }), path: stoppedPath, cost };
    }
    unit.fuel = Math.max(0, unit.fuel - tile.cost);
    // Through moveUnitToField, not a bare x/y write: it resets capture
    // progress, which must not survive a move (see Unit.moveUnitToField). Only
    // when the unit actually leaves its tile though — game/unit.cpp:
    // Unit::moveUnit skips the relocation for a one-point path, so a unit
    // acting in place keeps the capture it has banked.
    if (unit.x !== x || unit.y !== y) unit.moveUnitToField(x, y);
    unit.hasMoved = true;
    this.clearSelection();
    this.map.vision.update();
    return { moved: true, path, cost: tile.cost };
  }

  /** Marks the selected unit done without moving it. */
  waitSelected(): void {
    if (!this.canControl(this.selected)) return;
    this.selected.hasMoved = true;
    this.clearSelection();
  }

  endTurn(): void {
    if (this.over) return;
    this.cancelAction();
    this.cancelUnloadMove();
    this.endOfTurn(this.currentPlayer);
    this.clearSelection();
    // Skip anyone already knocked out.
    let newDay = false;
    for (let step = 0; step < this.map.players.length; step++) {
      this.currentPlayerIndex += 1;
      if (this.currentPlayerIndex >= this.map.players.length) {
        this.currentPlayerIndex = 0;
        this.day += 1;
        newDay = true;
      }
      if (!this.currentPlayer.isDefeated) break;
    }
    this.map.currentPlayerIndex = this.currentPlayerIndex;
    this.beginTurn(this.currentPlayer, newDay);
    this.map.vision.update();
    this.checkGameOver();
  }

  // --- victory ------------------------------------------------------------

  /**
   * Defeat and victory are decided entirely by gamerules/victory/*.js, through
   * GameRules::checkVictory. Nothing about who loses when is restated here —
   * the rules latch state per player, count teams rather than players, and
   * differ in what happens to a loser's buildings, and every one of those
   * details lives in the scripts.
   */
  checkGameOver(): GameOver | null {
    if (this.over) return this.over;
    const outcome = this.map.getGameRules().checkVictory(this.currentPlayer);
    if (!outcome) return null;

    const alive = this.map.players.filter(player => !player.isDefeated);
    this.over = {
      winner: alive[0]?.getPlayerID() ?? -1,
      winningTeam: outcome.team,
      ruleID: outcome.ruleID,
      reason: REASON_BY_RULE[outcome.ruleID ?? ''] ?? 'rule',
    };
    return this.over;
  }

  ownedBuildings(player: Player): Building[] {
    const owned: Building[] = [];
    for (let y = 0; y < this.map.height; y++) {
      for (let x = 0; x < this.map.width; x++) {
        const building = this.map.getTerrain(x, y).getBuilding();
        if (building && building.getOwner() === player) owned.push(building);
      }
    }
    return owned;
  }

  /**
   * Start of a player's turn.
   *
   * game/gamemap.cpp: GameMap::startOfTurnPlayer walks the board and, per tile,
   * runs the unit's startOfTurn before the building's. That order matters: an
   * aircraft burns fuel in its own hook and is then refuelled by the airport it
   * is sitting on, so reversing it would strand planes that should survive.
   *
   * `neutralTurn` marks the first turn of a new day, as nextPlayer() reports it
   * in the engine — NOT "player index 0 is up". Keying the neutral hooks to
   * seat 0 would stop fires spreading and plasma evolving for the rest of the
   * match the moment player 0 is defeated, because the rotation skips dead
   * seats and never lands on index 0 again. Defaults to true for the opening
   * turn the constructor runs.
   */
  private beginTurn(player: Player, neutralTurn = true): void {
    player.expireVisionFields();
    for (const unit of player.units) unit.hasMoved = false;
    player.funds += this.calcIncome(player);

    for (let y = 0; y < this.map.height; y++) {
      for (let x = 0; x < this.map.width; x++) {
        const unit = this.map.getUnitAt(x, y);
        if (unit && unit.getOwner() === player) unit.startOfTurn();

        const terrain = this.map.getTerrain(x, y);
        const building = terrain.getBuilding();
        if (building && building.getOwner() === player) building.startOfTurn();

        // game/gamemap.cpp: startOfTurnNeutral runs terrain and unowned
        // buildings once per day — this is what spreads fires and grows plasma.
        if (neutralTurn) {
          terrain.startOfTurn();
          if (building && building.getOwner() === null) building.startOfTurn();
        }
      }
    }
    this.animations?.flush(this.map);
    this.animations?.clearCreated();
    this.checkFuel(player);
    this.cleanupDead();
  }

  /**
   * game/gamemap.cpp: GameMap::checkFuel — a unit whose upkeep drove its fuel
   * below zero is destroyed at its owner's turn. Only units that actually
   * consume fuel can starve.
   */
  private checkFuel(player: Player): void {
    for (const unit of [...player.units]) {
      if (unit.maxFuel > 0 && unit.fuel < 0) unit.killUnit();
    }
  }

  /**
   * game/player.cpp: Player::calcIncome sums Building::getIncome, and each
   * building truncates its own `baseIncome * fundsModifier` before the sum —
   * rounding once at the end drifts by a few funds per turn.
   */
  calcIncome(player: Player): number { return player.calcIncome(); }

  /** game/gamemap.cpp: end-of-turn hooks for the player who just finished. */
  private endOfTurn(player: Player): void {
    for (const unit of [...player.units]) unit.endOfTurn();
    for (let y = 0; y < this.map.height; y++) {
      for (let x = 0; x < this.map.width; x++) {
        const building = this.map.getTerrain(x, y).getBuilding();
        if (building && building.getOwner() === player) building.endOfTurn();
      }
    }
    try { this.registry.PLAYER?.endOfTurn?.(player, this.map); } catch { /* optional */ }
    this.animations?.flush(this.map);
    this.animations?.clearCreated();
    this.cleanupDead();
  }

  /** Units of the current player that still have something to do. */
  pendingUnits(): Unit[] {
    return this.currentPlayer.units.filter(unit => !unit.hasMoved);
  }
}

/**
 * The seat whose fog of war the person at the screen should see.
 *
 * During a human turn that is simply the current player — in hotseat play the
 * device changes hands with the turn. While an AI plays, though, drawing the
 * board through the current player's eyes puts the machine's entire
 * intelligence picture on screen — its own hidden units and everything it has
 * spotted — for its whole turn, which under fog is free enemy recon every
 * round. The view therefore stays with a human: the next human seat in turn
 * order, which is whoever is holding the device waiting to play. With no
 * living human seat (an all-AI spectate) the current player's view is the
 * only sensible one left.
 */
/**
 * The next observer view when spectating an all-AI game.
 *
 * `null` is omniscient — no fog at all — and the cycle runs omniscient, then
 * each living seat, then back. Defeated seats are skipped: their vision stops
 * updating, so locking to one shows a board frozen at the moment they died.
 * Pure so it can be tested without a DOM, like `fogViewerIndex`.
 */
export function nextObserverSeat(
  current: number | null,
  seatCount: number,
  isDefeated: (seat: number) => boolean,
): number | null {
  if (seatCount <= 0) return null;
  for (let seat = current === null ? 0 : current + 1; seat < seatCount; seat++) {
    if (!isDefeated(seat)) return seat;
  }
  return null;
}

export function fogViewerIndex(
  currentIndex: number,
  seatCount: number,
  isHuman: (seat: number) => boolean,
  isDefeated: (seat: number) => boolean,
): number {
  if (seatCount <= 0 || isHuman(currentIndex)) return currentIndex;
  for (let step = 1; step <= seatCount; step++) {
    const seat = (currentIndex + step) % seatCount;
    if (isHuman(seat) && !isDefeated(seat)) return seat;
  }
  return currentIndex;
}

function safeCall<T>(fn: () => T): T | undefined {
  try { return fn(); } catch { return undefined; }
}

function prettify(actionID: string): string {
  return actionID.replace(/^ACTION_/, '').replace(/_/g, ' ').toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}
