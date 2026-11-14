/**
 * Golden replays: recorded games whose every position is pinned.
 *
 * Self-play data is stored as replays, and a value net is only as valid as the
 * rules those replays were played under. In September 2026 two engine fixes
 * silently made half of a month's training games unreplayable — nothing failed,
 * the numbers simply stopped meaning anything. This is the tripwire: a rule
 * change now breaks a test, and accepting it is a deliberate
 * `npm run golden:update`.
 *
 * A golden game is a list of actions plus, per action, a digest of the position
 * that resulted, and per turn a digest of the legal action set. Verification
 * replays the ACTIONS, so it exercises the engine alone: changing an agent does
 * not disturb the goldens, only regenerating them does.
 *
 * Node-only (filesystem, gzip, the Node bootstrap). Never import this from
 * anything the browser reaches.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { readMap } from '../maps/mapreader.ts';
import { loadIntoGameMap } from '../maps/loadmap.ts';
import type { Bootstrapped } from '../game/bootstrap.node.ts';
import { cwRoot } from '../cw/resources.node.ts';
import { Game } from '../game/game.ts';
import {
  fingerprintState, differingSections, fnv1a, FINGERPRINT_LENGTH, type FingerprintSection,
} from '../game/fingerprint.ts';
import { applyAction, type ActionDescriptor } from './actions.ts';
import { GameEnvironment } from './environment.ts';

export const GOLDEN_FORMAT = 1;
export const GOLDEN_PATH = path.resolve(import.meta.dirname, '../../test/fixtures/golden-replays.jsonl.gz');

/** Enumeration settings the legal-action digests are taken under; the self-play ones. */
const ENUMERATE = { maxFieldChoices: 6 };

export interface GoldenSpec {
  /** Unique, human-readable: it names the game in a failure. */
  label: string;
  /** Path below the Commander_Wars submodule. */
  map: string;
  fog: number;
  seed: number;
  maxDays: number;
  /** Who played it, for the record only — verification never runs an agent. */
  agents: string[];
}

export interface GoldenGame extends GoldenSpec {
  actions: ActionDescriptor[];
  /** One fixed-width position digest per action, concatenated. */
  states: string;
  /** Legal-action digest at the start of every turn, as `<count>:<hash>`. */
  legal: string[];
  winner: number | null;
  days: number;
}

export interface GoldenHeader {
  format: number;
  /** Commit of the Commander_Wars submodule the games were recorded against. */
  commanderWars: string;
  games: number;
  actions: number;
}

export interface GoldenFile { header: GoldenHeader; games: GoldenGame[] }

type Runtime = Pick<Bootstrapped, 'registry' | 'animations' | 'rng'>;

const sources = new Map<string, ReturnType<typeof readMap>>();

/** A fresh game for a spec, set up exactly as the self-play workers do. */
export function openGame(runtime: Runtime, spec: GoldenSpec): { game: Game; env: GameEnvironment } {
  let source = sources.get(spec.map);
  if (!source) {
    source = readMap(fs.readFileSync(path.join(cwRoot(), spec.map)));
    sources.set(spec.map, source);
  }
  const map = loadIntoGameMap(source, runtime.registry);
  map.getGameRules().setFogMode(spec.fog);
  const game = new Game(map, runtime.registry, runtime.animations);
  map.vision.update();
  const env = new GameEnvironment(
    map, runtime.registry, { maxDays: spec.maxDays, ...ENUMERATE, rng: runtime.rng, seed: spec.seed }, game);
  env.reset(spec.seed);
  return { game, env };
}

export interface Trace {
  states: string[];
  legal: string[];
  /** Indices of actions the engine refused. */
  refused: number[];
  /** For each entry of `legal`, the index of the action that turn starts at. */
  turnStarts: number[];
  winner: number | null;
  days: number;
}

/** Replays a list of actions and digests every position and every turn's legal set. */
export function traceGame(runtime: Runtime, spec: GoldenSpec, actions: ActionDescriptor[]): Trace {
  const { game, env } = openGame(runtime, spec);
  const digest = () => fingerprintState(game, runtime.rng.getState());

  const legalDigest = (): string => {
    const before = digest();
    const keys = env.legalActions().map(action => JSON.stringify(action)).sort();
    // The AI enumerates constantly; if merely asking what is legal moved the
    // board or drew from the dice, every search would corrupt the real game.
    if (digest() !== before) throw new Error(`${spec.label}: enumerating legal actions changed the position`);
    return `${keys.length}:${fnv1a(keys.join('\n')).toString(16).padStart(8, '0')}`;
  };

  const trace: Trace = { states: [], legal: [legalDigest()], refused: [], turnStarts: [0], winner: null, days: 0 };
  actions.forEach((action, index) => {
    if (!applyAction(game, action)) trace.refused.push(index);
    trace.states.push(digest());
    if (action.kind === 'endTurn') {
      trace.legal.push(legalDigest());
      trace.turnStarts.push(index + 1);
    }
  });
  trace.winner = game.over?.winner ?? null;
  trace.days = game.day;
  return trace;
}

export interface GoldenMismatch {
  label: string;
  kind: 'refused' | 'state' | 'legal' | 'outcome';
  /** Index of the action at (or, for `legal`, before) which the game departs. */
  step: number;
  action: ActionDescriptor | null;
  sections: FingerprintSection[];
  detail: string;
}

/** The earliest point at which the current engine departs from a golden game, or null. */
export function verifyGame(runtime: Runtime, golden: GoldenGame): GoldenMismatch | null {
  const trace = traceGame(runtime, golden, golden.actions);
  const found: GoldenMismatch[] = [];
  const base = { label: golden.label, sections: [] as FingerprintSection[] };

  if (trace.refused.length > 0) {
    const step = trace.refused[0];
    found.push({ ...base, kind: 'refused', step, action: golden.actions[step],
      detail: `the engine refused this action (${trace.refused.length} refused in total)` });
  }

  for (let step = 0; step < trace.states.length; step++) {
    const expected = golden.states.slice(step * FINGERPRINT_LENGTH, (step + 1) * FINGERPRINT_LENGTH);
    if (expected === trace.states[step]) continue;
    const sections = differingSections(expected, trace.states[step]);
    found.push({ ...base, kind: 'state', step, action: golden.actions[step], sections,
      detail: `the position after this action differs in: ${sections.join(', ')}` });
    break;
  }

  for (let turn = 0; turn < trace.legal.length; turn++) {
    if (golden.legal[turn] === trace.legal[turn]) continue;
    const step = trace.turnStarts[turn];
    found.push({ ...base, kind: 'legal', step, action: golden.actions[step] ?? null,
      detail: `the legal actions at the start of turn ${turn + 1} differ: ` +
        `recorded ${golden.legal[turn]}, now ${trace.legal[turn]} (count:hash)` });
    break;
  }

  if (found.length === 0 && (trace.winner !== golden.winner || trace.days !== golden.days)) {
    found.push({ ...base, kind: 'outcome', step: golden.actions.length, action: null,
      detail: `outcome differs: recorded winner ${golden.winner} on day ${golden.days}, ` +
        `now ${trace.winner} on day ${trace.days}` });
  }

  // A legal-set change at a turn start precedes anything played in that turn.
  found.sort((a, b) => a.step - b.step || (a.kind === 'legal' ? -1 : b.kind === 'legal' ? 1 : 0));
  return found[0] ?? null;
}

export function describeMismatch(mismatch: GoldenMismatch, golden: GoldenGame): string {
  return [
    `golden replay "${mismatch.label}" no longer reproduces`,
    `  map ${golden.map}, fog ${golden.fog}, seed ${golden.seed}, agents ${golden.agents.join(' v ')}`,
    `  action ${mismatch.step + 1} of ${golden.actions.length}: ${JSON.stringify(mismatch.action)}`,
    `  ${mismatch.detail}`,
    '',
    'The rules changed. If that was not intended, this is a regression.',
    'If it was, run `npm run golden:update`, review what it reports, and commit the fixture.',
    'Self-play data recorded before such a change is no longer reproducible and must be regenerated.',
  ].join('\n');
}

export function readGolden(file = GOLDEN_PATH): GoldenFile {
  const lines = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').split('\n').filter(Boolean);
  const header = JSON.parse(lines[0]) as GoldenHeader;
  if (header.format !== GOLDEN_FORMAT) {
    throw new Error(`${file} is golden format ${header.format}; this build reads ${GOLDEN_FORMAT}`);
  }
  return { header, games: lines.slice(1).map(line => JSON.parse(line) as GoldenGame) };
}

export function writeGolden(golden: GoldenFile, file = GOLDEN_PATH): void {
  const text = [golden.header, ...golden.games].map(entry => JSON.stringify(entry)).join('\n') + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // No timestamp in the gzip header, so an unchanged engine rewrites identical bytes.
  fs.writeFileSync(file, zlib.gzipSync(text, { level: 9 }));
}
