import { GameEnums } from '../host/index.ts';

/** How a seat is played. AI kinds are resolved by name against the agent registry. */
export type SeatController = 'human' | 'ai';

export interface SeatConfig {
  army: string;
  team: number;
  controller: SeatController;
  /** Agent name when controller is 'ai'. */
  agent?: string;
}

export interface GameConfig {
  fog: 'off' | 'war' | 'shroud';
  /**
   * Funds each player starts with. Advance Wars starts at 0 and pays the first
   * turn's income immediately, so 0 is the faithful default rather than an
   * unset one.
   */
  startingFunds: number;
  /** Multiplies every building's income. */
  fundsModifier: number;
  /**
   * Maximum units per player. ZERO MEANS UNLIMITED — ACTION_BUILD_UNITS tests
   * `unitLimit <= 0`, so this is the engine's own "no cap" value.
   */
  unitLimit: number;
  /**
   * Victory rule values by rule id, one entry per input the rule declares.
   * A rule left out here takes the script's own default, which is how the two
   * standard conditions — no HQ and no units — end up switched on.
   */
  victoryRules: Record<string, number[]>;
  seats: SeatConfig[];
}

/**
 * Bounds for the configurable rules.
 *
 * These are enforced in the model, not just the form: the values flow into the
 * Commander Wars scripts, and a negative fund total or unit cap would produce
 * behaviour those scripts never anticipate.
 */
export const LIMITS = {
  startingFunds: { min: 0, max: 999_999, step: 1000 },
  unitLimit: { min: 0, max: 999, step: 5 },
  fundsModifier: { min: 0.1, max: 10 },
} as const;

const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(Math.max(value, min), max) : min;

/** Clamps every field into range. Always call this before starting a game. */
export function sanitizeConfig(config: GameConfig): GameConfig {
  const seatCount = config.seats.length;
  return {
    ...config,
    startingFunds: Math.round(
      clamp(config.startingFunds, LIMITS.startingFunds.min, LIMITS.startingFunds.max)),
    unitLimit: Math.round(clamp(config.unitLimit, LIMITS.unitLimit.min, LIMITS.unitLimit.max)),
    fundsModifier: clamp(config.fundsModifier, LIMITS.fundsModifier.min, LIMITS.fundsModifier.max),
    // Per-rule maxima live in the scripts (getMaxValue); all this can say is
    // that a rule value is a non-negative whole number.
    victoryRules: Object.fromEntries(
      Object.entries(config.victoryRules ?? {}).map(([ruleID, values]) => [
        ruleID, values.map(value => Math.round(clamp(value, 0, Number.MAX_SAFE_INTEGER))),
      ])),
    seats: config.seats.map((seat, index) => ({
      ...seat,
      // A team outside the seat range would put a player on nobody's side.
      team: Math.round(clamp(seat.team, 0, Math.max(0, seatCount - 1))),
    })),
  };
}

export const FOG_MODES: Record<GameConfig['fog'], number> = {
  off: GameEnums.Fog_Off,
  war: GameEnums.Fog_OfWar,
  shroud: GameEnums.Fog_OfShroud,
};

/**
 * Defaults for a scene: every seat human and on its own team, with the rules
 * the engine itself defaults to — no unit cap, and whatever starting funds the
 * map author set (which is 0 for all but one of the bundled maps).
 */
export function defaultConfig(seatCount: number, armies: string[], startingFunds = 0): GameConfig {
  return sanitizeConfig({
    fog: 'off',
    startingFunds,
    fundsModifier: 1,
    unitLimit: 0,
    victoryRules: {},
    seats: Array.from({ length: seatCount }, (_, index) => ({
      army: armies[index] ?? 'OS',
      team: index,
      controller: 'human' as SeatController,
    })),
  });
}
