import { GameMap, Unit, BuildingHost } from '../host/index.ts';
import type { Game } from './game.ts';

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
}

export interface PlayerState {
  army: string;
  team: number;
  funds: number;
  isDefeated: boolean;
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
  /** Only buildings whose mutable state can change; terrain ids never do. */
  buildings: BuildingState[];
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
    variables: unit.variables.toJSON(),
    loaded: unit.loaded.map(captureUnit),
  };
}

export function snapshot(game: Game): GameState {
  const { map } = game;
  const buildings: BuildingState[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const building = map.getTerrain(x, y).getBuilding();
      if (!building) continue;
      buildings.push({
        x, y,
        buildingID: building.getBuildingID(),
        owner: building.getOwnerID(),
        hp: building.hp,
        fireCount: building.fireCount,
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
    })),
    // The defeat rules latch on and never off — victoryrule_nohq.js only
    // applies to a player who has ever owned an HQ — so a snapshot taken
    // before that happened has to restore the un-armed latch with it.
    victoryRules: map.getGameRules().victoryRuleState(),
    units: map.units.map(captureUnit),
    buildings,
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
    player.units.length = 0;
  });

  map.getGameRules().setVictoryRuleState(state.victoryRules);

  map.units.length = 0;
  for (const unitState of state.units) restoreUnit(map, unitState);

  // Buildings are placed by the map; only ownership and condition are restored.
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
