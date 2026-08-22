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
    this.animations = animations;
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
  }

  get currentPlayer(): Player {
    return this.map.players[this.currentPlayerIndex];
  }

  // --- actions ------------------------------------------------------------

  /**
   * Builds a GameAction the way the engine does: the unit, where it came from,
   * and the path it would take. Action scripts read all of that.
   */
  private buildAction(actionID: string, unit: Unit, destination: { x: number; y: number }): GameAction {
    const action = new GameAction(this.map, actionID);
    action.setTargetUnit(unit);
    action.setTarget({ x: unit.x, y: unit.y });
    const route = this.range ? pathTo(this.range, destination.x, destination.y) : [];
    const points = route.length > 0
      ? route.map(tile => ({ x: tile.x, y: tile.y }))
      : [{ x: destination.x, y: destination.y }];
    action.setMovepath(points, route.at(-1)?.cost ?? 0);
    return action;
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
    const script = this.registry[actionID];
    if (!script?.perform) return false;
    const action = this.buildAction(actionID, unit, destination);
    configure?.(action);

    try {
      script.perform(action, this.map);
    } catch (error) {
      console.warn(`action ${actionID} failed`, error);
      return false;
    }
    this.animations?.flush(this.map);

    this.cleanupDead();
    this.clearSelection();
    this.map.vision.update();
    this.checkGameOver();
    return true;
  }

  // --- multi-step actions -------------------------------------------------

  /** An action mid-way through collecting its inputs. */
  pending: { action: GameAction; unit: Unit; destination: { x: number; y: number } } | null = null;

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
    const action = this.buildAction(actionID, unit, destination);
    if (!action.canBePerformed()) return { kind: 'invalid' };
    this.pending = { action, unit, destination };
    return this.advance();
  }

  /** Supplies a chosen tile for a FIELD step. */
  provideField(x: number, y: number): ActionStep {
    if (!this.pending) return { kind: 'invalid' };
    this.pending.action.writeDataInt32(x);
    this.pending.action.writeDataInt32(y);
    this.pending.action.setInputStep(this.pending.action.getInputStep() + 1);
    return this.advance();
  }

  /** Supplies a chosen menu entry. */
  provideMenu(actionID: string, cost = 0): ActionStep {
    if (!this.pending) return { kind: 'invalid' };
    const action = this.pending.action;
    action.writeDataString(actionID);
    action.setCosts(action.getCosts() + cost);
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
      if (state.kind !== 'done') return state;

      this.pending = null;
      const performed = this.runPrepared(action, unit, destination);
      return performed ? { kind: 'done' } : { kind: 'invalid' };
    }
    this.pending = null;
    return { kind: 'invalid' };
  }

  /** Performs an action whose inputs are already in its buffer. */
  private runPrepared(action: GameAction, _unit: Unit, _destination: { x: number; y: number }): boolean {
    const script = this.registry[action.getActionID()];
    if (!script?.perform) return false;
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
   * Tiles a carried unit could be dropped onto.
   *
   * Ported from ACTION_UNLOAD.getUnloadFields. The rule that is easy to miss is
   * the FIRST one: the cargo must be able to stand on the *transport's own*
   * tile, not merely on the destination. Infantry cannot stand on sea, so a
   * lander has to be on a beach or in a harbour to disembark — without this
   * check, boats unload across open coastline, which Advance Wars never allows.
   */
  unloadTargets(transport: Unit, cargoIndex: number): Array<{ x: number; y: number }> {
    const cargo = transport.loaded[cargoIndex];
    if (!cargo) return [];

    // ACTION_UNLOAD.isUnloadTerrain: boats cannot unload while on a bridge.
    const transportTerrainId = this.map.getTerrain(transport.x, transport.y).getID();
    const boats = ['LANDER', 'BLACK_BOAT', 'CANNONBOAT'];
    if (boats.includes(transport.getUnitID())
        && ['BRIDGE', 'BRIDGE1', 'BRIDGE2'].includes(transportTerrainId)) {
      return [];
    }

    // Can the cargo occupy the transport's tile at all?
    if (cargo.getBaseMovementCosts(transport.x, transport.y, transport.x, transport.y) <= 0) {
      return [];
    }

    const targets: Array<{ x: number; y: number }> = [];
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as Array<[number, number]>) {
      const x = transport.x + dx;
      const y = transport.y + dy;
      if (!this.map.onMap(x, y)) continue;
      if (this.map.getUnitAt(x, y)) continue;
      if (cargo.getBaseMovementCosts(x, y, transport.x, transport.y) <= 0) continue;
      targets.push({ x, y });
    }
    return targets;
  }

  /**
   * Moves a transport to its destination without ending its turn, so it can
   * unload afterwards. Advance Wars lets a transport move and then drop cargo;
   * the fuel is charged for the move exactly as a normal move would.
   */
  moveForUnload(transport: Unit, x: number, y: number): boolean {
    if (transport.x === x && transport.y === y) return true;
    const tile = this.range?.tiles.get(key(x, y));
    if (!tile || !tile.canStop) return false;
    transport.fuel = Math.max(0, transport.fuel - tile.cost);
    transport.moveUnitToField(x, y);
    this.map.vision.update();
    return true;
  }

  /** Drops a carried unit onto a tile. The unit is spent for the turn. */
  unloadUnit(transport: Unit, cargoIndex: number, x: number, y: number): boolean {
    const cargo = transport.loaded[cargoIndex];
    if (!cargo) return false;
    if (!this.unloadTargets(transport, cargoIndex).some(t => t.x === x && t.y === y)) return false;

    transport.unloadUnit(cargo, { x, y });
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
    const action = this.buildAction('ACTION_FIRE', unit, from);
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

  /** Can the current player act with this unit right now? */
  canControl(unit: Unit | null): unit is Unit {
    return unit !== null && unit.getOwner() === this.currentPlayer && !unit.hasMoved;
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

    const tile = range.tiles.get(key(x, y));
    if (!tile) return { moved: false, path: [], cost: 0, reason: 'unreachable' };
    if (!tile.canStop) return { moved: false, path: [], cost: 0, reason: 'occupied' };

    const path = pathTo(range, x, y);
    unit.x = x;
    unit.y = y;
    unit.fuel = Math.max(0, unit.fuel - tile.cost);
    unit.hasMoved = true;
    this.clearSelection();
    return { moved: true, path, cost: tile.cost };
  }

  /** Marks the selected unit done without moving it. */
  waitSelected(): void {
    if (!this.selected) return;
    this.selected.hasMoved = true;
    this.clearSelection();
  }

  endTurn(): void {
    if (this.over) return;
    this.cancelAction();
    this.endOfTurn(this.currentPlayer);
    this.clearSelection();
    // Skip anyone already knocked out.
    for (let step = 0; step < this.map.players.length; step++) {
      this.currentPlayerIndex += 1;
      if (this.currentPlayerIndex >= this.map.players.length) {
        this.currentPlayerIndex = 0;
        this.day += 1;
      }
      if (!this.currentPlayer.isDefeated) break;
    }
    this.map.currentPlayerIndex = this.currentPlayerIndex;
    this.beginTurn(this.currentPlayer);
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
   */
  private beginTurn(player: Player): void {
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
        if (this.currentPlayerIndex === 0) {
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
  calcIncome(player: Player): number {
    const modifier = this.fundsModifier(player);
    let income = 0;
    for (let y = 0; y < this.map.height; y++) {
      for (let x = 0; x < this.map.width; x++) {
        const building = this.map.getTerrain(x, y).getBuilding();
        if (!building || building.getOwner() !== player) continue;
        const base = this.registry[building.getBuildingID()]?.getBaseIncome?.(building, this.map);
        income += Math.trunc((typeof base === 'number' ? base : 0) * modifier);
      }
    }
    return income;
  }

  private fundsModifier(player: Player): number { return player.getFundsModifier(); }

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

function safeCall<T>(fn: () => T): T | undefined {
  try { return fn(); } catch { return undefined; }
}

function prettify(actionID: string): string {
  return actionID.replace(/^ACTION_/, '').replace(/_/g, ' ').toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}
