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

  /** The fog mode each player's grid was last computed under. */
  private readonly modes = new Map<number, number>();

  /**
   * game/player.cpp: Player::updatePlayerVision.
   *
   * The grid is carried from one update to the next rather than rebuilt, and
   * that carries meaning in one mode: under shroud a tile that has ever been
   * seen drops back to Fogged — layout known, units hidden — and never to
   * Shrouded again. Rebuilding from scratch made the map forget everything a
   * player had explored the moment their units moved on.
   */
  private updatePlayer(player: Player): void {
    const { width, height } = this.map;
    const mode = this.map.getGameRules().getFogMode();
    const id = player.getPlayerID();
    const unseen = clearedVisionFor(mode);
    const previous = this.grids.get(id);
    const grid = new Uint8Array(width * height);

    if (previous && previous.length === grid.length && this.modes.get(id) === mode) {
      for (let i = 0; i < grid.length; i++) {
        grid[i] = previous[i] === GameEnums.VisionType_Shrouded ? GameEnums.VisionType_Shrouded : unseen;
      }
    } else {
      // Player::loadVisionFields: a fresh field, or one from another fog mode.
      grid.fill(baseVisionFor(mode));
    }
    this.modes.set(id, mode);

    if (mode !== GameEnums.Fog_Off) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const terrain = this.map.getTerrain(x, y);

          // Terrain that lights its surroundings for everyone — a fire.
          const terrainRange = terrain.getVision(player);
          if (terrainRange >= 0) this.reveal(grid, x, y, terrainRange, player, false);

          // Allied buildings. A radar sees a long way, but not into cover: only
          // a unit standing next to concealing terrain does.
          const building = terrain.getBuilding();
          if (building && player.isAlly(building.getOwner())) {
            const range = building.getVision();
            if (range >= 0) {
              grid[y * width + x] = GameEnums.VisionType_Clear;
              this.reveal(grid, x, y, range, building.getOwner() ?? player, false);
            }
          }

          // Allied units; getVision() includes terrain bonuses, the raw field does not.
          const unit = this.map.getUnitAt(x, y);
          if (unit && player.isAlly(unit.getOwner())) {
            this.reveal(grid, x, y, unit.getVision(), unit.getOwner(), true);
          }
        }
      }
    }
    // Share temporary reveals for the owner's remaining duration, like normal
    // allied vision. CW's duration-minus-one copies expire on recomputation;
    // owner-based expiry keeps visibility independent of update frequency.
    for (const other of this.map.players) {
      if (!player.isAlly(other)) continue;
      for (const field of other.visionFields) {
        grid[field.y * width + field.x] = field.visionType;
      }
    }
    this.grids.set(id, grid);
  }

  /**
   * A tile inside the radius becomes Clear unless its terrain conceals — and a
   * concealing tile is still revealed when a unit that ignores cover stands on
   * it, or, for a UNIT's vision only, when the observer is next to it. That
   * last rule is what makes forests worth scouting into rather than around.
   */
  private reveal(
    grid: Uint8Array, cx: number, cy: number, radius: number, viewer: Player, adjacentSeesCover: boolean,
  ): void {
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        if (!this.map.onMap(x, y)) continue;
        const distance = Math.abs(x - cx) + Math.abs(y - cy);
        if (distance > radius) continue;

        const index = y * this.map.width + x;
        const terrain = this.map.getTerrain(x, y);
        if (!terrain.getVisionHide(viewer)) { grid[index] = GameEnums.VisionType_Clear; continue; }

        // Concealed, but a unit that ignores terrain hide is still exposed.
        const occupant = this.map.getUnitAt(x, y);
        if (occupant && !occupant.useTerrainHide() && !occupant.isStatusStealthed()) {
          grid[index] = GameEnums.VisionType_Clear;
          continue;
        }
        if (adjacentSeesCover && distance <= 1) grid[index] = GameEnums.VisionType_Clear;
      }
    }
  }

  /**
   * What each player has ever seen, for a snapshot. Only shroud remembers
   * anything, so every other mode answers null and vision stays derived state.
   */
  exportMemory(): Array<number[]> | null {
    if (this.map.getGameRules().getFogMode() !== GameEnums.Fog_OfShroud) return null;
    return this.map.players.map(player => Array.from(this.grids.get(player.getPlayerID()) ?? []));
  }

  /** Restores what `exportMemory` captured; follow with `update()`. */
  importMemory(memory: Array<ArrayLike<number>> | null | undefined): void {
    const mode = this.map.getGameRules().getFogMode();
    const size = this.map.width * this.map.height;
    for (const [index, player] of this.map.players.entries()) {
      const id = player.getPlayerID();
      const stored = memory?.[index];
      if (stored && stored.length === size) {
        this.grids.set(id, Uint8Array.from(stored));
        this.modes.set(id, mode);
      } else {
        // Nothing remembered: the next update starts from an unexplored map.
        this.grids.delete(id);
        this.modes.delete(id);
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

  getFieldDirectVisible(player: Player, x: number, y: number): boolean {
    return this.map.onMap(x, y) && this.map.players.some(other => player.isAlly(other)
      && other.visionFields.some(field => field.x === x && field.y === y && field.directView));
  }

  /** The raw grid, for the renderer. */
  gridFor(player: Player): Uint8Array | null {
    return this.grids.get(player.getPlayerID()) ?? null;
  }
}

/**
 * game/player.cpp: Player::getDefaultClearVisionType — what a tile falls back
 * to once it is no longer in sight. Under shroud that is Fogged, not Shrouded.
 */
export function clearedVisionFor(mode: number): number {
  switch (mode) {
    case GameEnums.Fog_Off: return GameEnums.VisionType_Clear;
    case GameEnums.Fog_OfMist: return GameEnums.VisionType_Mist;
    default: return GameEnums.VisionType_Fogged;   // Fog_OfWar and Fog_OfShroud
  }
}

/** game/player.cpp: Player::loadVisionFields — the state before anything has been seen. */
export function baseVisionFor(mode: number): number {
  switch (mode) {
    case GameEnums.Fog_Off: return GameEnums.VisionType_Clear;
    case GameEnums.Fog_OfShroud: return GameEnums.VisionType_Shrouded;
    case GameEnums.Fog_OfMist: return GameEnums.VisionType_Mist;
    default: return GameEnums.VisionType_Fogged;   // Fog_OfWar
}
}
