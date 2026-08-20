import fs from 'node:fs';
import path from 'node:path';
import type { ScriptSource } from '../scripts/loader.ts';

/** Root of the vendored Commander_Wars submodule. */
export function cwRoot(): string {
  return process.env.CW_ROOT
    ?? path.resolve(import.meta.dirname, '../../ext/Commander_Wars');
}

export function scriptsRoot(): string {
  return path.join(cwRoot(), 'resources/scripts');
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

/**
 * Base prototypes must be evaluated before the scripts that do
 * `Constructor.prototype = UNIT`. Everything else is order-tolerant thanks to
 * the loader's retry pass.
 */
export const BASE_SCRIPTS = [
  'general/global.js',
  'general/unit.js',
  'general/weapon.js',
  'general/movementtable.js',
  'general/terrain.js',
  'general/action.js',
  'general/building.js',
  'general/co.js',
  'general/Player.js',
  'general/weather.js',
  'general/gamerule.js',
  'general/co_perk.js',
  'general/unitrankingsystem.js',
  'general/victoryrule.js',
  'general/achievement.js',
];

export interface CollectOptions {
  /** Subdirectories of resources/scripts to include beyond the base prototypes. */
  dirs?: string[];
  /** Extra individual files, relative to resources/scripts. */
  files?: string[];
}

export function collectScripts(options: CollectOptions = {}): ScriptSource[] {
  const root = scriptsRoot();
  // Achievements are bookkeeping, but the action scripts call into them on the
  // human-player branch — without them, building a unit or capturing throws.
  const dirs = options.dirs
    ?? ['terrain', 'units', 'weapons', 'movementtables', 'building', 'actions', 'achievements'];
  const read = (rel: string): ScriptSource => ({
    path: rel,
    source: fs.readFileSync(path.join(root, rel), 'utf8'),
  });

  const ordered: string[] = [...BASE_SCRIPTS];

  for (const dir of dirs) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    const rels = walk(full).map(f => path.relative(root, f));
    // __BASE* terrain prototypes before the terrains that extend them.
    ordered.push(...rels.filter(r => /__BASE/i.test(r)));
    ordered.push(...rels.filter(r => !/__BASE/i.test(r)));
  }
  ordered.push(...(options.files ?? []));

  const seen = new Set<string>();
  return ordered.filter(r => !seen.has(r) && seen.add(r)).map(read);
}

export function allScriptFiles(): string[] {
  const root = scriptsRoot();
  return walk(root).map(f => path.relative(root, f));
}
