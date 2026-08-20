import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { allScriptFiles, scriptsRoot } from '../src/cw/resources.node.ts';
import { repairShorthand } from '../src/scripts/repair.ts';
import { NodeEvaluator } from '../src/scripts/evaluator-node.ts';
import { bootstrap, unitIds, weaponIds } from '../src/game/bootstrap.node.ts';

describe('Commander Wars script compatibility', () => {
  it('parses all but the six known base prototypes in V8 unmodified', () => {
    const failures: string[] = [];
    for (const rel of allScriptFiles()) {
      const source = fs.readFileSync(path.join(scriptsRoot(), rel), 'utf8');
      try {
        new vm.Script(source, { filename: rel });
      } catch {
        failures.push(rel);
      }
    }
    // QJSEngine tolerates CoverInitializedName in object literals; V8 does not.
    expect(failures.sort()).toEqual([
      'general/Tagpower.js',
      'general/building.js',
      'general/co.js',
      'general/movementtable.js',
      'general/terrain.js',
      'general/weapon.js',
    ]);
  });

  it('repairs every failing script by rewriting only the offending lines', () => {
    let totalPatched = 0;
    for (const rel of allScriptFiles()) {
      const source = fs.readFileSync(path.join(scriptsRoot(), rel), 'utf8');
      const { source: repaired, patchedLines } = repairShorthand(source, rel, NodeEvaluator.parse);
      totalPatched += patchedLines.length;
      expect(() => new vm.Script(repaired, { filename: rel })).not.toThrow();
    }
    expect(totalPatched).toBeLessThanOrEqual(16);
  });
});

describe('script registry', () => {
  const { registry, report } = bootstrap();

  it('loads every collected script without error', () => {
    expect(report.failed).toEqual([]);
    expect(report.loaded.length).toBeGreaterThan(250);
  });

  it('registers all 63 units and their weapons', () => {
    expect(unitIds(registry)).toHaveLength(63);
    expect(weaponIds(registry).length).toBeGreaterThanOrEqual(50);
  });

  it('preserves the prototype chain the scripts build', () => {
    expect(Object.getPrototypeOf(registry.INFANTRY)).toBe(registry.UNIT);
    expect(Object.getPrototypeOf(registry.FOREST)).toBe(registry.__BASEFOREST);
    expect(Object.getPrototypeOf(registry.__BASEFOREST)).toBe(registry.TERRAIN);
  });

  it('reads unit data straight out of the scripts', () => {
    expect(registry.INFANTRY.getBaseCost()).toBe(1000);
    expect(registry.INFANTRY.getMovementType()).toBe('MOVE_FEET');
  });
});
