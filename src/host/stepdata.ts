import type { QPoint } from './globals.ts';
import type { GameMap } from './gamemap.ts';

/**
 * gameinput/markedfielddata.h — the object an action script fills in to say
 * which tiles a FIELD input step may choose from.
 *
 * Note `setAllFields(true)`: the script adds no points and EVERY on-map tile
 * becomes selectable. ACTION_MISSILE uses exactly that, so a driver must treat
 * an empty point list plus this flag as "the whole map" rather than "nothing".
 */
export class MarkedFieldData {
  private readonly points: QPoint[] = [];
  private readonly zInformation: number[] = [];
  private allFields = false;
  private showZData = false;
  private color = '';
  private zLabelColor = '';
  private zLabelText = '';

  addPoint(point: QPoint): void { this.points.push({ x: point.x, y: point.y }); }
  addPointXY(x: number, y: number): void { this.points.push({ x, y }); }
  getJsPoints(): QPoint[] { return this.points.map(p => ({ ...p })); }
  getPoints(): QPoint[] { return this.points; }

  setAllFields(value: boolean): void { this.allFields = value; }
  getAllFields(): boolean { return this.allFields; }
  setShowZData(value: boolean): void { this.showZData = value; }
  getShowZData(): boolean { return this.showZData; }

  addZInformation(value: number): void { this.zInformation.push(value); }
  getZInformation(): number[] { return this.zInformation; }
  addComplexZInformation(): void { /* preview overlay only */ }

  setColor(value: string): void { this.color = value; }
  getColor(): string { return this.color; }
  setZLabelColor(value: string): void { this.zLabelColor = value; }
  getZLabelColor(): string { return this.zLabelColor; }
  setZLabelText(value: string): void { this.zLabelText = value; }
  getZLabelText(): string { return this.zLabelText; }
  remove(): void { /* no-op */ }
}

export interface MenuEntry {
  text: string;
  actionID: string;
  icon: string;
  cost: number;
  enabled: boolean;
}

/** gameinput/menudata.h — the entries a MENU input step offers. */
export class MenuData {
  private readonly entries: MenuEntry[] = [];
  readonly map: GameMap;

  constructor(map: GameMap) { this.map = map; }

  addData(text: string, actionID: string, icon = '', costs = 0, enabled = true): void {
    this.entries.push({ text, actionID, icon, cost: costs, enabled });
  }
  addUnitData(text: string, actionID: string, _icon?: unknown, costs = 0, enabled = true): void {
    this.entries.push({ text, actionID, icon: '', cost: costs, enabled });
  }

  /** menudata.cpp: true only when there is at least one entry. */
  validData(): boolean { return this.entries.length > 0; }

  getActionIDs(): string[] { return this.entries.map(e => e.actionID); }
  getCostList(): number[] { return this.entries.map(e => e.cost); }
  getEnabledList(): boolean[] { return this.entries.map(e => e.enabled); }
  getTexts(): string[] { return this.entries.map(e => e.text); }
  getEntries(): MenuEntry[] { return this.entries.map(e => ({ ...e })); }
  getMap(): GameMap { return this.map; }
  remove(): void { /* no-op */ }
}
