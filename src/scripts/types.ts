/**
 * The registry every Commander Wars script installs itself into.
 *
 * `resources/scripts/general/global.js` starts with `Global = this`, so the
 * registry IS the sandbox global object: a script's top-level `var INFANTRY = ...`
 * becomes `Global.INFANTRY`. Every cross-script reference goes through it
 * (`Global[unit.getUnitID()]`, `Global[weaponId].getBaseDamage(...)`).
 */
export interface ScriptRegistry {
  [key: string]: any;
}

/** A weapon script (resources/scripts/weapons/*.js). */
export interface WeaponScript {
  damageTable?: Array<[string, number]>;
  /**
   * NOT necessarily a lookup in this weapon's own `damageTable` —
   * WEAPON_TANKHUNTER_GUN delegates to WEAPON_HEAVY_TANK_GUN's table and leaves
   * its own as dead data. Always call this rather than reading the table.
   */
  getBaseDamage(unit: any): number;
  calculateDamage(hp: number, damage: number, offBonus: number, defBonus: number,
                  luckDamage: number, map: any): number;
}

/** A unit script (resources/scripts/units/*.js). */
export interface UnitScript {
  init(unit: any, map?: any): void;
  getBaseCost(): number;
  getMovementType(): string;
  actionList?: string[];
  getUnitDamageID?(unit: any, map: any): string;
  useTerrainDefense?(unit: any, map: any): boolean;
}

/** A terrain script (resources/scripts/terrain/*.js). */
export interface TerrainScript {
  getDefense?(terrain: any, map?: any): number;
  baseTerrainId?: string;
  getTerrainGroup?(): number;
}

/**
 * Evaluates a script in the shared sandbox and returns the sandbox global.
 * Implementations must use SLOPPY mode — the scripts rely on it (duplicate
 * parameter names in `forest.js`, implicit globals in `global.js`).
 */
export interface Evaluator {
  evaluate(source: string, filename: string): void;
  readonly global: ScriptRegistry;
}
