import { describe, it, expect } from 'vitest';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import {
  readGolden, verifyGame, describeMismatch, openGame, type GoldenGame,
} from '../src/ai/golden.node.ts';
import {
  fingerprintState, differingSections, FINGERPRINT_LENGTH, FINGERPRINT_SECTIONS,
} from '../src/game/fingerprint.ts';

const runtime = bootstrap();
const golden = readGolden();

describe('golden replays', () => {
  // The whole point of the fixture: any change to what the rules produce fails
  // here first. See src/ai/golden.node.ts for why, and for how to accept one.
  it.each(golden.games.map(game => [game.label, game] as const))('%s', (_label, game) => {
    const mismatch = verifyGame(runtime, game);
    if (mismatch) throw new Error(describeMismatch(mismatch, game));
  });

  it('carries the games the header promises', () => {
    expect(golden.games.length).toBe(golden.header.games);
    expect(golden.games.reduce((sum, game) => sum + game.actions.length, 0)).toBe(golden.header.actions);
    expect(new Set(golden.games.map(game => game.label)).size).toBe(golden.games.length);
    for (const game of golden.games) {
      expect(game.states.length).toBe(game.actions.length * FINGERPRINT_LENGTH);
    }
  });
});

// A check that cannot fail protects nothing, so each kind of departure is
// provoked on purpose and has to be reported.
describe('golden replay verification', () => {
  const decisive = golden.games.find(game => game.actions.some(a => a.kind === 'unit' && a.actionId === 'ACTION_FIRE'))!;

  it('notices different combat luck', () => {
    const mismatch = verifyGame(runtime, { ...decisive, seed: decisive.seed + 1 });
    expect(mismatch?.kind).toBe('state');
    expect(mismatch?.sections).toContain('rng');
  });

  it('notices a different fog mode before a single action is played', () => {
    const mismatch = verifyGame(runtime, { ...decisive, fog: decisive.fog === 0 ? 1 : 0 });
    expect(mismatch).not.toBeNull();
    expect(mismatch!.step).toBe(0);
  });

  it('notices an action the engine refuses', () => {
    const index = decisive.actions.findIndex(a => a.kind === 'unit');
    const actions = [...decisive.actions];
    // The same order issued twice: the unit is spent the second time.
    actions.splice(index + 1, 0, actions[index]);
    const tampered: GoldenGame = { ...decisive, actions };
    const mismatch = verifyGame(runtime, tampered);
    expect(mismatch?.kind).toBe('refused');
    expect(mismatch?.step).toBe(index + 1);
  });

  it('notices a changed legal action set', () => {
    const legal = [...decisive.legal];
    legal[1] = '0:00000000';
    const mismatch = verifyGame(runtime, { ...decisive, legal });
    expect(mismatch?.kind).toBe('legal');
  });
});

describe('position fingerprint', () => {
  it('attributes a change to the section it belongs to', () => {
    const { game } = openGame(runtime, golden.games[0]);
    const before = fingerprintState(game, 1);
    expect(before.length).toBe(FINGERPRINT_LENGTH);
    expect(fingerprintState(game, 1)).toBe(before);

    game.map.players[0].funds += 1000;
    expect(differingSections(before, fingerprintState(game, 1))).toEqual(['players']);
    game.map.players[0].funds -= 1000;

    const unit = game.map.units[0];
    unit.setHp(unit.getHp() - 1);
    expect(differingSections(before, fingerprintState(game, 1))).toEqual(['units']);
    unit.setHp(unit.getHp() + 1);

    expect(differingSections(before, fingerprintState(game, 2))).toEqual(['rng']);
    expect(fingerprintState(game, 1)).toBe(before);
    expect(FINGERPRINT_SECTIONS).toContain('vision');
  });
});
