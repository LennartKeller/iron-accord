import type { Game } from '../game/game.ts';
import { vocabulary } from '../scripts/vocabulary.ts';
import { GameEnums, MAX_UNIT_HP } from '../host/index.ts';

/**
 * Board state as tensors, for learned policies.
 *
 * Layout is channels-first (C, H, W) with every value normalised to roughly
 * [0, 1] or [-1, 1], which is what convolutional policies expect. Everything is
 * written from the acting player's point of view — "mine" and "theirs" rather
 * than "player 0" and "player 1" — so a policy generalises across seats instead
 * of learning one player's perspective.
 */

export interface ObservationSpec {
  channels: number;
  height: number;
  width: number;
  /** Human-readable channel names, in order. Useful for debugging and for saliency maps. */
  channelNames: string[];
  scalarNames: string[];
}

export interface Observation {
  /** Float32Array of length channels * height * width, channels-first. */
  planes: Float32Array;
  /** Global features that are not spatial. */
  scalars: Float32Array;
  spec: ObservationSpec;
}

/** Terrain and building ids are interned per-encoder so channels stay stable. */
export class ObservationEncoder {
  private readonly terrainIndex = new Map<string, number>();
  private readonly unitIndex = new Map<string, number>();
  private readonly buildingIndex = new Map<string, number>();
  readonly spec: ObservationSpec;

  /**
   * @param terrainIds   terrain ids to give dedicated channels
   * @param unitIds      unit ids to give dedicated channels
   * @param buildingIds  building ids to give dedicated channels
   */
  private readonly width: number;
  private readonly height: number;

  constructor(
    width: number,
    height: number,
    terrainIds: string[],
    unitIds: string[],
    buildingIds: string[],
  ) {
    this.width = width;
    this.height = height;
    terrainIds.forEach((id, i) => this.terrainIndex.set(id, i));
    unitIds.forEach((id, i) => this.unitIndex.set(id, i));
    buildingIds.forEach((id, i) => this.buildingIndex.set(id, i));

    const channelNames = [
      ...terrainIds.map(id => `terrain:${id}`),
      ...unitIds.map(id => `unit:${id}`),
      ...buildingIds.map(id => `building:${id}`),
      'unit:mine', 'unit:theirs', 'unit:hp', 'unit:fuel', 'unit:ammo', 'unit:spent',
      'building:mine', 'building:theirs', 'building:neutral', 'building:capture',
      'vision:clear', 'vision:fogged',
    ];

    this.spec = {
      channels: channelNames.length,
      height,
      width,
      channelNames,
      scalarNames: ['funds', 'day', 'unitCount', 'enemyUnitCount', 'incomeShare'],
    };
  }

  /**
   * An encoder for this board, with channels drawn from the whole script
   * registry rather than from the ids this map happens to contain.
   *
   * Per-map vocabularies gave a different channel count on every board — 38 on
   * one, more on another — which no single network can consume. The board size
   * still varies, which is why the net must be fully convolutional, but the
   * channel layout is now identical everywhere.
   */
  static fromGame(game: Game, _unitVocabulary?: string[]): ObservationEncoder {
    const { terrain, units, buildings } = vocabulary(game.map.registry);
    return new ObservationEncoder(game.map.width, game.map.height, terrain, units, buildings);
  }

  /** The per-map vocabulary, kept for tests that want a compact tensor. */
  static forMapOnly(game: Game, unitVocabulary: string[]): ObservationEncoder {
    const terrainIds = new Set<string>();
    const buildingIds = new Set<string>();
    for (let y = 0; y < game.map.height; y++) {
      for (let x = 0; x < game.map.width; x++) {
        const terrain = game.map.getTerrain(x, y);
        terrainIds.add(terrain.getTerrainID());
        const building = terrain.getBuilding();
        if (building) buildingIds.add(building.getBuildingID());
      }
    }
    return new ObservationEncoder(
      game.map.width, game.map.height,
      [...terrainIds].sort(), [...unitVocabulary].sort(), [...buildingIds].sort(),
    );
  }

  encode(game: Game, viewerIndex = game.currentPlayerIndex): Observation {
    const { width, height } = this;
    const planeSize = width * height;
    const planes = new Float32Array(this.spec.channels * planeSize);
    const viewer = game.map.getPlayer(viewerIndex);

    const terrainCount = this.terrainIndex.size;
    const unitCount = this.unitIndex.size;
    const buildingCount = this.buildingIndex.size;
    const base = terrainCount + unitCount + buildingCount;
    const at = (channel: number, x: number, y: number) => channel * planeSize + y * width + x;

    const fogOn = game.map.getGameRules().getFogMode() !== GameEnums.Fog_Off;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const terrain = game.map.getTerrain(x, y);

        const terrainChannel = this.terrainIndex.get(terrain.getTerrainID());
        if (terrainChannel !== undefined) planes[at(terrainChannel, x, y)] = 1;

        const visible = !fogOn || !viewer
          || viewer.getFieldVisibleType(x, y) === GameEnums.VisionType_Clear;
        const shrouded = fogOn && viewer
          && viewer.getFieldVisibleType(x, y) === GameEnums.VisionType_Shrouded;

        planes[at(base + 10, x, y)] = visible ? 1 : 0;
        planes[at(base + 11, x, y)] = shrouded ? 1 : 0;

        // Buildings are visible under fog (only units are hidden), so they are
        // encoded unless the tile is fully shrouded.
        const building = terrain.getBuilding();
        if (building && !shrouded) {
          const channel = this.buildingIndex.get(building.getBuildingID());
          if (channel !== undefined) planes[at(terrainCount + unitCount + channel, x, y)] = 1;
          const owner = building.getOwner();
          if (!owner) planes[at(base + 8, x, y)] = 1;
          else if (owner === viewer) planes[at(base + 6, x, y)] = 1;
          else planes[at(base + 7, x, y)] = 1;
        }

        const unit = game.map.getUnitAt(x, y);
        if (!unit || !visible) continue;

        const channel = this.unitIndex.get(unit.getUnitID());
        if (channel !== undefined) planes[at(terrainCount + channel, x, y)] = 1;

        const mine = unit.getOwner() === viewer;
        planes[at(base + 0, x, y)] = mine ? 1 : 0;
        planes[at(base + 1, x, y)] = mine ? 0 : 1;
        planes[at(base + 2, x, y)] = unit.getHp() / MAX_UNIT_HP;
        planes[at(base + 3, x, y)] = unit.maxFuel > 0 ? unit.fuel / unit.maxFuel : 1;
        planes[at(base + 4, x, y)] = unit.maxAmmo1 > 0 ? unit.ammo1 / unit.maxAmmo1 : 1;
        planes[at(base + 5, x, y)] = unit.hasMoved ? 1 : 0;
        planes[at(base + 9, x, y)] = unit.getCapturePoints() / 20;
      }
    }

    const enemies = game.map.players.filter(p => p !== viewer);
    const myIncome = viewer ? game.calcIncome(viewer) : 0;
    const totalIncome = game.map.players.reduce((sum, p) => sum + game.calcIncome(p), 0);

    const scalars = Float32Array.from([
      // Funds and day are unbounded; squash them so a policy sees a stable range.
      viewer ? Math.min(viewer.funds / 50_000, 1) : 0,
      Math.min(game.day / 100, 1),
      Math.min((viewer?.units.length ?? 0) / 50, 1),
      Math.min(enemies.reduce((sum, p) => sum + p.units.length, 0) / 50, 1),
      totalIncome > 0 ? myIncome / totalIncome : 0,
    ]);

    return { planes, scalars, spec: this.spec };
  }
}
