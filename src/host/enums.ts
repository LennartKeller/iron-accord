/** Subset of game/GameEnums.h exposed to scripts. Extend as features land. */
export const GameEnums: Record<string, number> = {
  DamageFormula_AdvanceWars4: 0,
  DamageFormula_AdvanceWars1_3: 1,

  LuckDamageMode_Off: 0,
  LuckDamageMode_On: 1,
  LuckDamageMode_Average: 2,
  LuckDamageMode_Min: 3,
  LuckDamageMode_Max: 4,

  Recoloring_None: 0,
  Recoloring_Matrix: 1,
  Recoloring_Table: 2,

  UnitRank_None: 0,
  UnitRank_CO0: 5,
  UnitRank_CO1: 6,

  PowerMode_Off: 0,
  PowerMode_Power: 1,
  PowerMode_Superpower: 2,
  PowerMode_Tagpower: 3,

  AiTurnMode_StartOfDay: 0,
  AiTurnMode_DuringDay: 1,
  AiTurnMode_EndOfDay: 2,

  // game/GameEnums.h — these are ordinals, not a bitmask. Getting them wrong
  // silently breaks terrain autotiling.
  Directions_None: -1,
  Directions_North: 0,
  Directions_NorthEast: 1,
  Directions_East: 2,
  Directions_SouthEast: 3,
  Directions_South: 4,
  Directions_SouthWest: 5,
  Directions_West: 6,
  Directions_NorthWest: 7,
  Directions_All: 8,
  Directions_Direct: 9,
  Directions_Diagnonal: 10,

  // Unit families, used by BUILDING.getRepairTypes and several script rules.
  // Missing values made every type comparison silently fail to match.
  // NOTE: a bitmask, not an ordinal sequence (game/GameEnums.h:178-185).
  UnitType_Ground: 1,
  UnitType_Hovercraft: 2,
  UnitType_Infantry: 4,
  UnitType_Air: 8,
  UnitType_Naval: 16,

  AiTypes_DummyAi: -3,
  AiTypes_MovePlanner: -2,
  AiTypes_ProxyAi: -1,
  AiTypes_Human: 0,
  AiTypes_VeryEasy: 1,
  AiTypes_Normal: 2,
  AiTypes_NormalOffensive: 3,
  AiTypes_NormalDefensive: 4,
  AiTypes_Heavy: 5,
  AiTypes_Closed: 199,
  AiTypes_Open: 200,

  Fog_Off: 0,
  Fog_OfWar: 1,
  Fog_OfShroud: 2,
  Fog_OfMist: 3,

  Alliance_Friend: 0,
  Alliance_Enemy: 1,

  VisionType_Shrouded: 0,
  VisionType_Fogged: 1,
  VisionType_Clear: 2,
  VisionType_Mist: 3,
};

export type LuckDamageMode = number;
export const MAX_UNIT_HP = 10;
