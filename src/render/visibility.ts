import type { Player } from '../host/player.ts';
import type { Unit } from '../host/unit.ts';

/** Shared by artwork, tile details and threat previews. Null means omniscient. */
export function unitVisibleToViewer(unit: Unit, viewer: Player | null): boolean {
  // Tile visibility alone misses dived submarines and terrain concealment.
  // Status stealth also applies when the map's fog setting is off.
  return viewer === null || !unit.isStealthed(viewer);
}
