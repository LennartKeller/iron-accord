import type { Rng } from '../host/globals.ts';
import type { Scene } from '../maps/scene.ts';
import { sanitizeConfig, type GameConfig } from './config.ts';
import type { Game } from './game.ts';
import { restore, snapshot, type GameState } from './snapshot.ts';

export const SAVE_KEY = 'iron-accord.autosave.v1';
export interface SavedGame {
  version: 1;
  mapId: string;
  scene: Scene;
  config: GameConfig;
  state: GameState;
  rngState: number;
  savedAt: number;
  agentStates?: Record<string, unknown>;
}
export type SaveStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type SaveReadResult = { status: 'ready'; save: SavedGame }
  | { status: 'empty' | 'invalid' | 'unavailable' };

/** Call only after a committed action, never during AI search or a provisional unload. */
export function createSave(game: Game, scene: Scene, config: GameConfig, rng: Rng, mapId = scene.id, savedAt = Date.now()): SavedGame {
  // Detach scene/config too: a setup dialog must not change an existing save.
  return JSON.parse(JSON.stringify({ version: 1, mapId, scene,
    config: sanitizeConfig(config), state: snapshot(game), rngState: rng.getState(), savedAt })) as SavedGame;
}

const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => number(v) && Number.isInteger(v) && v >= min && v <= max;
const string = (v: unknown): v is string => typeof v === 'string';
const bool = (v: unknown): v is boolean => typeof v === 'boolean';
const array = (v: unknown, check: (entry: any) => boolean): v is any[] => Array.isArray(v) && v.every(check);
const fields = (v: Record<string, any>, keys: string[], check: (entry: any) => boolean) => keys.every(key => check(v[key]));

/** Validate both shape and references before anything reaches the renderer or engine. */
export function isSavedGame(value: unknown): value is SavedGame {
  if (!object(value) || value.version !== 1 || !string(value.mapId) || !integer(value.savedAt)
    || !integer(value.rngState, 0, 0xffffffff)) return false;
  if (value.agentStates !== undefined && !object(value.agentStates)) return false;
  const { scene: s, config: c, state: st } = value;
  if (!object(s) || !object(c) || !object(st)
    || !integer(s.width, 1, 256) || !integer(s.height, 1, 256)
    || !fields(s, ['id', 'name', 'author', 'description', 'category'], string)
    || !array(s.players, p => object(p) && fields(p, ['army', 'color', 'colorTable'], string) && integer(p.team) && number(p.funds))
    || s.players.length < 1 || s.players.length > 16
    || !fields(s, ['spriteIds', 'terrainIds', 'tables'], v => array(v, string)) || !s.terrainIds.length) return false;
  const seats = s.players.length;
  const owner = (v: unknown) => integer(v, 0, seats - 1);
  const point = (v: any) => object(v) && integer(v.x, 0, s.width - 1) && integer(v.y, 0, s.height - 1);
  const refs = (v: unknown) => array(v, ref => Array.isArray(ref) && ref.length === 2 && integer(ref[0], 0, s.spriteIds.length - 1) && integer(ref[1], -1, s.tables.length - 1));
  if (!array(s.terrain, row => Array.isArray(row) && row.length === s.width && row.every(v => integer(v, 0, s.terrainIds.length - 1)))
    || s.terrain.length !== s.height || !array(s.tileSprites, refs) || s.tileSprites.length !== s.width * s.height
    || !array(s.units, u => point(u) && string(u.id) && owner(u.owner) && number(u.hp) && refs(u.sprites))
    || !array(s.buildings, b => point(b) && string(b.id) && integer(b.owner, -1, seats - 1) && refs(b.sprites))) return false;
  if (!['off', 'war', 'shroud'].includes(c.fog) || !fields(c, ['startingFunds', 'fundsModifier', 'unitLimit'], number)
    || !object(c.victoryRules) || !Object.values(c.victoryRules).every(v => array(v, number))
    || !array(c.seats, seat => object(seat) && string(seat.army) && owner(seat.team)
      && ['human', 'ai'].includes(seat.controller) && (seat.agent === undefined || string(seat.agent))) || c.seats.length !== seats) return false;
  if (!integer(st.day, 1) || !owner(st.currentPlayerIndex) || !integer(st.fogMode, 0, 2) || !integer(st.unitUidCounter)
    || !array(st.players, p => object(p) && string(p.army) && owner(p.team) && number(p.funds) && bool(p.isDefeated)
      && array(p.visionFields, f => point(f) && integer(f.duration) && bool(f.directView) && number(f.visionType))) || st.players.length !== seats
    || !array(st.victoryRules, r => object(r) && string(r.ruleID) && object(r.variables))) return false;
  if (st.over !== null && (!object(st.over) || !integer(st.over.winner, -1, seats - 1)
    || !integer(st.over.winningTeam, -1, seats - 1) || !(st.over.ruleID === null || string(st.over.ruleID))
    || !['hq-captured', 'no-units', 'rule'].includes(st.over.reason))) return false;
  const ids = new Set<number>();
  const unit = (u: any, depth = 0): boolean => {
    if (depth > 16 || !object(u) || !integer(u.uid, 1, st.unitUidCounter) || ids.has(u.uid)
      || !string(u.unitID) || !owner(u.owner) || !fields(u, ['x', 'y'], number)
      || !fields(u, ['hp', 'fuel', 'ammo1', 'ammo2', 'capturePoints', 'rank', 'coUnit', 'aiMode', 'aiPriority'], number)
      || !fields(u, ['hasMoved', 'hidden', 'cloaked'], bool) || !string(u.customName) || !object(u.variables)
      || !fields(u, ['offensiveBonus', 'defensiveBonus', 'movementBonus', 'visionBonus'], v => array(v, b => object(b) && number(b.value) && number(b.duration)))) return false;
    ids.add(u.uid);
    return array(u.loaded, child => unit(child, depth + 1));
  };
  const uniquePoints = (entries: any[]) => new Set(entries.map(e => `${e.x},${e.y}`)).size === entries.length;
  const terrain = (t: any, depth = 0): boolean => depth <= 16 && point(t) && string(t.terrainID) && number(t.hp)
    && string(t.palette) && number(t.visionHigh) && object(t.variables)
    && (t.baseTerrain === null || (terrain(t.baseTerrain, depth + 1) && t.baseTerrain.x === t.x && t.baseTerrain.y === t.y));
  return array(st.units, u => point(u) && unit(u)) && uniquePoints(st.units)
    && array(st.buildings, b => point(b) && string(b.buildingID) && integer(b.owner, -1, seats - 1)
      && number(b.hp) && number(b.fireCount) && object(b.variables)) && uniquePoints(st.buildings)
    && array(st.terrain, t => terrain(t)) && st.terrain.length === s.width * s.height && uniquePoints(st.terrain);
}

export function readSave(storage: SaveStorage): SaveReadResult {
  let text: string | null;
  try { text = storage.getItem(SAVE_KEY); } catch { return { status: 'unavailable' }; }
  if (text === null) return { status: 'empty' };
  try {
    const save: unknown = JSON.parse(text);
    return isSavedGame(save) ? { status: 'ready', save } : { status: 'invalid' };
  } catch { return { status: 'invalid' }; }
}
export function writeSave(storage: SaveStorage, save: SavedGame): boolean {
  try {
    if (!isSavedGame(save)) return false;
    storage.setItem(SAVE_KEY, JSON.stringify(save));
    return true;
  } catch { return false; }
}
export function removeSave(storage: SaveStorage): boolean {
  try { storage.removeItem(SAVE_KEY); return true; } catch { return false; }
}

/** Restore into a fresh game made from the saved scene/config, without another beginTurn. */
export function restoreSave(game: Game, rng: Rng, save: SavedGame): void {
  if (!isSavedGame(save) || game.map.width !== save.scene.width || game.map.height !== save.scene.height
    || game.map.players.length !== save.state.players.length) throw new Error('Incompatible saved game');
  const script = (id: string) => { if (!Object.hasOwn(game.registry, id) || !game.registry[id]) throw new Error(`Saved game requires missing script: ${id}`); };
  const units = (entries: GameState['units']) => { for (const u of entries) { script(u.unitID); units(u.loaded); } };
  const terrain = (t: GameState['terrain'][number]) => { script(t.terrainID); if (t.baseTerrain) terrain(t.baseTerrain); };
  units(save.state.units);
  save.state.terrain.forEach(terrain);
  save.state.buildings.forEach(b => script(b.buildingID));
  save.state.victoryRules.forEach(r => script(r.ruleID));
  restore(game, save.state);
  rng.setState(save.rngState);
}
