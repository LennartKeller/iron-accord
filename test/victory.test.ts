import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { loadIntoGameMap } from '../src/maps/loadmap.ts';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { cwRoot } from '../src/cw/resources.node.ts';
import { Game, type GameOptions } from '../src/game/game.ts';
import { describeVictoryRules } from '../src/game/victory.ts';
import { snapshot, restore } from '../src/game/snapshot.ts';
import type { GameMap } from '../src/host/index.ts';

const { registry, animations } = bootstrap();
const source = readMap(fs.readFileSync(path.join(cwRoot(), 'maps/2_player/60-ZWEITER KRIEG.map')));

function newGame(options: GameOptions = {}): { map: GameMap; game: Game } {
  const map = loadIntoGameMap(source, registry);
  return { map, game: new Game(map, registry, animations, options) };
}

const activeRules = (map: GameMap): string[] => {
  const rules = map.getGameRules();
  return Array.from({ length: rules.getVictoryRuleSize() },
    (_, i) => rules.getVictoryRuleAtIndex(i)!.getRuleID());
};

describe('victory rules', () => {
  it('runs the rule scripts rather than a reimplementation', () => {
    // All ten ship in gamerules/victory/; the two Commander Wars defaults to on
    // are the two that survive GameRules::onGameStart.
    const { map } = newGame();
    expect(describeVictoryRules(map, registry)).toHaveLength(10);
    expect(activeRules(map)).toEqual(['VICTORYRULE_NOHQ', 'VICTORYRULE_NOUNITS']);
  });

  it('drops rules that are switched off, keeping their scripts unread', () => {
    // A turn limit of zero is the "off" value. Left in the list it would read
    // a limit of 0, find day 1 past it and defeat everybody immediately.
    const { map, game } = newGame({ victoryRules: { VICTORYRULE_TURNLIMIT: [0, 0] } });
    expect(activeRules(map)).not.toContain('VICTORYRULE_TURNLIMIT');
    expect(game.checkGameOver()).toBeNull();
  });

  it('ends in a draw when an enabled turn limit runs out', () => {
    const { map, game } = newGame({ victoryRules: { VICTORYRULE_TURNLIMIT: [2, 0] } });
    expect(activeRules(map)).toContain('VICTORYRULE_TURNLIMIT');

    for (let i = 0; i < 4 && !game.over; i++) game.endTurn();

    expect(game.day).toBeGreaterThan(2);
    expect(game.over).not.toBeNull();
    expect(game.over!.ruleID).toBe('VICTORYRULE_TURNLIMIT');
    // "All players lose when the time is up" — nobody is left, so no team won.
    expect(game.over!.winningTeam).toBe(-1);
    expect(map.players.every(player => player.isDefeated)).toBe(true);
  });

  it('hands the win to the nominated team when the limit has one', () => {
    // Second item is the winning team, one-based.
    const { map, game } = newGame({ victoryRules: { VICTORYRULE_TURNLIMIT: [2, 2] } });
    for (let i = 0; i < 4 && !game.over; i++) game.endTurn();

    expect(game.over).not.toBeNull();
    expect(game.over!.winningTeam).toBe(1);
    expect(map.getPlayer(0)!.isDefeated).toBe(true);
    expect(map.getPlayer(1)!.isDefeated).toBe(false);
  });

  it('exposes each rule as the setup screen needs it', () => {
    const { map } = newGame();
    const byId = new Map(describeVictoryRules(map, registry).map(info => [info.ruleID, info]));

    const noHq = byId.get('VICTORYRULE_NOHQ')!;
    expect(noHq.items).toEqual([expect.objectContaining({ type: 'checkbox', defaultValue: 1 })]);
    expect(noHq.name).toBe("No HQ's");

    // A spinbox whose default equals its "infinite" value starts switched off.
    const capture = byId.get('VICTORYRULE_BUILDINGLIMIT')!;
    expect(capture.items[0].type).toBe('spinbox');
    expect(capture.items[0].defaultValue).toBe(capture.items[0].infiniteValue);
    expect(byId.get('VICTORYRULE_DOMINATION')!.items).toHaveLength(5);
  });

  it('restores latched rule state with a snapshot', () => {
    // The no-HQ rule only applies to a player who has owned an HQ. Restoring a
    // snapshot from before a capture has to un-arm it again, or exploring a
    // line of play would leak a defeat backwards into the earlier position.
    const { map, game } = newGame();
    const hq = map.getPlayer(1)!.getBuildings('HQ').at(0)!;
    hq.setOwner(null);

    const fresh = new Game(map, registry, animations);
    const before = snapshot(fresh);

    hq.setOwner(map.getPlayer(1) ?? null);      // P2 takes an HQ: rule arms
    fresh.checkGameOver();
    hq.setOwner(map.getPlayer(0) ?? null);      // and loses it again
    expect(fresh.checkGameOver()).not.toBeNull();

    restore(fresh, before);
    expect(fresh.over).toBeNull();
    hq.setOwner(map.getPlayer(0) ?? null);
    expect(fresh.checkGameOver()).toBeNull();   // never armed in this timeline
  });
});
