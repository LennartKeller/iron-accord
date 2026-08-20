import { GameRules, VictoryRule, type RuleInputType, GameMap } from '../host/index.ts';
import type { ScriptRegistry } from '../scripts/types.ts';

/** One configurable input of a victory rule, as the scripts describe it. */
export interface VictoryRuleItem {
  type: RuleInputType;
  name: string;
  description: string;
  defaultValue: number;
  /** Spinboxes only: the value that means "off". */
  infiniteValue: number;
  maxValue: number;
}

export interface VictoryRuleInfo {
  ruleID: string;
  name: string;
  description: string;
  items: VictoryRuleItem[];
}

/**
 * Everything a setup screen needs to offer the victory rules, read from
 * gamerules/victory/*.js rather than restated: names, help text, input kinds
 * and defaults all come from the rule that owns them.
 */
export function describeVictoryRules(map: GameMap, registry: ScriptRegistry): VictoryRuleInfo[] {
  const rules = new GameRules();
  rules.attach(map, registry);
  return rules.availableVictoryRules().map(ruleID => {
    const rule = new VictoryRule(ruleID, map, registry);
    const types = rule.getRuleType();
    return {
      ruleID,
      name: rule.getRuleName(0),
      description: rule.getRuleDescription(0),
      items: types.map((type, item) => ({
        type,
        name: rule.getRuleName(item),
        description: rule.getRuleDescription(item),
        defaultValue: rule.getDefaultValue(item),
        infiniteValue: rule.getInfiniteValue(item),
        maxValue: rule.getMaxValue(item),
      })),
    };
  });
}

/** The values a fresh game would use, so a form can start from the real defaults. */
export function defaultVictoryRuleValues(
  map: GameMap, registry: ScriptRegistry,
): Record<string, number[]> {
  return Object.fromEntries(describeVictoryRules(map, registry)
    .map(info => [info.ruleID, info.items.map(item => item.defaultValue)]));
}
