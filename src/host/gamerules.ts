import { GameEnums } from './enums.ts';

/** Defaults mirror game/gamerules.h member initialisers. */
export class GameRules {
  damageFormula: number = GameEnums.DamageFormula_AdvanceWars1_3;
  terrainDefense = 10;        // gamerules.h: quint8 m_terrainDefense{10}
  hpDefenseReduction = true;  // gamerules.h: bool m_hpDefenseReduction{true}
  rankingSystem = false;
  shipBridges = true;         // gamerules.h: bool m_shipBridges{true}
  fogMode: number = GameEnums.Fog_Off;   // gamerules.h: m_FogMode{Fog_Off}

  getDamageFormula(): number { return this.damageFormula; }
  setDamageFormula(value: number): void { this.damageFormula = value; }
  getTerrainDefense(): number { return this.terrainDefense; }
  setTerrainDefense(value: number): void { this.terrainDefense = value; }
  getHpDefenseReduction(): boolean { return this.hpDefenseReduction; }
  getRankingSystem(): boolean { return this.rankingSystem; }
  getShipBridges(): boolean { return this.shipBridges; }
  getFogMode(): number { return this.fogMode; }
  /**
   * Optional named rules a map can switch on. Returning undefined means "not
   * set", which is what the scripts test for.
   */
  getGameRule(_id: string): undefined { return undefined; }
  getMoveVision(): boolean { return false; }
  getSpecialDestruction(): boolean { return false; }
  getParallelCos(): boolean { return false; }
  /** gamerules.h: m_buildingVision{0} — a building lights only its own tile. */
  buildingVision = 0;
  getBuildingVision(): number { return this.buildingVision; }
  getResellValue(): number { return 0; }
  getTransporterRefresh(): boolean { return false; }
  getPowerGainMode(): number { return 0; }
  getPowerLoose(): number { return 0; }
  getPowerUsageReduction(): number { return 0; }
  getMapPalette(): number { return 0; }
  getRandomWeather(): boolean { return false; }
  getWeatherPrediction(): boolean { return false; }
  unitLimit = 0;
  getUnitLimit(): number { return this.unitLimit; }
  getBuildingLimit(): number { return 0; }
  getCoUnits(): boolean { return false; }
  getPowerGainZone(): number { return 0; }
  getDayToDayScreen(): boolean { return false; }
  getSingleUnitInfo(): boolean { return false; }
  setFogMode(value: number): void { this.fogMode = value; }
  /** Weather is not implemented; a neutral stand-in that answers the full API. */
  getCurrentWeather() {
    return {
      getDefensiveModifier: () => 0,
      getOffensiveModifier: () => 0,
      getWeatherId: () => 'WEATHER_SUNNY',
      getWeatherName: () => 'Sunny',
      getVisionRangeModifier: () => 0,
      getMovementCostModifier: () => 0,
    };
  }
}
