import { cp, mkdir, readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves the site from /manifest/; Cloudflare Pages and local dev from /.
const base = process.env.MANIFEST_BASE ?? '/';
const dataDir = resolve(process.env.MANIFEST_DATA_DIR ?? 'data');

/**
 * Index files are generated rather than committed. This serves them in dev and
 * copies them next to the site on build. A deploy sets MANIFEST_REQUIRE_DATA,
 * so that a site without card data can never go live by accident.
 */
function indexData(): Plugin {
  return {
    name: 'manifest-index-data',
    configureServer(server) {
      server.middlewares.use(`${base}data`, async (req, res, next) => {
        const path = resolve(dataDir, `.${decodeURIComponent((req.url ?? '').split('?')[0]!)}`);
        const isInside = path.startsWith(dataDir + sep);
        if (!isInside || !(await stat(path).then((file) => file.isFile(), () => false))) {
          next();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(await readFile(path));
      });
    },
    async closeBundle() {
      if (existsSync(dataDir)) {
        await cp(dataDir, resolve('dist/data'), { recursive: true });
      } else if (process.env.MANIFEST_REQUIRE_DATA) {
        throw new Error(`No index data at ${dataDir}. Run npm run index:build first.`);
      } else {
        this.warn(`No index data at ${dataDir}: search won't work. Run npm run index:build.`);
      }
    },
  };
}

const require = createRequire(import.meta.url);
const packageDir = (name: string) => dirname(require.resolve(`${name}/package.json`));
const versionOf = (name: string) => (JSON.parse(readFileSync(`${packageDir(name)}/package.json`, 'utf8')) as { version: string }).version;

/**
 * Tesseract's files, served by this site rather than a CDN so that OCR works
 * offline and nothing leaves the device. The directory name carries the
 * versions, so a cached copy can never mix with a newer one.
 */
// The fast English model, vendored (see vendor/tessdata_fast/README.md); the tag names its commit.
const OCR_MODEL = 'eng-fast-923915d';
const OCR_DIR = `ocr/${versionOf('tesseract.js')}-${versionOf('tesseract.js-core')}-${OCR_MODEL}`;
const OCR_FILES: Record<string, string> = {
  'worker.min.js': `${packageDir('tesseract.js')}/dist/worker.min.js`,
  'tesseract-core-simd-lstm.js': `${packageDir('tesseract.js-core')}/tesseract-core-simd-lstm.js`,
  'tesseract-core-simd-lstm.wasm': `${packageDir('tesseract.js-core')}/tesseract-core-simd-lstm.wasm`,
  'tesseract-core-lstm.js': `${packageDir('tesseract.js-core')}/tesseract-core-lstm.js`,
  'tesseract-core-lstm.wasm': `${packageDir('tesseract.js-core')}/tesseract-core-lstm.wasm`,
  'eng.traineddata.gz': resolve('vendor/tessdata_fast/eng.traineddata.gz'),
};
const CONTENT_TYPES: Record<string, string> = {
  js: 'text/javascript',
  wasm: 'application/wasm',
  gz: 'application/octet-stream',
};

function ocrAssets(): Plugin {
  return {
    name: 'manifest-ocr-assets',
    configureServer(server) {
      server.middlewares.use(`${base}${OCR_DIR}`, async (req, res, next) => {
        const file = decodeURIComponent((req.url ?? '').split('?')[0]!).replace(/^\//, '');
        const source = OCR_FILES[file];
        if (!source) {
          next();
          return;
        }
        res.setHeader('Content-Type', CONTENT_TYPES[file.split('.').pop()!] ?? 'application/octet-stream');
        res.end(await readFile(source));
      });
    },
    async closeBundle() {
      const outDir = resolve('dist', OCR_DIR);
      await mkdir(outDir, { recursive: true });
      await Promise.all(Object.entries(OCR_FILES).map(([file, source]) => cp(source, resolve(outDir, file))));
    },
  };
}

export default defineConfig({
  root: 'app',
  base,
  build: { outDir: '../dist', emptyOutDir: true },
  worker: { format: 'es' },
  define: { __OCR_DIR__: JSON.stringify(OCR_DIR) },
  plugins: [
    react(),
    tailwindcss(),
    indexData(),
    ocrAssets(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Manifest: TCG card scanner',
        short_name: 'Manifest',
        description: 'Scan a stack, get a list. Card recognition runs on your device.',
        theme_color: '#18181b',
        background_color: '#18181b',
        display: 'standalone',
        orientation: 'any',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        navigateFallback: 'index.html',
        // Index shards are versioned by the app and cached separately, on demand. OCR files
        // (about 3 MB) are cached the first time the scanner starts, not on install.
        globIgnores: ['data/**', 'ocr/**'],
        navigateFallbackDenylist: [/\/data\//, /\/ocr\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/ocr/'),
            handler: 'CacheFirst',
            options: { cacheName: 'manifest-ocr', expiration: { maxEntries: 20 } },
          },
        ],
      },
    }),
  ],
});
