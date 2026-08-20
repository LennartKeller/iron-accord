import { ScriptVariables } from './variables.ts';
import { GameEnums } from './enums.ts';
import type { GameMap } from './gamemap.ts';
import type { Player } from './player.ts';
import type { ScriptRegistry } from '../scripts/types.ts';

/** game/victoryrule.h: "checkbox" | "spinbox". */
export type RuleInputType = 'checkbox' | 'spinbox';

/**
 * game/victoryrule.cpp — one configured victory condition, backed by its script.
 *
 * The host owns nothing but an id and a variable store: every question about
 * the rule (what it is called, what it defaults to, whether it has defeated
 * someone) is answered by the script it names. That is the point — the ten
 * rules under gamerules/victory/ then work without being reimplemented.
 */
export class VictoryRule {
  private readonly variables = new ScriptVariables();

  constructor(
    readonly ruleID: string,
    private readonly map: GameMap,
    private readonly registry: ScriptRegistry,
  ) {
    this.init();
  }

  getMap(): GameMap { return this.map; }
  getRuleID(): string { return this.ruleID; }
  getVariables(): ScriptVariables { return this.variables; }

  private get script(): Record<string, (...args: unknown[]) => unknown> {
    return (this.registry as Record<string, never>)[this.ruleID];
  }

  private call<T>(name: string, args: unknown[], fallback: T): T {
    const fn = this.script?.[name];
    if (typeof fn !== 'function') return fallback;
    const result = fn.apply(this.script, args);
    return (result === undefined || result === null) ? fallback : (result as T);
  }

  /** Seeds the rule's variables from the starting position. */
  init(): void { this.call('init', [this, this.map], undefined); }

  /**
   * Some rules return a bare string here rather than the documented list —
   * VictoryRule::getRuleType folds both into a list, so we do too.
   */
  getRuleType(): RuleInputType[] {
    const types = this.call<string | string[]>('getRuleType', [], ['checkbox']);
    return (typeof types === 'string' ? [types] : types) as RuleInputType[];
  }

  getRuleName(itemNumber = 0): string {
    return this.call('getRuleName', [this, itemNumber, this.map], '');
  }

  getRuleDescription(itemNumber = 0): string {
    return this.call('getRuleDescription', [this, itemNumber, this.map], '');
  }

  /** Note the script-side name differs: getDefaultRuleValue. */
  getDefaultValue(itemNumber = 0): number {
    return Number(this.call('getDefaultRuleValue', [itemNumber, this.map], 0));
  }

  /** The spinbox value that means "off". */
  getInfiniteValue(itemNumber = 0): number {
    return Number(this.call('getInfiniteValue', [itemNumber, this.map], 0));
  }

  getMaxValue(itemNumber = 0): number {
    return Number(this.call('getMaxValue', [this, itemNumber, this.map], 0));
  }

  getRuleValue(itemNumber = 0): number {
    return Number(this.call('getRuleValue', [this, itemNumber, this.map], 0));
  }

  setRuleValue(value: number, itemNumber = 0): void {
    this.call('setRuleValue', [this, value, itemNumber, this.map], undefined);
  }

  getRuleProgress(itemNumber: number, player: Player): number {
    return Number(this.call('getRuleProgress', [this, player, this.map, itemNumber], 0));
  }

  getRuleTargetValue(itemNumber: number, player: Player): number {
    return Number(this.call('getRuleTargetValue', [this, this.map, itemNumber, player], 0));
  }

  getRuleTargetCount(): number {
    return Number(this.call('getRuleTargetCount', [this, this.map], 1));
  }

  /** GameEnums.DefeatType_*, as judged by this rule alone. */
  checkDefeat(player: Player): number {
    const type = this.call('checkDefeat', [this, player, this.map], GameEnums.DefeatType_Alive);
    return Number.isFinite(Number(type)) ? Number(type) : GameEnums.DefeatType_Alive;
  }

  /** Rule state is just its variables — enough to snapshot and restore it. */
  toJSON(): Record<string, unknown> { return this.variables.toJSON(); }
  fromJSON(data: Record<string, unknown>): void { this.variables.fromJSON(data); }
}
