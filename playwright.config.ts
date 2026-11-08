import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
    ...devices['Pixel 7'],
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
  },
  webServer: {
    // A small index of real cards, so these tests don't need Scryfall.
    command: [
      'npx tsx scripts/build-index.ts --source tests/fixtures/scryfall-sample.jsonl --out .cache/e2e-index',
      'MANIFEST_DATA_DIR=.cache/e2e-index MANIFEST_REQUIRE_DATA=1 npm run build',
      'npm run preview -- --port 4173 --strictPort',
    ].join(' && '),
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
