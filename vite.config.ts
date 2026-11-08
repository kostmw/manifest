import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves the site from /manifest/; Cloudflare Pages and local dev from /.
const base = process.env.MANIFEST_BASE ?? '/';

export default defineConfig({
  root: 'app',
  base,
  build: { outDir: '../dist', emptyOutDir: true },
  plugins: [
    react(),
    tailwindcss(),
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
