/**
 * Navigation probes for docs/cw-ai-fidelity-audit-2026-09-10.md.
 * Uses actual hosted scripts and explicit source-derived expected results.
 * expectedIslands translates upstream's sweep/relabel algorithm; this does
 * not execute the native C++ engine. Run: node tools/audit-cw-navigation.mjs
 */
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { Unit } from '../src/host/index.ts';
import { Game } from '../src/game/game.ts';
import { IslandMap } from '../src/ai/cw/islandmap.ts';
import { TargetedUnitPathFindingSystem } from '../src/ai/cw/targetedpfs.ts';
import { CoreAI } from '../src/ai/cw/coreai.ts';
import { moveToSafety, getMoveTargetField } from '../src/ai/cw/movement.ts';
import { createUnitData } from '../src/ai/cw/unitdata.ts';
import { NORMAL_AI_DEFAULTS } from '../src/ai/cw/config.ts';
const { createMap, registry } = bootstrap();
function expectedIslands(map, id, owner) {
    const a = Array(map.width * map.height).fill(-1), probe = new Unit(map, id, owner, 0, 0);
    let island = 0;
    for (let x = 0; x < map.width; x++)
        for (let y = 0; y < map.height; y++) {
            const at = y * map.width + x;
            if (a[at] >= 0 || !probe.canMoveOver(x, y))
                continue;
            const seen = new Set([at]), q = [at];
            for (let i = 0; i < q.length; i++) {
                const k = q[i], cx = k % map.width, cy = Math.floor(k / map.width);
                a[k] = island;
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const nx = cx + dx, ny = cy + dy, n = ny * map.width + nx;
                    if (map.onMap(nx, ny) && !seen.has(n) && probe.getMovementCosts(nx, ny, cx, cy) >= 0) {
                        seen.add(n);
                        q.push(n);
                    }
                }
            }
            island++;
        }
    return a;
}
{
    const board = [
        ['PLAINS', 'SEA', 'SEA', 'SEA', 'BEACH'],
        ['SEA', 'SEA', 'SEA', 'SEA', 'SEA'],
        ['SEA', 'SEA', 'BEACH', 'PLAINS', 'SEA'],
        ['PLAINS', 'PLAINS', 'SEA', 'SEA', 'SEA'],
        ['BEACH', 'BEACH', 'SEA', 'BEACH', 'SEA'],
    ];
    const map = createMap(5, 5, 'SEA'), p = map.addPlayer('os');
    for (let x = 0; x < 5; x++)
        for (let y = 0; y < 5; y++)
            map.setTerrainID(x, y, board[y][x]);
    const actualMap = new IslandMap(map, 'HOVERCRAFT', p);
    const actual = Array.from({ length: 25 }, (_, i) => actualMap.getIsland(i % 5, Math.floor(i / 5)));
    const expected = expectedIslands(map, 'HOVERCRAFT', p);
    console.log(JSON.stringify({ case: 'island asymmetry', board, actual, expected }));
}
{
    const map = createMap(2, 1, 'PLAINS'), p = map.addPlayer('os'), u = map.addUnit('INFANTRY', p, 0, 0);
    const pfs = new TargetedUnitPathFindingSystem(map, u, [{ x: 1, y: 0, z: 1 }]);
    console.log(JSON.stringify({ case: 'leaf target', actual: pfs.getReachableTargetField(3), upstreamByControlFlow: { x: -1, y: -1 } }));
}
{
    const map = createMap(6, 1, 'PLAINS'), p = map.addPlayer('os'), u = map.addUnit('INFANTRY', p, 0, 0), game = new Game(map, registry), ai = new CoreAI(game, p, NORMAL_AI_DEFAULTS);
    const data = createUnitData(u, false, 2, [], 0, true);
    const context = { ai, ownUnits: [data], enemyUnits: [], influence: { getInfluenceInfo() { return { getEnemyInfluence() { return 0; }, getOwnInfluence() { return 0; } }; } }, targetOptions: {} };
    console.log(JSON.stringify({ case: 'safety budget', actual: moveToSafety(context, data, { x: 5, y: 0 }, [], [], 3), upstreamExpectedX: 3 }));
    console.log(JSON.stringify({ case: 'move target cost semantics', actual: getMoveTargetField(context, data, [{ x: 4, y: 0 }, { x: 3, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 }], [], [], 3), upstreamExpectedIndex: 0 }));
}
{
    const { hasTargets } = await import('../src/ai/cw/movement.ts');
    const { TargetDistance, hasCaptureTarget } = await import('../src/ai/cw/transport.ts');
    const map = createMap(6, 1, 'PLAINS'), p = map.addPlayer('os'), u = map.addUnit('INFANTRY', p, 0, 0), game = new Game(map, registry), ai = new CoreAI(game, p, NORMAL_AI_DEFAULTS);
    const idx = ai.getIslandIndex(u), island = ai.getIsland(u);
    const empty = hasTargets(ai, 6, u, true, [], [], idx, island);
    map.getTerrain(1, 0).loadBuilding('TOWN');
    const b = map.getTerrain(1, 0).getBuilding();
    const close = hasTargets(ai, 6, u, true, [], [b], idx, island);
    console.log(JSON.stringify({ case: 'reversed enum', TargetDistance, noTargets: empty, closeCapture: close, expectedNoTargets: false, expectedCloseCapture: true }));
}
{
    const map = createMap(10, 5, 'PLAINS'), p = map.addPlayer('os'), e = map.addPlayer('bm');
    e.team = 1;
    map.getTerrain(5, 2).loadBuilding('ZMINICANNON_W');
    const b = map.getTerrain(5, 2).getBuilding();
    b.setOwner(e);
    const game = new Game(map, registry), ai = new CoreAI(game, p, NORMAL_AI_DEFAULTS);
    console.log(JSON.stringify({ case: 'missing cannon danger', damage: b.getDamage(null), targetKind: b.getBuildingTargets(), fireCount: b.getFireCount(), fields: b.getActionTargetFields()?.length, nonzeroMoveCosts: Array.from(ai.moveCostMap).filter(v => v !== 0).length }));
}
