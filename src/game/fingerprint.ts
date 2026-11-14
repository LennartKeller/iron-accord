import type { Game } from './game.ts';
import { snapshot, type TerrainState, type UnitState } from './snapshot.ts';

/**
 * A compact, sectioned digest of everything the rules decide.
 *
 * Golden replays store one of these per action. Splitting it into sections is
 * what makes a mismatch readable: "vision differs" and "units differ" are
 * different conversations, and a bare hash cannot tell them apart.
 *
 * The fields are listed out rather than hashing the snapshot wholesale on
 * purpose. A snapshot also carries presentation state (names, palettes, ranks)
 * and will grow fields for reasons unrelated to rules; a digest that moved with
 * every one of those would train people to regenerate the goldens without
 * looking, which defeats them. Add a field here only when it is rules state.
 */
export const FINGERPRINT_SECTIONS = ['turn', 'units', 'world', 'players', 'vision', 'rng'] as const;
export type FingerprintSection = typeof FINGERPRINT_SECTIONS[number];

/** Hex digits kept per section. Units change every action, so they get the most. */
const WIDTHS: Record<FingerprintSection, number> = {
  turn: 2, units: 6, world: 4, players: 4, vision: 4, rng: 4,
};

/** Length of one encoded fingerprint. */
export const FINGERPRINT_LENGTH = FINGERPRINT_SECTIONS.reduce((sum, name) => sum + WIDTHS[name], 0);

/** FNV-1a, 32 bit. Pure JS so this file stays importable from the browser. */
export function fnv1a(text: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const hex = (text: string, digits: number) => fnv1a(text).toString(16).padStart(8, '0').slice(0, digits);

function unitRules(unit: UnitState): unknown[] {
  return [
    unit.uid, unit.unitID, unit.owner, unit.x, unit.y, unit.hp, unit.fuel, unit.ammo1, unit.ammo2,
    unit.hasMoved, unit.capturePoints, unit.hidden, unit.cloaked,
    unit.offensiveBonus, unit.defensiveBonus, unit.movementBonus, unit.visionBonus,
    unit.variables, unit.loaded.map(unitRules),
  ];
}

function terrainRules(terrain: TerrainState): unknown[] {
  return [terrain.terrainID, terrain.hp, terrain.visionHigh, terrain.variables,
    terrain.baseTerrain ? terrainRules(terrain.baseTerrain) : null];
}

/**
 * The digest of a position, as a fixed-width hex string.
 *
 * `rngState` is the script RNG's state. Including it catches a change in how
 * much combat luck an action consumes even when the roll happens not to change
 * a rounded HP — which is most of the time.
 */
export function fingerprintState(game: Game, rngState?: number): string {
  const state = snapshot(game);
  const { map } = game;

  const vision: string[] = [];
  for (const player of map.players) {
    const grid = map.vision.gridFor(player);
    vision.push(grid ? Array.from(grid).join('') : '-');
  }

  const sections: Record<FingerprintSection, unknown> = {
    turn: [state.day, state.currentPlayerIndex, state.over],
    units: [...state.units].sort((a, b) => a.uid - b.uid).map(unitRules),
    world: [
      state.buildings.map(b => [b.x, b.y, b.buildingID, b.owner, b.hp, b.fireCount, b.variables]),
      state.terrain.map(terrainRules),
    ],
    players: [
      state.players.map(p => [p.team, p.funds, p.isDefeated, p.visionFields]),
      state.victoryRules, state.unitUidCounter,
    ],
    vision,
    rng: rngState ?? null,
  };

  return FINGERPRINT_SECTIONS
    .map(name => hex(JSON.stringify(sections[name]), WIDTHS[name]))
    .join('');
}

/** The sections in which two encoded fingerprints disagree. */
export function differingSections(expected: string, actual: string): FingerprintSection[] {
  const differing: FingerprintSection[] = [];
  let offset = 0;
  for (const name of FINGERPRINT_SECTIONS) {
    const width = WIDTHS[name];
    if (expected.slice(offset, offset + width) !== actual.slice(offset, offset + width)) differing.push(name);
    offset += width;
  }
  return differing;
}
