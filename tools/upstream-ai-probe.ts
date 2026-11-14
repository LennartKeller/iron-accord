/**
 * Compares what the real Commander Wars AI was told while it was deciding with
 * what the NormalAi port is told in the same positions.
 *
 *   node tools/upstream-ai-probe.ts <game.rec.gz> <probe.log> [examples]
 *
 * Both files come from one recording made with the probing startup script:
 *
 *   INIT_TEMPLATE=tools/upstream/init.probe.template.js PROBE_LOG=/tmp/probe.log \
 *   OUT_DIR=/tmp CW_APPRUN=... tools/upstream/record.sh "maps/2_player/Mouse Island.map" 0 9
 *
 * The log holds every damage prediction the real game made, by day and player.
 * For each player-turn this replays the port from the recorded position and
 * collects the predictions it asks for. A question both sides asked must get
 * the same answer; where it does not, the port prices a fight differently than
 * the game it copies. That is how the fast-inaccurate threat estimates and the
 * Advance Wars 4 damage formula were found (docs/upstream-differential.md).
 *
 * Only the answers are compared, never which questions were asked: the two AIs
 * roll their own dice, so their turns drift apart after the first action, and a
 * question asked about a unit the other side had already damaged is not the
 * same question. Expect a few such differences among the attack estimates; a
 * rule difference shows as most of them differing.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { readRecord } from '../src/maps/recreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { recordedOptions } from '../src/game/upstream.node.ts';
import { Game } from '../src/game/game.ts';
import { GameEnvironment, NormalAi } from '../src/ai/index.ts';
import type { Unit } from '../src/host/index.ts';

const [recordFile, logFile, examplesArg] = process.argv.slice(2);
if (!recordFile || !logFile) {
  console.log('usage: node tools/upstream-ai-probe.ts <game.rec.gz> <probe.log> [examples]');
  process.exit(1);
}
const wanted = Number(examplesArg ?? 10);
const runtime = bootstrap();
console.warn = () => {};

const answer = (damage: number, counter: number) => `${damage.toFixed(1)} ${counter.toFixed(1)}`;

/** "day player" -> question -> answer, as the real game logged them. */
const upstream = new Map<string, Map<string, string>>();
for (const line of fs.readFileSync(logFile, 'latin1').split('\n')) {
  const match = line.match(/^([VA]) (\d+) (\d+) (.*?) -> (-?[\d.]+) (-?[\d.]+)/);
  if (!match) continue;
  const turn = `${match[2]} ${match[3]}`;
  if (!upstream.has(turn)) upstream.set(turn, new Map());
  upstream.get(turn)!.set(`${match[1]} ${match[4]}`, answer(Number(match[5]), Number(match[6])));
}

// The port asks through the same script function the real game does.
type Predict = (...args: unknown[]) => { x: number; width: number };
const fire = runtime.registry.ACTION_FIRE as unknown as { calcBattleDamage3: Predict };
const original = fire.calcBattleDamage3;
let asked: Map<string, string> | null = null;
fire.calcBattleDamage3 = (...args: unknown[]) => {
  const result = original(...args);
  if (asked) {
    const [, , attacker, , fromX, fromY, defender, x, y] = args as [unknown, unknown, Unit, unknown, number, number, Unit | null, number, number];
    const fast = args[13] === true;
    const who = `${attacker.getUnitID()}@${attacker.getX()},${attacker.getY()} from ${fromX},${fromY}`;
    // The real game names the defender only in a threat estimate.
    const target = fast && defender ? `${defender.getUnitID()}@${defender.getX()},${defender.getY()}` : '-';
    asked.set(`${fast ? 'V' : 'A'} ${who} vs ${target} at ${x},${y}`, answer(result.x, result.width));
  }
  return result;
};

const record = readRecord(zlib.gunzipSync(fs.readFileSync(recordFile)));
const options = recordedOptions(record);
const totals = { V: { same: 0, differ: 0 }, A: { same: 0, differ: 0 } };
const examples: string[] = [];

for (let index = 0; index + 1 < record.snapshots.length; index++) {
  const from = record.snapshots[index];
  const theirs = upstream.get(`${from.day} ${from.player}`);
  if (!theirs) continue;

  const map = loadIntoGameMap(from.map, runtime.registry);
  const rules = map.getGameRules();
  rules.setFogMode(options.fog ?? 0);
  rules.setSpecialDestruction(options.specialDestruction ?? true);
  const game = new Game(map, runtime.registry, runtime.animations, { resume: { day: from.day, currentPlayer: from.player } });
  const env = new GameEnvironment(map, runtime.registry, { maxFieldChoices: 6, rng: runtime.rng, seed: 1 + index }, game);
  runtime.rng.reseed(1 + index);
  const agent = new NormalAi({ seed: 1 + index });

  asked = new Map();
  await agent.beginTurn(env);
  for (let guard = 0; guard < 400 && !game.over && game.currentPlayerIndex === from.player; guard++) {
    const chosen = (await agent.selectAction(env)) ?? { kind: 'endTurn' as const };
    if (chosen.kind === 'endTurn') break;
    env.step(chosen);
  }
  const mine = asked;
  asked = null;

  for (const [question, expected] of theirs) {
    const actual = mine.get(question);
    if (actual === undefined) continue;
    const kind = question[0] as 'V' | 'A';
    if (actual === expected) { totals[kind].same++; continue; }
    totals[kind].differ++;
    if (examples.length < wanted) {
      examples.push(`  day ${from.day} player ${from.player}  ${question}\n      Commander Wars ${expected}   port ${actual}`);
    }
  }
}

console.log(`threat estimates: ${totals.V.same} agree, ${totals.V.differ} differ`);
console.log(`attack estimates: ${totals.A.same} agree, ${totals.A.differ} differ`);
if (examples.length > 0) console.log(`\n(damage counter)\n${examples.join('\n')}`);
process.exit(0);
