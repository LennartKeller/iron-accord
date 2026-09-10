import type { Game } from '../../game/game.ts';
import { GameEnums, type BuildingHost, type GameMap, type Player, type Unit } from '../../host/index.ts';

/** Planning sees apparent occupancy; Game still checks actual collisions when committing. */
export function visibleUnitAt(map: GameMap, player: Player, x: number, y: number): Unit | null {
  const unit = map.getUnitAt(x, y);
  return unit && !unit.isStealthed(player) ? unit : null;
}

/** Structures are public under fog, but not on unexplored shrouded tiles. */
export function isKnownBuilding(building: BuildingHost, player: Player): boolean {
  return building.getOwner() === player
    || player.getFieldVisibleType(building.getX(), building.getY()) !== GameEnums.VisionType_Shrouded;
}

/** Match production eligibility using apparent occupancy; execution still rejects real blockers. */
export function apparentCanProduceAt(game: Game, x: number, y: number): boolean {
  if (game.over || !Number.isInteger(x) || !Number.isInteger(y) || !game.map.onMap(x, y)) return false;
  const building = game.map.getTerrain(x, y).getBuilding();
  if (!building || building.getOwner() !== game.currentPlayer || visibleUnitAt(game.map, game.currentPlayer, x, y)
    || !building.canBuildUnits() || building.getConstructionList().length === 0) return false;
  const limit = game.map.getGameRules().getUnitLimit();
  return limit <= 0 || game.currentPlayer.units.length < limit;
}
