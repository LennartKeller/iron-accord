import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** Folds a directory's contents into a hash, in a filesystem-order-independent way. */
function hashDirectory(dir: string, hash: crypto.Hash): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    hash.update(entry.name);
    if (entry.isDirectory()) hashDirectory(full, hash);
    else hash.update(fs.readFileSync(full));
  }
}

/**
 * Emits the static PWA files, stamping the service worker with a build id.
 *
 * `publicDir` is pointed at the generated `data/` directory, so files sitting
 * in `web/` that the bundler never imports — the service worker, the manifest,
 * the icons — would otherwise not reach the build output at all.
 *
 * The build id is a hash of the bundle and of everything the worker caches. It
 * names the worker's caches, which is what makes updates reach installed apps:
 * the bundle is content-hashed and so refreshes itself, but `data/` is served
 * from stable URLs cache-first and would otherwise never be refetched. Hashing
 * rather than timestamping keeps the id stable when nothing has changed, so a
 * rebuild does not force every install to redownload the game.
 */
function pwaAssets(): Plugin {
  const entries = ['sw.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
  const PLACEHOLDER = '__BUILD_ID__';
  return {
    name: 'iron-accord:pwa-assets',
    apply: 'build',
    generateBundle(_options, bundle) {
      const hash = crypto.createHash('sha256');
      for (const name of Object.keys(bundle).sort()) {
        const chunk = bundle[name];
        hash.update(name);
        const content = chunk.type === 'chunk' ? chunk.code : chunk.source;
        hash.update(typeof content === 'string' ? content : Buffer.from(content));
      }

      const sources = new Map<string, Buffer>();
      for (const entry of entries) {
        const source = path.resolve('web', entry);
        if (!fs.existsSync(source)) continue;
        const contents = fs.readFileSync(source);
        sources.set(entry, contents);
        // Static shell files are precached too, so a new icon must land as well.
        hash.update(entry);
        hash.update(contents);
      }

      const dataDir = path.resolve('data');
      if (fs.existsSync(dataDir)) hashDirectory(dataDir, hash);
      const buildId = hash.digest('hex').slice(0, 12);

      for (const [entry, contents] of sources) {
        let source: Buffer | string = contents;
        if (entry === 'sw.js') {
          const text = contents.toString('utf8');
          // Loudly, not silently: a worker without a build id would pin every
          // installed app to the data it first downloaded.
          if (!text.includes(PLACEHOLDER)) {
            this.error(`${entry} is missing the ${PLACEHOLDER} placeholder`);
          }
          source = text.replaceAll(PLACEHOLDER, buildId);
        }
        this.emitFile({ type: 'asset', fileName: entry, source });
      }
    },
  };
}

/**
 * Emits the trained value net, if there is one.
 *
 * The model is a generated artefact: `models/` is gitignored, so a clean CI
 * checkout has no model and a static import of it fails the entire build. This
 * emits the pair when present and stays silent when absent, which keeps the web
 * build independent of whether anyone has trained anything yet.
 */
function valueNetAssets(): Plugin {
  return {
    name: 'iron-accord-value-net',
    generateBundle() {
      for (const name of ['value.onnx', 'value.json']) {
        const full = path.resolve('models', name);
        if (!fs.existsSync(full)) continue;
        this.emitFile({ type: 'asset', fileName: name, source: fs.readFileSync(full) });
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
  plugins: [pwaAssets(), valueNetAssets()],
  // Left to the dependency pre-bundler, onnxruntime-web's internal URL for its
  // .wasm is not rewritten, so dev fetches it from a path that falls through to
  // index.html and the runtime reports "no available backend". Excluded, Vite
  // resolves that URL the same way in dev as it does in the build.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  server: {
    host: true,
    fs: { allow: ['..'] },
  },
  build: { outDir: '../dist', emptyOutDir: true },
});
