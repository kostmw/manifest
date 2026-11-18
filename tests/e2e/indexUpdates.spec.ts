import { readFile } from 'node:fs/promises';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { drawFakeCard } from './fakeCard';

/**
 * Index builds on the device (games/indexBuilds.ts): a newer build replaces
 * the one in use only once it is all here, and a file from another build is
 * never used or cached. The tests serve the card index themselves, the way
 * GitHub Pages does: whatever build is deployed, whatever `?v=` is asked for.
 * Build A is the e2e index; build B (secondIndex.ts) adds a printing of Sol
 * Ring in set TST and a card named Manifest Test Card.
 */
test.describe.configure({ timeout: 120_000 });

const DIRS = { A: '.cache/e2e-index', B: '.cache/e2e-index-b' } as const;
type BuildName = keyof typeof DIRS;

interface Server {
  build: BuildName;
  /** Serve only the manifest, as if the connection dropped right after it. */
  manifestOnly: boolean;
  /** Don't serve printings shards (they never arrive). */
  noPrintings: boolean;
}

async function serveIndex(context: BrowserContext): Promise<Server> {
  const server: Server = { build: 'A', manifestOnly: false, noPrintings: false };
  await context.route('**/data/**', async (route) => {
    const file = new URL(route.request().url()).pathname.split('/data/').pop()!;
    if (server.manifestOnly && file !== 'manifest.json') return route.abort('internetdisconnected');
    if (server.noPrintings && file.startsWith('printings.')) return route.abort('internetdisconnected');
    try {
      const body = await readFile(`${DIRS[server.build]}/${file}`);
      await route.fulfill({ body, contentType: file.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
  return server;
}

interface ManifestFile {
  file: string;
  sha256: string;
}
async function manifestOf(build: BuildName) {
  return JSON.parse(await readFile(`${DIRS[build]}/manifest.json`, 'utf8')) as {
    buildDate: string;
    games: { mtg: { names: ManifestFile; collectors: ManifestFile; sets: ManifestFile; shards: ManifestFile[] } };
  };
}
/** Cache keys of a build's files that the other build doesn't have. */
async function onlyIn(build: BuildName, other: BuildName): Promise<string[]> {
  const keys = async (name: BuildName) => {
    const { games } = await manifestOf(name);
    return [games.mtg.names, games.mtg.collectors, games.mtg.sets, ...games.mtg.shards].map((f) => `${f.file}?v=${f.sha256.slice(0, 16)}`);
  };
  const theirs = new Set(await keys(other));
  return (await keys(build)).filter((key) => !theirs.has(key));
}

const buildDate = async (build: BuildName) => (JSON.parse(await readFile(`${DIRS[build]}/manifest.json`, 'utf8')) as { buildDate: string }).buildDate;

/** The active build on the device, and whether a candidate is being downloaded. */
function deviceState(page: Page) {
  return page.evaluate(async () => {
    const cache = await caches.open('manifest-index-v1');
    const active = await cache.match('data/manifest.json');
    return {
      active: active ? ((await active.json()) as { buildDate: string }).buildDate : null,
      candidate: Boolean(await cache.match('data/manifest.json?candidate')),
      files: (await cache.keys()).map((request) => request.url.split('/data/').pop()!).filter((key) => !key.startsWith('manifest.json')),
    };
  });
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Sections' });

async function openScanner(page: Page) {
  await nav(page).getByRole('button', { name: 'Scan', exact: true }).click();
  await expect(page.getByLabel('Scan a photo')).toBeEnabled({ timeout: 60_000 });
}

/** Opens Search and picks a card; returns the printings' Add buttons, or throws if the card isn't offered. */
async function choose(page: Page, query: string, cardName: string) {
  await nav(page).getByRole('button', { name: 'Search' }).click();
  const newSearch = page.getByRole('button', { name: 'New search' });
  if (await newSearch.isVisible()) await newSearch.click();
  await page.getByRole('combobox', { name: 'Card name' }).fill(query);
  await page.getByRole('option', { name: cardName, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.route('https://cards.scryfall.io/**', (route) => route.abort());
});

test('keeps working offline on the build it has when a newer one arrives without its files', async ({ page, context }) => {
  const server = await serveIndex(context);
  await page.goto('./');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 60_000 });
  await choose(page, 'sol ring', 'Sol Ring');
  await expect(page.getByRole('button', { name: 'Add CMM 410 Nonfoil' })).toBeVisible();
  await openScanner(page);
  expect((await deviceState(page)).active).toBe(await buildDate('A'));

  // The next night's build: its manifest arrives, then the connection drops.
  server.build = 'B';
  server.manifestOnly = true;
  await page.reload();
  await openScanner(page);
  await expect.poll(async () => (await deviceState(page)).candidate, { timeout: 20_000 }).toBe(true);
  expect((await deviceState(page)).active).toBe(await buildDate('A'));

  // Offline, everything that worked on A still does.
  await context.unroute('**/data/**');
  await context.setOffline(true);
  await page.reload();
  await openScanner(page);
  await choose(page, 'sol ring', 'Sol Ring');
  await expect(page.getByRole('button', { name: 'Add CMM 410 Nonfoil' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Add TST/ })).toHaveCount(0);
});

test('switches to a newer build once its files are in, and every part of the app moves to it without a reload', async ({ page, context }) => {
  const server = await serveIndex(context);
  await page.goto('./');
  await choose(page, 'sol ring', 'Sol Ring');
  await expect(page.getByRole('button', { name: 'Add CMM 410 Nonfoil' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Card name' }).fill('manifest test');
  await expect(page.getByText('No cards match that name.')).toBeVisible();
  const onA = await deviceState(page);
  expect(onA.active).toBe(await buildDate('A'));

  server.build = 'B';
  await page.reload();
  // Name search and the card reader start on A, the active build ...
  await nav(page).getByRole('button', { name: 'Search' }).click();
  await openScanner(page);
  // ... until the update check, a few seconds in, has B's files and switches.
  await expect.poll(async () => (await deviceState(page)).active, { timeout: 30_000 }).toBe(await buildDate('B'));

  // The card reader knows B's new card,
  const dataUrl = await page.evaluate(drawFakeCard, { title: 'Manifest Test Card', collector: { set: 'TST', number: '2', rarity: 'U' } });
  await page.getByLabel('Scan a photo').setInputFiles({ name: 'card.png', mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1]!, 'base64') });
  await expect(
    page.getByRole('status').filter({ hasText: 'Manifest Test Card' }).or(page.getByRole('region', { name: 'Scan result' }).filter({ hasText: 'Manifest Test Card' })),
  ).toBeVisible({ timeout: 30_000 });
  // name search finds it, and Sol Ring has its new printing.
  await choose(page, 'manifest test', 'Manifest Test Card');
  await choose(page, 'sol ring', 'Sol Ring');
  await expect(page.getByRole('button', { name: 'Add TST 1 Nonfoil' })).toBeVisible();

  // A's own files stay until the next update finds nothing new, then go.
  const aOnly = await onlyIn('A', 'B');
  const aOnlyCached = onA.files.filter((file) => aOnly.includes(file));
  expect(aOnlyCached.length).toBeGreaterThan(0); // names, collectors, sets and Sol Ring's shard
  expect((await deviceState(page)).files).toEqual(expect.arrayContaining(aOnlyCached));
  await page.reload();
  await expect.poll(async () => (await deviceState(page)).files.filter((file) => aOnly.includes(file)), { timeout: 30_000 }).toEqual([]);
});

test("never uses or caches a file from another build than its own, and moves to the server's build", async ({ page, context }) => {
  const server = await serveIndex(context);
  // A's printings don't arrive, so that Sol Ring's are still to be fetched when B is deployed.
  server.noPrintings = true;
  await page.goto('./');
  // The card reader has loaded A's names and collectors.
  await openScanner(page);
  expect((await deviceState(page)).active).toBe(await buildDate('A'));

  // B is deployed while the page stays open on A. GitHub Pages answers A's URL for Sol Ring's
  // printings with B's file, which has the TST printing.
  server.build = 'B';
  server.noPrintings = false;
  await choose(page, 'sol ring', 'Sol Ring');
  await expect(page.getByText("Couldn't load the printings of Sol Ring")).toBeVisible();
  await expect(page.getByRole('button', { name: /^Add TST/ })).toHaveCount(0);
  // Nothing is cached under A's version of the files that differ.
  const aOnly = await onlyIn('A', 'B');
  expect((await deviceState(page)).files.filter((file) => aOnly.includes(file) && file.startsWith('printings'))).toEqual([]);

  // Being served a newer file sets off an update check, which switches to B; then Sol Ring's printings load.
  await expect.poll(async () => (await deviceState(page)).active, { timeout: 60_000 }).toBe(await buildDate('B'));
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('button', { name: 'Add TST 1 Nonfoil' })).toBeVisible();
});
