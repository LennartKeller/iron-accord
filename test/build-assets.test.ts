import { describe, expect, it } from 'vitest';
import config from '../vite.config.ts';

type Asset = { type: 'asset'; fileName: string; source: string | Uint8Array };
type Bundle = Record<string, Asset>;
type BuildPlugin = {
  name: string;
  generateBundle: (this: { emitFile(asset: Asset): void; error(message: string): never }, options: object, bundle: Bundle) => void;
};
const plugins = config.plugins as BuildPlugin[];
function emitFrom(name: string, bundle: Bundle = {}): Asset[] {
  const assets: Asset[] = [];
  plugins.find(plugin => plugin.name === name)!.generateBundle.call({
    emitFile: asset => { assets.push(asset); bundle[asset.fileName] = asset; },
    error: message => { throw new Error(message); },
  }, {}, bundle);
  return assets;
}

describe('production assets', () => {
  it('ships runtime data without copying training runs from the public directory', () => {
    expect(config.build?.copyPublicDir).toBe(false);
    const assets = emitFrom('iron-accord:runtime-data');
    expect(assets.some(asset => asset.fileName === 'scripts.json')).toBe(true);
    for (const directory of ['scenes', 'sprites', 'colortables']) {
      expect(assets.some(asset => asset.fileName === `${directory}/index.json`)).toBe(true);
    }
    expect(assets.every(asset => /^(scripts\.json$|scenes\/|sprites\/|colortables\/)/.test(asset.fileName))).toBe(true);
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
