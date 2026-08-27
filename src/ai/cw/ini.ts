import { NORMAL_AI_DEFAULTS, INI_RANGES, type NormalAiConfig } from './config.ts';

/**
 * ai/coreai.cpp: CoreAI::randomizeIni -- turns one AI into a family of them.
 *
 * Upstream uses this to generate varied training opponents, and that is exactly
 * why it is ported rather than dropped: every controlled experiment this project
 * has run said the breadth of the position distribution matters more than the
 * strength of the player producing it, so a panel of mutated NormalAis is worth
 * more as a data source than one canonical NormalAi.
 *
 * `chance` is the per-knob probability of being touched. `mutationRate` below
 * zero resamples uniformly across the knob's range; at or above zero it nudges
 * the current value by up to that percentage.
 */
export function randomizeConfig(
  random: () => number,
  chance = 1,
  mutationRate = -1,
  base: NormalAiConfig = NORMAL_AI_DEFAULTS,
): NormalAiConfig {
  const config: NormalAiConfig = { ...base };
  const randFloat = (min: number, max: number) => min + random() * (max - min);
  const randInt = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  for (const range of INI_RANGES) {
    if (random() >= chance) continue;
    // A few upstream ranges are stored inverted (SpamInfantryChance is min 100,
    // max 50); ordering them keeps sampling well-defined instead of empty.
    const min = Math.min(range.min, range.max);
    const max = Math.max(range.min, range.max);
    if (mutationRate < 0) {
      config[range.field] = randFloat(min, max);
    } else if (Math.abs(config[range.field]) <= 0.05) {
      // Near zero a percentage nudge cannot escape zero, so the C++ kicks the
      // value to a fixed small magnitude instead.
      const roll = randInt(-1, 1);
      config[range.field] = roll === 0 ? 0 : (roll > 0 ? 0.075 : -0.075);
    } else {
      const roll = randInt(-mutationRate, mutationRate);
      config[range.field] = config[range.field] * (1 + roll / 100);
    }
  }
  return config;
}
