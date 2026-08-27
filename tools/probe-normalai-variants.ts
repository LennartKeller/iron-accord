/**
 * How strong is a *mutated* NormalAi?
 *
 * Generating from a family of variants only helps if the family still plays
 * competently. Upstream mutates with (chance 1, mutation -1) -- every knob
 * resampled uniformly across its declared range -- and 126 knobs of that could
 * plausibly produce a player worse than random, which would make the generated
 * data worthless rather than diverse.
 *
 *   npx vite-node tools/probe-normalai-variants.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game } from '../src/game/game.ts';
import { GameEnvironment, HeuristicAgent, NormalAi, playMatch } from '../src/ai/index.ts';
import { NORMAL_AI_DEFAULTS } from '../src/ai/cw/config.ts';
import { randomizeConfig } from '../src/ai/cw/ini.ts';
import { GameEnums, Mulberry32 } from '../src/host/index.ts';

const { registry, animations, rng } = bootstrap();
const maps: string[] = JSON.parse(fs.readFileSync('data/heldout-maps.json', 'utf8'));
const variants = Number(process.env.VARIANTS ?? 12);
const chance = Number(process.env.CHANCE ?? 1);
const mutation = Number(process.env.MUTATION ?? -1);

async function duel(file: string, fog: number, seat: number, config: typeof NORMAL_AI_DEFAULTS, seed: number) {
  const map = loadIntoGameMap(readMap(fs.readFileSync(path.join(cwRoot(), file))), registry);
  map.getGameRules().setFogMode(fog);
  const game = new Game(map, registry, animations);
  map.vision.update();
  const env = new GameEnvironment(map, registry, { maxDays: 60, maxFieldChoices: 6, rng, seed }, game);
  env.reset(seed);
  const ai = new NormalAi({ seed, config });
  const agents = seat === 0 ? [ai, new HeuristicAgent()] : [new HeuristicAgent(), ai];
  const result = await playMatch(env, agents, { maxSteps: 6000 });
  return result.winner === null ? 0.5 : (result.winner === seat ? 1 : 0);
}

console.log(`${variants} variants, chance ${chance}, mutation ${mutation}, ` +
  `${maps.length} maps, both fog modes, v greedy\n`);

const rates: number[] = [];
for (let v = 0; v < variants; v++) {
  const source = new Mulberry32(1000 + v);
  const config = v === 0
    ? NORMAL_AI_DEFAULTS   // variant 0 is the shipped profile, as a control
    : randomizeConfig(() => source.next(), chance, mutation, NORMAL_AI_DEFAULTS);
  let score = 0, played = 0;
  for (const file of maps) {
    for (const fog of [GameEnums.Fog_Off, GameEnums.Fog_OfWar]) {
      for (const seat of [0, 1]) {
        score += await duel(file, fog, seat, config, 1);
        played++;
      }
    }
  }
  const rate = score / played;
  rates.push(rate);
  console.log(`variant ${String(v).padStart(2)}${v === 0 ? ' (shipped)' : '         '}  ` +
    `rate ${rate.toFixed(3)}  n=${played}`);
}

const sorted = [...rates].slice(1).sort((a, b) => a - b);
const mean = sorted.reduce((s, r) => s + r, 0) / sorted.length;
console.log(`\nshipped ${rates[0].toFixed(3)}   mutated: ` +
  `min ${sorted[0].toFixed(3)}  median ${sorted[Math.floor(sorted.length / 2)].toFixed(3)}  ` +
  `max ${sorted[sorted.length - 1].toFixed(3)}  mean ${mean.toFixed(3)}`);
