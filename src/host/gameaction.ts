import type { GameMap } from './gamemap.ts';
import type { Unit } from './unit.ts';
import type { Player } from './player.ts';
import type { Terrain, Building } from './terrain.ts';
import type { QPoint } from './globals.ts';
import { MarkedFieldData, MenuData } from './stepdata.ts';

/**
 * The object every Commander Wars action script operates on (game/gameaction.h).
 *
 * An action carries: which unit is acting, where it started, where it moved to,
 * and a small data buffer for multi-step actions (a production menu writes the
 * chosen unit id here, a fire action writes its target).
 *
 * Two coordinates matter and are easy to confuse:
 *   getTarget()       where the unit was picked up
 *   getActionTarget() where it ends up after moving — what the action acts on
 */
export class GameAction {
  readonly map: GameMap;
  actionID = '';
  private unit: Unit | null = null;
  private target: QPoint = { x: -1, y: -1 };
  private movePath: QPoint[] = [];
  private costs = 0;
  private inputStep = 0;
  private data: Array<number | string> = [];
  private readCursor = 0;
  private player: Player | null = null;

  constructor(map: GameMap, actionID = '') {
    this.map = map;
    this.actionID = actionID;
  }

  getMap(): GameMap { return this.map; }
  getActionID(): string { return this.actionID; }
  setActionID(value: string): void { this.actionID = value; }

  setTargetUnit(unit: Unit | null): void {
    this.unit = unit;
    if (unit) this.target = { x: unit.x, y: unit.y };
  }
  getTargetUnit(): Unit | null {
    // Before a move the acting unit stands on the target field; after one it is
    // at the end of the path but still the unit this action belongs to.
    return this.unit;
  }
  getPerformingUnit(): Unit | null { return this.unit; }

  getTargetBuilding(): Building | null {
    return this.map.getTerrain(this.target.x, this.target.y)?.getBuilding() ?? null;
  }

  /** Where the unit started this action. */
  getTarget(): QPoint { return { ...this.target }; }
  setTarget(point: QPoint): void { this.target = { ...point }; }

  /** Where the unit ends up: the last step of the path, or the start. */
  getActionTarget(): QPoint {
    const last = this.movePath.at(-1);
    return last ? { ...last } : { ...this.target };
  }

  setMovepath(points: QPoint[], fuelCost: number): void {
    this.movePath = points.map(p => ({ ...p }));
    this.costs = fuelCost;
  }
  getMovePath(): QPoint[] { return this.movePath.map(p => ({ ...p })); }
  getMovePathLength(): number { return this.movePath.length; }
  getCosts(): number { return this.costs; }
  setCosts(value: number): void { this.costs = value; }

  /** The unit standing where this action ends, if any. */
  getMovementTarget(): Unit | null {
    const at = this.getActionTarget();
    const occupant = this.map.getUnitAt(at.x, at.y);
    return occupant && occupant !== this.unit ? occupant : null;
  }

  getMovementBuilding(): Building | null {
    const at = this.getActionTarget();
    return this.map.getTerrain(at.x, at.y)?.getBuilding() ?? null;
  }

  getMovementTerrain(): Terrain | null {
    const at = this.getActionTarget();
    return this.map.getTerrain(at.x, at.y) ?? null;
  }

  getPlayer(): number {
    return (this.player ?? this.unit?.getOwner() ?? this.map.getCurrentPlayer())?.getPlayerID() ?? 0;
  }
  setPlayer(index: number): void { this.player = this.map.getPlayer(index) ?? null; }

  getInputStep(): number { return this.inputStep; }
  setInputStep(value: number): void { this.inputStep = value; }

  // Multi-step actions pass their choices through this buffer.
  writeDataInt32(value: number): void { this.data.push(value); }
  writeDataString(value: string): void { this.data.push(value); }
  writeDataFloat(value: number): void { this.data.push(value); }
  startReading(): void { this.readCursor = 0; }
  readDataInt32(): number { return Number(this.data[this.readCursor++] ?? 0); }
  readDataString(): string { return String(this.data[this.readCursor++] ?? ''); }
  readDataFloat(): number { return Number(this.data[this.readCursor++] ?? 0); }
  getVariableCount(): number { return this.data.length; }

  // --- multi-step input --------------------------------------------------
  //
  // `isFinalStep` and `getStepInputType` are SIDE-EFFECTING in the scripts:
  // ACTION_UNLOAD writes into the buffer and advances the step from inside both
  // of them. They must be called fresh each iteration, in this order, and never
  // cached.

  isFinalStep(actionID = this.actionID): boolean {
    const result = this.map.registry[actionID]?.isFinalStep?.(this, this.map);
    return result === true;
  }

  getStepInputType(actionID = this.actionID): string {
    const result = this.map.registry[actionID]?.getStepInputType?.(this, this.map);
    return typeof result === 'string' ? result : '';
  }

  /** Fills a MarkedFieldData from the script's getStepData. */
  getMarkedFieldStepData(): MarkedFieldData {
    const data = new MarkedFieldData();
    try { this.map.registry[this.actionID]?.getStepData?.(this, data, this.map); }
    catch (error) { console.warn(`${this.actionID}.getStepData failed`, error); }
    return data;
  }

  /** Fills a MenuData from the script's getStepData. */
  getMenuStepData(): MenuData {
    const data = new MenuData(this.map);
    try { this.map.registry[this.actionID]?.getStepData?.(this, data, this.map); }
    catch (error) { console.warn(`${this.actionID}.getStepData failed`, error); }
    return data;
  }

  getJMarkedFieldStepData(): MarkedFieldData { return this.getMarkedFieldStepData(); }
  getJsMenuStepData(): MenuData { return this.getMenuStepData(); }

  canBePerformed(actionID = this.actionID): boolean {
    const result = this.map.registry[actionID]?.canBePerformed?.(this, this.map);
    return result === true;
  }

  getSeed(): number { return 0; }
  getIsLocal(): boolean { return true; }
  setIsLocal(_value: boolean): void {}
  getMultiTurnPath(): QPoint[] { return []; }
  setMultiTurnPath(_path: QPoint[]): void {}
  getRequiresEmptyField(): boolean { return false; }

  reset(): void {
    this.movePath = [];
    this.costs = 0;
    this.inputStep = 0;
    this.data = [];
    this.readCursor = 0;
  }
}
