/**
 * Production/config probes for docs/cw-ai-fidelity-audit-2026-09-10.md.
 * Executes the actual upstream configuration JS after the generator's one-character
 * syntax repair in memory. Host inputs are controlled stubs; mutation uses an
 * explicit translation of the cited C++ arithmetic, not Qt's random generator.
 * Run: node tools/audit-cw-production.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { ProductionSystem } from '../src/ai/cw/production.ts';
import { randomizeConfig } from '../src/ai/cw/ini.ts';
import { NORMAL_AI_DEFAULTS, INI_RANGES } from '../src/ai/cw/config.ts';
const root = new URL('../', import.meta.url);
const raw = fs.readFileSync(new URL('ext/Commander_Wars/resources/aidata/normal/__coreai.js', root), 'utf8');
try {
    new vm.Script(raw);
}
catch (e) {
    console.log('Raw upstream parse:', e.message);
}
const context = vm.createContext({});
vm.runInContext(raw.replace('highPrioBuildings = [', 'highPrioBuildings : ['), context);
const core = context.COREAI;
const vars = { NAVALBATTLE: 0, AIRBATTLE: 1 };
const upstream = {};
const system = { getVariables: () => ({ createVariable: key => ({ readDataInt32: () => vars[key] ?? 0 }) }), addInitialProduction: () => { }, getDummyUnit: () => ({ getBaseMinRange: () => 1 }), addItemToBuildDistribution: (name, ids, chance, distribution) => { upstream[name] = distribution; } };
const player = { getCO: () => null, getCoGroupModifier: () => 1, getFunds: () => 10000 };
const ai = { getPlayer: () => player, getAiCoBuildRatioModifier: () => 1, getUnitBuildValue: () => 1 };
core.initializeSimpleProductionSystem(system, ai, {}, [1, 1, 1, 1]);
const ts = new ProductionSystem(() => 0.25);
ts.initialize(player, [{ isProductionBuilding: () => true, getConstructionList: () => ['INFANTRY', 'LIGHT_TANK', 'K_HELI'] }]);
const actual = Object.fromEntries(ts.saveState().buildDistribution.map(([name, d]) => [name, d.distribution]));
console.log('Same-island air battle weights:', JSON.stringify(Object.fromEntries(['INFANTRY_GROUP', 'LIGHT_TANK_GROUP', 'LIGHT_AMPHIBIOUS_GROUP'].map(key => [key, { upstream: upstream[key], ts: actual[key] }]))));
const calls = [];
core.buildUnitSimpleProductionSystem({ ...system, getCurrentTurnProducedUnitsCounter: () => 0, buildNextUnit: (...args) => { calls.push(args.slice(2)); return true; } }, ai, { getBuildingGroupCount: () => 1 }, {}, {}, {}, { getCurrentDay: () => 1 });
console.log('Upstream day 1 10000 funds one factory buildNextUnit [minMode,maxMode,islandFraction,minCost,maxCost]:', JSON.stringify(calls));
console.log('TS same parameters through NormalAi defaults: minMode=0 maxMode=100 minCost=0 maxCost=10000');
function cpp(chance, rate, random) {
    const c = { ...NORMAL_AI_DEFAULTS };
    for (const r of INI_RANGES) {
        if (random() < chance) {
            if (rate < 0)
                c[r.field] = r.max <= r.min ? r.min : r.min + random() * (r.max - r.min);
            else if (Math.abs(c[r.field]) <= 0.05) {
                const roll = -1 + Math.floor(random() * 3);
                c[r.field] = roll === 0 ? 0 : roll > 0 ? .075 : -.075;
            }
            else {
                const roll = -rate + Math.floor(random() * (2 * rate + 1));
                c[r.field] += (r.max - r.min) * roll;
            }
        }
        if (c[r.field] < r.min)
            c[r.field] = r.min;
        else if (c[r.field] > r.max)
            c[r.field] = r.max;
    }
    return c;
}
for (const [chance, rate, r] of [[0, -1, .75], [1, 10, .75], [1, -1, .75]]) {
    const a = randomizeConfig(() => r, chance, rate), b = cpp(chance, rate, () => r);
    console.log('Mutation', JSON.stringify({ chance, rate, random: r, ownUnitValue: { ts: a.ownUnitValue, cpp: b.ownUnitValue }, cheapUnitValue: { ts: a.cheapUnitValue, cpp: b.cheapUnitValue }, spamInfantryChance: { ts: a.spamInfantryChance, cpp: b.spamInfantryChance } }));
}
