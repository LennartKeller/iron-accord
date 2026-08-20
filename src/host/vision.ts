import { GameEnums } from './enums.ts';
import type { GameMap } from './gamemap.ts';
import type { Player } from './player.ts';

/**
 * Fog of war.
 *
 * The distinction that matters is between the two unseen states
 * (game/GameEnums.h, and Player::getDefaultClearVisionType):
 *
 *   VisionType_Fogged    terrain and buildings ARE visible; units are hidden.
 *                        This is what standard Fog_OfWar uses.
 *   VisionType_Shrouded  nothing is visible at all. Only Fog_OfShroud starts
 *                        the map in this state.
 *
 * Treating Fog_OfWar as shrouded makes buildings appear to "de-fog" when a unit
 * walks past them, which is not how Advance Wars behaves — the map layout is
 * known from the start and only enemy positions are secret.
 *
 * Vision is recomputed wholesale rather than cached incrementally; a map is
 * small enough that correctness is worth more than the saved work.
 */
export class VisionMap {
  private readonly map: GameMap;
  /** Per player, a grid of GameEnums.VisionType values. */
  private readonly grids = new Map<number, Uint8Array>();

  constructor(map: GameMap) {
    this.map = map;
  }

  /** Recomputes every player's vision. Call after anything moves or is built. */
  update(): void {
    for (const player of this.map.players) this.updatePlayer(player);
  }

  private updatePlayer(player: Player): void {
    const { width, height } = this.map;
    const grid = new Uint8Array(width * height);
    const mode = this.map.getGameRules().getFogMode();
    const fogOff = mode === GameEnums.Fog_Off;

    // game/player.cpp: Player::getDefaultClearVisionType
    grid.fill(baseVisionFor(mode));

    if (!fogOff) {
      // Allies share vision, matching Player::checkAlliance.
      for (const other of this.map.players) {
        if (!player.isAlly(other)) continue;
        for (const unit of other.units) {
          // getVision() includes terrain bonuses; the raw field does not.
          this.reveal(grid, unit.x, unit.y, unit.getVision(), player);
        }
      }
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const building = this.map.getTerrain(x, y).getBuilding();
          if (building && player.isAlly(building.getOwner())) {
            this.reveal(grid, x, y, building.getVision());
          }
        }
      }
    }
    this.grids.set(player.getPlayerID(), grid);
  }

  /**
   * game/player.cpp: a tile inside the vision radius becomes Clear unless its
   * terrain conceals — and a concealing tile is still revealed to an observer
   * standing next to it, which is what makes forests worth scouting into rather
   * than around.
   */
  private reveal(
    grid: Uint8Array, cx: number, cy: number, radius: number, viewer?: Player,
  ): void {
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        if (!this.map.onMap(x, y)) continue;
        const distance = Math.abs(x - cx) + Math.abs(y - cy);
        if (distance > radius) continue;

        const index = y * this.map.width + x;
        if (!viewer) { grid[index] = GameEnums.VisionType_Clear; continue; }

        const terrain = this.map.getTerrain(x, y);
        const conceals = terrain.getVisionHide(viewer);
        if (!conceals) { grid[index] = GameEnums.VisionType_Clear; continue; }

        // Concealed, but a unit that ignores terrain hide is still exposed.
        const occupant = this.map.getUnitAt(x, y);
        if (occupant && !occupant.useTerrainHide() && !occupant.isStatusStealthed()) {
          grid[index] = GameEnums.VisionType_Clear;
          continue;
        }
        if (distance <= 1) grid[index] = GameEnums.VisionType_Clear;
      }
    }
  }

  getFieldVisibleType(player: Player, x: number, y: number): number {
    if (!this.map.onMap(x, y)) return GameEnums.VisionType_Shrouded;
    const grid = this.grids.get(player.getPlayerID());
    if (!grid) return GameEnums.VisionType_Clear;
    return grid[y * this.map.width + x];
  }

  getFieldVisible(player: Player, x: number, y: number): boolean {
    return this.getFieldVisibleType(player, x, y) === GameEnums.VisionType_Clear;
  }

  /** The raw grid, for the renderer. */
  gridFor(player: Player): Uint8Array | null {
    return this.grids.get(player.getPlayerID()) ?? null;
  }
}

/** game/player.cpp: Player::getDefaultClearVisionType — the unseen state. */
export function baseVisionFor(mode: number): number {
  switch (mode) {
    case GameEnums.Fog_Off: return GameEnums.VisionType_Clear;
    case GameEnums.Fog_OfShroud: return GameEnums.VisionType_Shrouded;
    case GameEnums.Fog_OfMist: return GameEnums.VisionType_Mist;
    default: return GameEnums.VisionType_Fogged;   // Fog_OfWar
}
}
