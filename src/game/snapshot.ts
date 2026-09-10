import { GameMap, Unit, BuildingHost, Terrain } from '../host/index.ts';
import type { Game } from './game.ts';
import type { VisionField } from '../host/player.ts';

/**
 * Full game state, captured as plain data.
 *
 * This exists so search and reinforcement learning can explore the state space:
 * take a snapshot, try a line of play, restore, try another. It is structural
 * cloning rather than a diff, which keeps restore simple and correct — a map is
 * small enough that copying it wholesale costs microseconds.
 *
 * What is deliberately NOT captured: anything derived. Vision is recomputed on
 * restore, and sprite lists are re-resolved by the renderer, so a snapshot stays
 * a description of the *rules* state only.
 */

export interface UnitState {
  uid: number;
  unitID: string;
  owner: number;
  x: number;
  y: number;
  hp: number;
  fuel: number;
  ammo1: number;
  ammo2: number;
  hasMoved: boolean;
  capturePoints: number;
  hidden: boolean;
  rank: number;
  cloaked: boolean;
  coUnit: number;
  customName: string;
  aiMode: number;
  aiPriority: number;
  offensiveBonus: Unit['offensiveBonus'];
  defensiveBonus: Unit['defensiveBonus'];
  movementBonus: Unit['movementBonus'];
  visionBonus: Unit['visionBonus'];
  variables: Record<string, unknown>;
  loaded: UnitState[];
}

export interface BuildingState {
  x: number;
  y: number;
  buildingID: string;
  owner: number;
  hp: number;
  fireCount: number;
  variables: Record<string, unknown>;
}

export interface PlayerState {
  army: string;
  team: number;
  funds: number;
  isDefeated: boolean;
  visionFields: VisionField[];
}

export interface GameState {
  day: number;
  currentPlayerIndex: number;
  over: Game['over'];
  fogMode: number;
  players: PlayerState[];
  /** Each victory rule's script variables, which is all the state they have. */
  victoryRules: Array<{ ruleID: string; variables: Record<string, unknown> }>;
  units: UnitState[];
  buildings: BuildingState[];
  /** Every tile: destroying a meteor also replaces indestructible plasma. */
  terrain: TerrainState[];
  /** Next unit identity to hand out; see GameMap.getUnitUidCounter. */
  unitUidCounter: number;
}

/** Rules state for a tile and its nested base terrain. */
export interface TerrainState {
  x: number;
  y: number;
  terrainID: string;
  hp: number;
  palette: string;
  visionHigh: number;
  variables: Record<string, unknown>;
  baseTerrain: TerrainState | null;
}

function captureTerrain(terrain: Terrain): TerrainState {
  return {
    x: terrain.x, y: terrain.y, terrainID: terrain.getTerrainID(), hp: terrain.hp,
    palette: terrain.palette, visionHigh: terrain.visionHigh,
    variables: terrain.variables.toJSON(),
    baseTerrain: terrain.baseTerrain ? captureTerrain(terrain.baseTerrain) : null,
  };
}

function restoreTerrain(map: GameMap, terrain: Terrain, state: TerrainState): void {
  if (terrain.terrainID !== state.terrainID) terrain.terrainID = state.terrainID;
  terrain.hp = state.hp;
  terrain.palette = state.palette;
  terrain.visionHigh = state.visionHigh;
  terrain.variables.fromJSON(state.variables);
  if (state.baseTerrain) {
    if (!terrain.baseTerrain) {
      terrain.baseTerrain = new Terrain(map, state.x, state.y, state.baseTerrain.terrainID);
    }
    restoreTerrain(map, terrain.baseTerrain, state.baseTerrain);
  } else if (terrain.baseTerrain) terrain.baseTerrain = null;
}

function captureUnit(unit: Unit): UnitState {
  return {
    uid: unit.uid,
    unitID: unit.getUnitID(),
    owner: unit.getOwner().getPlayerID(),
    x: unit.x,
    y: unit.y,
    hp: unit.getHp(),
    fuel: unit.fuel,
    ammo1: unit.ammo1,
    ammo2: unit.ammo2,
    hasMoved: unit.hasMoved,
    capturePoints: unit.getCapturePoints(),
    hidden: unit.hidden,
    rank: unit.rank,
    cloaked: unit.cloaked, coUnit: unit.coUnit, customName: unit.customName,
    aiMode: unit.aiMode, aiPriority: unit.aiPriority,
    offensiveBonus: unit.offensiveBonus.map(entry => ({ ...entry })),
    defensiveBonus: unit.defensiveBonus.map(entry => ({ ...entry })),
    movementBonus: unit.movementBonus.map(entry => ({ ...entry })),
    visionBonus: unit.visionBonus.map(entry => ({ ...entry })),
    variables: unit.variables.toJSON(),
    loaded: unit.loaded.map(captureUnit),
  };
}

export function snapshot(game: Game): GameState {
  const { map } = game;
  const buildings: BuildingState[] = [];
  const terrain: TerrainState[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const field = map.getTerrain(x, y);
      terrain.push(captureTerrain(field));
      const building = field.getBuilding();
      if (!building) continue;
      buildings.push({
        x, y,
        buildingID: building.getBuildingID(),
        owner: building.getOwnerID(),
        hp: building.hp,
        fireCount: building.fireCount,
        variables: building.variables.toJSON(),
      });
    }
  }

  return {
    day: game.day,
    currentPlayerIndex: game.currentPlayerIndex,
    over: game.over ? { ...game.over } : null,
    fogMode: map.getGameRules().getFogMode(),
    players: map.players.map(player => ({
      army: player.getArmy(),
      team: player.team,
      funds: player.funds,
      isDefeated: player.isDefeated,
      visionFields: player.visionFields.map(field => ({ ...field })),
    })),
    // The defeat rules latch on and never off — victoryrule_nohq.js only
    // applies to a player who has ever owned an HQ — so a snapshot taken
    // before that happened has to restore the un-armed latch with it.
    victoryRules: map.getGameRules().victoryRuleState(),
    units: map.units.map(captureUnit),
    buildings,
    terrain,
    unitUidCounter: map.getUnitUidCounter(),
  };
}

function restoreUnit(map: GameMap, state: UnitState): Unit {
  const owner = map.getPlayer(state.owner);
  if (!owner) throw new Error(`snapshot references unknown player ${state.owner}`);
  const unit = map.addUnit(state.unitID, owner, state.x, state.y);
  // Identity must survive a restore, or an action referencing a unit becomes
  // meaningless after a rollback.
  map.assignUnitUid(unit, state.uid);
  unit.setHp(state.hp);
  unit.fuel = state.fuel;
  unit.ammo1 = state.ammo1;
  unit.ammo2 = state.ammo2;
  unit.hasMoved = state.hasMoved;
  unit.setCapturePoints(state.capturePoints);
  unit.hidden = state.hidden;
  unit.rank = state.rank;
  unit.cloaked = state.cloaked;
  unit.coUnit = state.coUnit;
  unit.customName = state.customName;
  unit.aiMode = state.aiMode;
  unit.aiPriority = state.aiPriority;
  for (const key of ['offensiveBonus', 'defensiveBonus', 'movementBonus', 'visionBonus'] as const) {
    unit[key].splice(0, unit[key].length, ...state[key].map(entry => ({ ...entry })));
  }
  unit.variables.fromJSON(state.variables);
  for (const carried of state.loaded) {
    // Carried units are not on the board, so build them without registering.
    const inner = restoreUnit(map, carried);
    map.removeUnit(inner);
    unit.loaded.push(inner);
  }
  return unit;
}

export function restore(game: Game, state: GameState): void {
  // Cancel provisional moves against the branch board before replacing it.
  game.cancelAction();
  game.cancelUnloadMove();
  const { map } = game;

  game.day = state.day;
  game.currentPlayerIndex = state.currentPlayerIndex;
  game.over = state.over ? { ...state.over } : null;
  map.currentPlayerIndex = state.currentPlayerIndex;
  map.getGameRules().setFogMode(state.fogMode);
  game.clearSelection();

  state.players.forEach((playerState, index) => {
    const player = map.getPlayer(index);
    if (!player) return;
    player.setArmy(playerState.army);
    player.team = playerState.team;
    player.funds = playerState.funds;
    player.isDefeated = playerState.isDefeated;
    player.visionFields.splice(0, player.visionFields.length,
      ...(playerState.visionFields ?? []).map(field => ({ ...field })));
    player.units.length = 0;
  });

  map.getGameRules().setVictoryRuleState(state.victoryRules);

  map.units.length = 0;
  for (const unitState of state.units) restoreUnit(map, unitState);

  // Restore all tiles, including plasma and other non-destructible terrain
  // affected by scripted destruction. Also remove buildings created in a branch.
  const buildingTiles = new Set(state.buildings.map(building => `${building.x},${building.y}`));
  for (const terrainState of state.terrain) {
    const field = map.getTerrain(terrainState.x, terrainState.y);
    restoreTerrain(map, field, terrainState);
    if (field.building && !buildingTiles.has(`${terrainState.x},${terrainState.y}`)) field.building = null;
  }

  for (const buildingState of state.buildings) {
    const terrain = map.getTerrain(buildingState.x, buildingState.y);
    let building = terrain.getBuilding();
    if (!building || building.getBuildingID() !== buildingState.buildingID) {
      building = new BuildingHost(map, buildingState.buildingID, null);
      building.setTerrain(terrain);
      terrain.building = building;
      building.init();
    }
    building.setOwner(buildingState.owner >= 0 ? map.getPlayer(buildingState.owner) ?? null : null);
    building.hp = buildingState.hp;
    building.fireCount = buildingState.fireCount;
    building.variables.fromJSON(buildingState.variables);
  }

  // After the units, because restoreUnit's assignUnitUid raises the counter to
  // fit each uid it restores.
  //
  // IRON_ACCORD_LEGACY_UIDS reproduces the pre-fix numbering, where the counter
  // was left inflated by every restore (each restored unit's constructor takes
  // a fresh uid before assignUnitUid overwrites it, so a reset roughly doubled
  // it). Replays recorded before the fix reference those inflated uids, so they
  // are only reproducible with it set. New data never needs it, and correctness
  // is the default: without the rewind, a search that imagines building a unit
  // permanently shifts the identity of the next one the game really builds.
  if (typeof process === 'undefined' || !process.env.IRON_ACCORD_LEGACY_UIDS) {
    map.setUnitUidCounter(state.unitUidCounter);
  }

  map.vision.update();
}

/** Runs `explore` from the current state and rewinds afterwards. */
export function withRollback<T>(game: Game, explore: () => T): T {
  const saved = snapshot(game);
  try {
    return explore();
  } finally {
    restore(game, saved);
  }
}
