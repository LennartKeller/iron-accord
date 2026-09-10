/**
 * Diagnostic reproductions for docs/cw-ai-fidelity-audit-2026-09-10.md.
 * Run with: node tools/audit-cw-ai.ts
 *
 * These inspect the port's internal decision stages and compare selected values
 * with source-derived expectations. They do not execute the native C++ AI and
 * are not a claim of full differential coverage. Private access is intentional
 * here so the gameplay API need not expose instrumentation.
 */
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { GameEnvironment } from '../src/ai/environment.ts';
import { NormalAi } from '../src/ai/cw/normalai.ts';
import { createUnitData } from '../src/ai/cw/unitdata.ts';
import { calcFundsDamage } from '../src/ai/cw/damage.ts';
import { Game } from '../src/game/game.ts';
import { calculateCounterDamage, getOwnSupportDamage } from '../src/ai/cw/scoring.ts';
{
    const { createMap, registry, rng } = bootstrap();
    const map = createMap(8, 5, 'PLAINS');
    const player = map.addPlayer('os'), enemy = map.addPlayer('bm');
    player.team = 0;
    enemy.team = 1;
    const tank = map.addUnit('LIGHT_TANK', player, 2, 2);
    map.addUnit('INFANTRY', enemy, 3, 2);
    map.addUnit('LIGHT_TANK', enemy, 2, 3);
    const env = new GameEnvironment(map, registry, { rng });
    const ai: any = new NormalAi({ seed: 4 });
    ai.beginTurn(env);
    ai.refresh(env.game, player);
    const scores = env.game.attackTargets(tank, tank).map(target => {
        const damage = ai.core.predictor.calcVirtualUnitDamage(tank, 0, tank, target.unit, 0, target);
        return { unit: target.unit?.unitID, x: target.x, y: target.y, damage: damage.x, ...calcFundsDamage(damage, tank, target.unit!, ai.config.ownUnitValue) };
    });
    console.log(JSON.stringify({ scores, moveFollowup: ai.bestShotFrom(env.game, createUnitData(tank, false, 2, [], 0, true), tank) }, null, 2));
    const map2 = createMap(8, 5, 'PLAINS');
    const p = map2.addPlayer('os'), e = map2.addPlayer('bm');
    p.team = 0;
    e.team = 1;
    const carrier = map2.addUnit('APC', p, 1, 2);
    const cargo = map2.addUnit('INFANTRY', p, 0, 2);
    map2.removeUnit(cargo);
    carrier.loaded.push(cargo);
    map2.addUnit('INFANTRY', e, 7, 2);
    const env2 = new GameEnvironment(map2, registry, { rng });
    const ai2: any = new NormalAi({ seed: 4 });
    ai2.beginTurn(env2);
    const trace: string[] = [];
    for (const name of ['captureBuildings', 'joinCaptureBuildings', 'moveSupport', 'fireWithUnits', 'repairUnits', 'refillUnits', 'moveUnits', 'loadUnits', 'moveTransporters', 'moveAwayFromProduction', 'buildUnits']) {
        const original = ai2[name].bind(ai2);
        ai2[name] = (...args: any[]) => { trace.push(`${name}(${ai2.aiStep})`); return original(...args); };
    }
    const result = await ai2.selectAction(env2);
    console.log(JSON.stringify({ loadedTransport: { unit: carrier.unitID, cargo: carrier.loaded.length }, result, trace, transportCalled: trace.some(x => x.startsWith('moveTransporters(')) }, null, 2));
}
{
    const { registry, createMap } = bootstrap();
    const map = createMap(9, 7), p = map.addPlayer('os'), e = map.addPlayer('bm');
    e.team = 1;
    const own = map.addUnit('INFANTRY', p, 2, 3), enemy = map.addUnit('LIGHT_TANK', e, 5, 3);
    const game = new Game(map, registry);
    const ai: any = new NormalAi({ config: { influenceMultiplier: 0 } });
    ai.beginTurn({ game } as any);
    ai.refresh(game, p);
    const ctx: any = { ai: ai.core, ownUnits: ai.ownUnits, enemyUnits: ai.enemyUnits, influence: ai.influence, targetOptions: ai.targetOptions() };
    console.log('enemy range', ai.enemyUnits.map((d: any) => d.range));
    console.log('enemy influence on own tile', ai.influence.getInfluenceInfo(5, 3).getEnemyInfluence());
    console.log('counter before', calculateCounterDamage(ctx, ai.ownUnits[0], { x: 2, y: 3 }, null, 0, [], [], true));
    ai.enemyUnits[0] = createUnitData(enemy, true, ai.config.influenceUnitRange, ai.ownUnits, 0, false);
    ctx.enemyUnits = ai.enemyUnits;
    console.log('corrected enemy range size', ai.enemyUnits[0].range?.tiles.size);
    console.log('counter after populated own data', calculateCounterDamage(ctx, ai.ownUnits[0], { x: 2, y: 3 }, null, 0, [], [], true));
    ai.influence.addUnitInfluence(enemy, ai.enemyUnits[0].range, ai.enemyUnits[0].movementPoints);
    ai.influence.updateOwners();
    console.log('enemy influence after populated own data', ai.influence.getInfluenceInfo(5, 3).getEnemyInfluence());
    map.removeUnit(enemy);
    const foe = map.addUnit('INFANTRY', e, 3, 3);
    const friend = map.addUnit('INFANTRY', p, 2, 2);
    ai.refresh(game, p);
    ctx.ownUnits = ai.ownUnits;
    ctx.enemyUnits = ai.enemyUnits;
    console.log('support actual', getOwnSupportDamage(ctx, own, { x: 2, y: 3 }, foe));
    const fast = ai.core.predictor.calcUnitDamageFast(friend, foe);
    console.log('upstream fast per target', fast, calcFundsDamage(fast, friend, foe, ai.config.ownUnitValue));
    const { getBestAttackTarget } = await import('../src/ai/cw/scoring.ts');
    const dummyUnit: any = { getX: () => 0, getY: () => 0, getMinRange: () => 1, getCoUnitValue: () => 1000 };
    const dummyContext: any = { ai: { config: { ...ai.config }, map: { getTerrain: (x: number, y: number) => ({ getUnit: () => null, getDefense: () => x === 1 ? 3 : 0 }), onMap: () => false } }, ownUnits: [], enemyUnits: [], influence: { getInfluenceInfo: () => ({ getOwnInfluence: () => 0, getEnemyInfluence: () => 0 }) } };
    console.log('fractional score TS chosen index', getBestAttackTarget(dummyContext, { unit: dummyUnit, unitCosts: 1000, range: { tiles: new Map([['0,0', {}]]) } } as any, [{ x: 1, y: 0, fundsDamage: 100.1, hpDamage: 1, hpDamageDifference: 0 }, { x: 2, y: 0, fundsDamage: 100.9, hpDamage: 1, hpDamageDifference: 0 }], [{ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 1 }], [], []), 'upstream qint32 score tie chooses index 0');
}
