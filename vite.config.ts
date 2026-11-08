import { cp, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
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

export default defineConfig({
  root: 'app',
  base,
  build: { outDir: '../dist', emptyOutDir: true },
  worker: { format: 'es' },
  plugins: [
    react(),
    tailwindcss(),
    indexData(),
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
        // Index shards are versioned by the app and cached separately, on demand.
        globIgnores: ['data/**'],
        navigateFallbackDenylist: [/\/data\//],
      },
    }),
  ],
});
