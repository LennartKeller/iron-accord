import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import config, { runtimeDataAssets } from '../vite.config.ts';

type Asset = { type: 'asset'; fileName: string; source: string | Uint8Array };
type Bundle = Record<string, Asset>;
type BuildPlugin = {
  name: string;
  generateBundle: (this: { emitFile(asset: Asset): void; error(message: string): never }, options: object, bundle: Bundle) => void;
};
const plugins = config.plugins as BuildPlugin[];
function emitFrom(name: string | BuildPlugin, bundle: Bundle = {}): Asset[] {
  const assets: Asset[] = [];
  const plugin = typeof name === 'string' ? plugins.find(plugin => plugin.name === name)! : name;
  plugin.generateBundle.call({
    emitFile: asset => { assets.push(asset); bundle[asset.fileName] = asset; },
    error: message => { throw new Error(message); },
  }, {}, bundle);
  return assets;
}

let fixture: string | undefined;
afterEach(() => {
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
  fixture = undefined;
});

describe('production assets', () => {
  it('ships runtime data without copying training runs from the public directory', () => {
    expect(config.build?.copyPublicDir).toBe(false);
    // CI runs tests before build:data. Use a complete, tiny data directory
    // rather than depending on assets left over from a local build.
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-accord-assets-'));
    const runtime = [
      'scripts.json', 'scenes/index.json', 'scenes/example.json',
      'sprites/index.json', 'sprites/infantry.png',
      'colortables/index.json', 'colortables/orange_star.png',
    ];
    for (const file of [...runtime, 'training.jsonl', 'positions/run/data.bin']) {
      const full = path.join(fixture, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, `fixture:${file}`);
    }
    const assets = emitFrom(runtimeDataAssets(fixture) as BuildPlugin);
    expect(assets.map(asset => asset.fileName).sort()).toEqual([...runtime].sort());
    for (const asset of assets) expect(String(asset.source)).toBe(`fixture:${asset.fileName}`);
  });

  it('changes the service-worker version when emitted runtime assets change', () => {
    const version = (source: string) => {
      const assets = emitFrom('iron-accord:pwa-assets', {
        'scripts.json': { type: 'asset', fileName: 'scripts.json', source },
      });
      return String(assets.find(asset => asset.fileName === 'sw.js')!.source);
    };
    expect(version('before')).not.toBe(version('after'));
    expect(version('before')).toBe(version('before'));
    expect(version('before')).not.toContain('__BUILD_ID__');
    const names = plugins.map(plugin => plugin.name);
    expect(names.indexOf('iron-accord:runtime-data')).toBeLessThan(names.indexOf('iron-accord:pwa-assets'));
    expect(names.indexOf('iron-accord-value-net')).toBeLessThan(names.indexOf('iron-accord:pwa-assets'));
  });
});
