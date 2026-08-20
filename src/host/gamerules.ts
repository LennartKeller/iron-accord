import { GameEnums } from './enums.ts';
import { VictoryRule } from './victoryrule.ts';
import type { GameMap } from './gamemap.ts';
import type { Player } from './player.ts';
import type { ScriptRegistry } from '../scripts/types.ts';

/** What checkVictory concluded, if anything. */
export interface VictoryOutcome {
  /** The one team still standing, or -1 if none is (everyone lost). */
  team: number;
  /** The rule that ended it, e.g. VICTORYRULE_NOHQ. */
  ruleID: string | null;
}

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
  // --- victory rules --------------------------------------------------------

  private victoryRules: VictoryRule[] = [];
  /**
   * Rules the .map file specified. The reader leaves the map's rule block in
   * its unparsed tail, so this is always empty today and every game uses the
   * script defaults — no HQ and no units, matching a fresh Commander Wars game.
   */
  private mapVictoryRules: string[] = [];
  private map: GameMap | null = null;
  private registry: ScriptRegistry | null = null;

  /** Late-bound: the map builds its rules before it has finished loading. */
  attach(map: GameMap, registry: ScriptRegistry): void {
    this.map = map;
    this.registry = registry;
  }

  /**
   * Every rule the scripts define, in a stable order. GameRuleManager scans
   * the script folder for these; the loaded registry is the same list.
   */
  availableVictoryRules(): string[] {
    if (!this.registry) return [];
    return Object.keys(this.registry)
      .filter(key => key.startsWith('VICTORYRULE_'))
      .filter(key => typeof (this.registry as Record<string, never>)[key] === 'object')
      .sort();
  }

  addVictoryRule(rule: string): void {
    if (!this.map || !this.registry || this.hasVictoryRule(rule)) return;
    this.victoryRules.push(new VictoryRule(rule, this.map, this.registry));
  }

  hasVictoryRule(rule: string): boolean {
    return this.victoryRules.some(existing => existing.getRuleID() === rule);
  }

  removeVictoryRule(rule: string): void {
    this.victoryRules = this.victoryRules.filter(existing => existing.getRuleID() !== rule);
  }

  getVictoryRule(rule: string): VictoryRule | null {
    return this.victoryRules.find(existing => existing.getRuleID() === rule) ?? null;
  }

  getVictoryRuleSize(): number { return this.victoryRules.length; }
  getVictoryRuleAtIndex(index: number): VictoryRule | null {
    return this.victoryRules[index] ?? null;
  }

  /**
   * objects/ruleselection.cpp — instantiates every known rule and gives it a
   * starting value. A checkbox's first item takes its default only when the
   * map shipped no rules of its own; anything else starts switched off, so a
   * map's own choices are never silently added to.
   */
  createDefaultVictoryRules(): void {
    const shippedWithRules = this.mapVictoryRules.length > 0;
    // Starting a game rebuilds the rule set from scratch; only rules the map
    // itself carried survive, so re-running it re-seeds every rule's state.
    this.victoryRules = this.victoryRules
      .filter(rule => this.mapVictoryRules.includes(rule.getRuleID()));

    for (const ruleID of this.availableVictoryRules()) {
      if (this.hasVictoryRule(ruleID)) continue;
      this.addVictoryRule(ruleID);
      const rule = this.getVictoryRule(ruleID);
      if (!rule) continue;
      const types = rule.getRuleType();
      types.forEach((_type, item) => {
        const isCheckboxHead = types[0] === 'checkbox' && item === 0;
        rule.setRuleValue(
          isCheckboxHead && shippedWithRules ? 0 : rule.getDefaultValue(item), item);
      });
    }
  }

  /**
   * game/gamerules.cpp: GameRules::onGameStart drops the rules that are turned
   * off, rather than asking each one to check its own value. Without this the
   * turn-limit rule reads a limit of zero and defeats everyone on day one.
   */
  onGameStart(): void {
    for (const rule of [...this.victoryRules]) {
      const types = rule.getRuleType();
      const value = rule.getRuleValue(0);
      const disabled = types[0] === 'checkbox'
        ? value === 0
        : types[0] === 'spinbox' ? value <= rule.getInfiniteValue(0) : true;
      if (disabled) this.removeVictoryRule(rule.getRuleID());
    }
  }

  /**
   * game/gamerules.cpp: GameRules::checkVictory. Each rule sweeps every player
   * before the next rule runs, then the surviving *teams* are counted — allies
   * win together.
   */
  checkVictory(currentPlayer: Player | null): VictoryOutcome | null {
    if (!this.map) return null;
    let decidingRule: string | null = null;

    for (const rule of this.victoryRules) {
      for (const player of this.map.players) {
        if (player.isDefeated) continue;
        const defeat = rule.checkDefeat(player);
        if (defeat === GameEnums.DefeatType_Alive) continue;
        if (defeat === GameEnums.DefeatType_Defeated) player.defeatPlayer(null);
        else if (defeat === GameEnums.DefeatType_ByCurrentPlayer) player.defeatPlayer(currentPlayer);
        else if (defeat === GameEnums.DefeatType_Domination) player.defeatPlayer(currentPlayer, true);
        decidingRule = rule.getRuleID();
      }
    }

    const alive = this.map.players.filter(player => !player.isDefeated);
    const teamsAlive = new Set(alive.map(player => player.getTeam()));
    if (teamsAlive.size > 1 || this.map.players.length <= 1) return null;
    return { team: alive[0]?.getTeam() ?? -1, ruleID: decidingRule };
  }

  /** Rule state is entirely in each rule's variables — snapshot fodder. */
  victoryRuleState(): Array<{ ruleID: string; variables: Record<string, unknown> }> {
    return this.victoryRules.map(rule => ({ ruleID: rule.getRuleID(), variables: rule.toJSON() }));
  }

  setVictoryRuleState(state: Array<{ ruleID: string; variables: Record<string, unknown> }>): void {
    this.victoryRules = [];
    for (const entry of state) {
      this.addVictoryRule(entry.ruleID);
      this.getVictoryRule(entry.ruleID)?.fromJSON(entry.variables);
    }
  }

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
