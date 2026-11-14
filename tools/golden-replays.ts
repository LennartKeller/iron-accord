/**
 * Checks or regenerates the golden replays (see src/ai/golden.node.ts).
 *
 *   node tools/golden-replays.ts            check the fixture against this engine
 *   node tools/golden-replays.ts --update   report what changed, then re-record
 *   node tools/golden-replays.ts --coverage what the recorded games exercise
 *
 * `npm test` runs the same check. Use --update only when a rules change is
 * intended: it first prints where every existing game departs, so what is being
 * accepted is visible, and only then replaces the fixture.
 *
 * Re-recording plays the agents afresh, so a change to an AGENT also changes
 * the regenerated games. That is harmless — verification replays the recorded
 * actions and never runs an agent — but it means the fixture should be
 * regenerated for engine changes, not on a whim.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import {
  HeuristicAgent, NormalAi, CoordinatedAi, RandomAgent, playMatch, applyAction,
  type Agent, type ActionDescriptor,
} from '../src/ai/index.ts';
import {
  GOLDEN_FORMAT, GOLDEN_PATH, openGame, traceGame, verifyGame, describeMismatch, readGolden, writeGolden,
  type GoldenGame, type GoldenSpec, type GoldenFile,
} from '../src/ai/golden.node.ts';
import { fingerprintState } from '../src/game/fingerprint.ts';
import { GameEnums } from '../src/host/index.ts';

const runtime = bootstrap();

/**
 * Maps chosen for what they exercise, not for balance: transports and navies,
 * pre-deployed armies that fight on day one, and the rarer rules — silos,
 * pipes and welds, meteors and plasma, flares, stealth, concealing terrain.
 */
const MAPS = [
  'maps/pre_deployed/Coast Assault.map',
  'maps/pre_deployed/Missile.map',
  'maps/pre_deployed/Plasma Bubble.map',
  'maps/pre_deployed/8-Bridge Isles.map',
  'maps/pre_deployed/Resistance.map',
  'maps/pre_deployed/Pointing River.map',
  'maps/pre_deployed/Ocean Prison.map',
  'maps/2_player/Pipes Aplenty.map',
  'maps/2_player/Marching Map.map',
  'maps/2_player/Precipitation.map',
  'maps/2_player/Burger Isle.map',
  'maps/2_player/Snowflake.map',
  'maps/2_player/Mouse Island.map',
  'maps/2_player/MELON LAND.map',
  'maps/2_player/Feline Basin.map',
  'maps/2_player/Dual River.map',
  'maps/2_player/Metro Map.map',
  'maps/2_player/SABRE RANGE.map',
  'maps/2_player/Center River.map',
  'maps/2_player/Marengo.map',
];

/** Seat line-ups. The random agent is here for the odd actions nothing sensible plays. */
const PAIRINGS = [
  ['heuristic', 'heuristic'],
  ['normalai', 'heuristic'],
  ['random', 'heuristic'],
  ['normalai', 'normalai'],
  ['coordinated', 'normalai'],
  ['heuristic', 'random'],
];

/** Mostly the two modes training uses, with shroud and mist kept honest. */
const FOGS = [
  GameEnums.Fog_Off, GameEnums.Fog_OfWar, GameEnums.Fog_Off, GameEnums.Fog_OfWar,
  GameEnums.Fog_OfShroud, GameEnums.Fog_Off, GameEnums.Fog_OfWar, GameEnums.Fog_OfMist,
  GameEnums.Fog_OfWar, GameEnums.Fog_Off, GameEnums.Fog_OfWar,
];
const FOG_NAMES = ['off', 'war', 'shroud', 'mist'];

const GAMES_PER_MAP = 2;
const MAX_DAYS = 12;

function specs(): GoldenSpec[] {
  const list: GoldenSpec[] = [];
  let index = 0;
  for (const map of MAPS) {
    for (let game = 0; game < GAMES_PER_MAP; game++, index++) {
      // Periods 6 and 11 are coprime, so line-ups and fog modes combine freely.
      const agents = PAIRINGS[index % PAIRINGS.length];
      const fog = FOGS[index % FOGS.length];
      list.push({
        label: `${path.basename(map, '.map')} / ${agents.join(' v ')} / fog ${FOG_NAMES[fog]}`,
        map, fog, seed: 1000 + index, maxDays: MAX_DAYS, agents,
      });
    }
  }
  return list;
}

function agentFor(name: string, seed: number): Agent {
  if (name === 'random') return new RandomAgent(seed);
  if (name === 'normalai') return new NormalAi({ seed });
  if (name === 'coordinated') return new CoordinatedAi({ seed });
  // Epsilon-greedy, as the training games are: it wanders off the main line.
  return new HeuristicAgent({}, 'heuristic', { epsilon: 0.15, topK: 3, seed });
}

async function record(spec: GoldenSpec): Promise<GoldenGame> {
  const { game, env } = openGame(runtime, spec);
  const actions: ActionDescriptor[] = [];
  await playMatch(env, spec.agents.map((name, seat) => agentFor(name, spec.seed * 31 + seat + 1)), {
    maxSteps: 6000,
    onStep: (_step, action) => { actions.push(action); },
  });
  const live = fingerprintState(game, runtime.rng.getState());

  // A golden must be a game that replays: otherwise it pins nothing.
  const trace = traceGame(runtime, spec, actions);
  if (trace.refused.length > 0) {
    throw new Error(`${spec.label}: ${trace.refused.length} recorded actions were refused on replay, first ` +
      JSON.stringify(actions[trace.refused[0]]));
  }
  if (trace.states[trace.states.length - 1] !== live) {
    throw new Error(`${spec.label}: the replay does not end in the position the live game ended in`);
  }
  return { ...spec, actions, states: trace.states.join(''), legal: trace.legal, winner: trace.winner, days: trace.days };
}

/** What the recorded games actually exercise, so a thin fixture is visible. */
function coverage(golden: GoldenFile): void {
  const actions = new Map<string, number>();
  const built = new Set<string>();
  const fogs = new Map<string, number>();
  let ambushes = 0, structures = 0, decided = 0, total = 0;
  const bump = (key: string) => actions.set(key, (actions.get(key) ?? 0) + 1);

  for (const recorded of golden.games) {
    const { game } = openGame(runtime, recorded);
    fogs.set(FOG_NAMES[recorded.fog], (fogs.get(FOG_NAMES[recorded.fog]) ?? 0) + 1);
    for (const action of recorded.actions) {
      total++;
      if (action.kind === 'endTurn') { game.endTurn(); bump('endTurn'); continue; }
      if (action.kind === 'build') { built.add(action.unitId); bump('build'); }
      else if (action.kind === 'building') bump(`building:${action.actionId}`);
      else {
        bump(action.actionId);
        if (action.target && !game.map.getUnitAt(action.target.x, action.target.y)) structures++;
      }
      const unit = action.kind === 'unit' ? game.map.getUnitByUid(action.uid) : null;
      applyAction(game, action);
      // Still on the board but not where it was sent: a hidden enemy stopped it.
      if (unit && action.kind === 'unit' && game.map.units.includes(unit)
          && (unit.x !== action.to.x || unit.y !== action.to.y)) ambushes++;
    }
    if (game.over) decided++;
  }

  console.log(`\n${golden.games.length} games, ${total} actions, ${decided} decided before day ${MAX_DAYS + 1}`);
  console.log(`fog modes: ${[...fogs].map(([name, n]) => `${name} ${n}`).join(', ')}`);
  console.log(`ambushes ${ambushes}, attacks on structures ${structures}, unit types built ${built.size}`);
  console.log('actions: ' + [...actions].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id} ${n}`).join(', '));
}

function check(golden: GoldenFile): number {
  let failed = 0;
  for (const recorded of golden.games) {
    const mismatch = verifyGame(runtime, recorded);
    if (!mismatch) continue;
    failed++;
    console.log(`\n${describeMismatch(mismatch, recorded).split('\n').slice(0, 4).join('\n')}`);
  }
  return failed;
}

function submoduleCommit(): string {
  try { return execFileSync('git', ['-C', cwRoot(), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}

const mode = process.argv[2] ?? '--check';
const existing = fs.existsSync(GOLDEN_PATH) ? readGolden() : null;

if (mode === '--update') {
  if (existing) {
    const failed = check(existing);
    console.log(`\n${failed} of ${existing.games.length} existing golden games no longer reproduce.`);
    const now = submoduleCommit();
    if (existing.header.commanderWars !== now) {
      console.log(`Commander_Wars submodule moved: ${existing.header.commanderWars} -> ${now}`);
    }
  }
  const games: GoldenGame[] = [];
  for (const spec of specs()) games.push(await record(spec));
  const golden: GoldenFile = {
    header: {
      format: GOLDEN_FORMAT, commanderWars: submoduleCommit(), games: games.length,
      actions: games.reduce((sum, game) => sum + game.actions.length, 0),
    },
    games,
  };
  writeGolden(golden);
  coverage(golden);
  console.log(`\nwrote ${path.relative(process.cwd(), GOLDEN_PATH)} (${(fs.statSync(GOLDEN_PATH).size / 1024).toFixed(0)} KB)`);
} else if (!existing) {
  console.log(`no fixture at ${GOLDEN_PATH}; run with --update to record one`);
  process.exitCode = 1;
} else if (mode === '--coverage') {
  coverage(existing);
} else {
  const failed = check(existing);
  console.log(failed === 0
    ? `all ${existing.games.length} golden games reproduce (${existing.header.actions} actions)`
    : `\n${failed} of ${existing.games.length} golden games no longer reproduce`);
  process.exitCode = failed === 0 ? 0 : 1;
}
