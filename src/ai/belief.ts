import { GameEnums, type Player, type Unit } from '../host/index.ts';
import type { Game } from '../game/game.ts';

/**
 * An enemy unit as far as one player knows.
 *
 * `seen` distinguishes a unit in view right now from one being remembered:
 * only the first is certain to still be there.
 */
export interface KnownUnit {
  uid: number;
  unitID: string;
  owner: number;
  x: number;
  y: number;
  hp: number;
  seen: boolean;
  /** Days since it was last actually observed. Zero while in view. */
  age: number;
}

/**
 * What a player is entitled to know.
 *
 * Under fog of war the map layout and every building stay visible — only unit
 * positions are secret (VisionType_Fogged). Shroud hides the board itself, so
 * buildings have to be discovered as well. Both are modelled here, and with fog
 * switched off belief is simply the truth, so one agent plays every mode.
 *
 * Memory persists across turns: an enemy tank seen three days ago is still the
 * best guess about where its side's armour is, and forgetting it entirely makes
 * an agent walk into the same ambush repeatedly.
 */
export class Belief {
  /** Last-known enemy units, keyed by uid. */
  private readonly memory = new Map<number, KnownUnit>();
  /** Tiles ever seen, for shroud. */
  private explored: Uint8Array | null = null;
  private lastDay = 0;

  constructor(private readonly player: Player) {}

  private get fogged(): boolean {
    return this.player.map.getGameRules().getFogMode() !== GameEnums.Fog_Off;
  }

  private get shrouded(): boolean {
    return this.player.map.getGameRules().getFogMode() === GameEnums.Fog_OfShroud;
  }

  /**
   * Folds what is currently visible into memory. Call once per turn, before
   * planning: a unit in view refreshes its record, and one that has moved out
   * of view keeps its last sighting and starts ageing.
   */
  observe(game: Game): void {
    const map = game.map;
    const day = game.day;
    const elapsed = Math.max(0, day - this.lastDay);
    this.lastDay = day;
    if (elapsed > 0) for (const known of this.memory.values()) known.age += elapsed;

    if (this.shrouded) {
      if (!this.explored) this.explored = new Uint8Array(map.width * map.height);
      for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
          if (this.player.getFieldVisible(x, y)) this.explored[y * map.width + x] = 1;
        }
      }
    }

    // Everything starts the turn unconfirmed; seeing it again restores that.
    for (const known of this.memory.values()) known.seen = false;

    // Where we can see the truth, memory is either confirmed or discarded: a
    // tile in view that no longer holds what we remember disproves it. Note
    // this covers a unit that has since been destroyed, too.
    for (const [uid, known] of [...this.memory]) {
      if (!this.visible(known.x, known.y)) continue;
      const unit = map.getUnitByUid(uid);
      if (!unit || unit.x !== known.x || unit.y !== known.y) this.memory.delete(uid);
    }

    for (const other of map.players) {
      if (!this.player.isEnemy(other)) continue;
      for (const unit of other.units) {
        if (!this.visible(unit.x, unit.y)) continue;
        this.memory.set(unit.uid, {
          uid: unit.uid, unitID: unit.getUnitID(), owner: other.getPlayerID(),
          x: unit.x, y: unit.y, hp: unit.getHp(), seen: true, age: 0,
        });
      }
    }
  }

  private visible(x: number, y: number): boolean {
    return !this.fogged || this.player.getFieldVisible(x, y);
  }

  /** Enemy units the player knows about, in view or remembered. */
  known(): KnownUnit[] { return [...this.memory.values()]; }

  /** Enemy units actually in view this turn. */
  visibleUnits(): KnownUnit[] { return this.known().filter(u => u.seen); }

  /** Has this tile ever been seen? Always true unless the game uses shroud. */
  isExplored(x: number, y: number): boolean {
    if (!this.shrouded || !this.explored) return true;
    return this.explored[y * this.player.map.width + x] === 1;
  }

  /** Fraction of the board still unseen, 0 when not playing under shroud. */
  unexploredFraction(): number {
    if (!this.shrouded || !this.explored) return 0;
    let unseen = 0;
    for (const seen of this.explored) if (!seen) unseen++;
    return unseen / this.explored.length;
  }

  /** Live units matching what we believe, for reading real stats off the map. */
  resolve(game: Game, known: KnownUnit): Unit | null {
    const unit = game.map.getUnitByUid(known.uid);
    return unit && unit.x === known.x && unit.y === known.y ? unit : null;
  }

  forget(): void { this.memory.clear(); this.explored = null; this.lastDay = 0; }
}
