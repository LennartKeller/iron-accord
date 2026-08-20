import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Emits the static PWA files.
 *
 * `publicDir` is pointed at the generated `data/` directory, so files sitting
 * in `web/` that the bundler never imports — the service worker, the manifest,
 * the icons — would otherwise not reach the build output at all.
 */
function pwaAssets(): Plugin {
  const entries = ['sw.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
  return {
    name: 'iron-accord:pwa-assets',
    apply: 'build',
    generateBundle() {
      for (const entry of entries) {
        const source = path.resolve('web', entry);
        if (!fs.existsSync(source)) continue;
        this.emitFile({ type: 'asset', fileName: entry, source: fs.readFileSync(source) });
      }
    },
  };
}

/**
 * `base` must match the path the site is served from. A GitHub Pages project
 * site lives at /<repo>/, so the deploy workflow sets IRON_ACCORD_BASE; local
 * development serves from the root.
 */
export default defineConfig({
  base: process.env.IRON_ACCORD_BASE ?? '/',
  root: 'web',
  publicDir: '../data',
  plugins: [pwaAssets()],
  server: {
    host: true,
    fs: { allow: ['..'] },
  },
  build: { outDir: '../dist', emptyOutDir: true },
});
