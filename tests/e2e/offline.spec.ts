import { expect, test, type Page } from '@playwright/test';
import { drawFakeCard, type FakeCardOptions } from './fakeCard';

test.describe.configure({ timeout: 120_000 });

const SOL_RING: FakeCardOptions = { title: 'Sol Ring', collector: { set: 'CMM', number: '410', rarity: 'U' } };
const nav = (page: Page) => page.getByRole('navigation', { name: 'Sections' });

test.beforeEach(async ({ page }) => {
  // Thumbnails come from Scryfall's CDN. These tests shouldn't depend on it, or hit it.
  await page.route('https://cards.scryfall.io/**', (route) => route.abort());
});

async function openScanner(page: Page) {
  await nav(page).getByRole('button', { name: 'Scan', exact: true }).click();
  // The card reader is ready once the photo button works.
  await expect(page.getByLabel('Scan a photo')).toBeEnabled({ timeout: 60_000 });
}

async function scanPhoto(page: Page, options: FakeCardOptions) {
  const dataUrl = await page.evaluate(drawFakeCard, options);
  const buffer = Buffer.from(dataUrl.split(',')[1]!, 'base64');
  await page.getByLabel('Scan a photo').setInputFiles({ name: 'card.png', mimeType: 'image/png', buffer });
}

/** The first visit: the service worker installs, precaching the app and the OCR files, and takes control. */
async function firstVisit(page: Page) {
  await page.goto('./');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 60_000 });
}

/** OCR files in the service worker's precache, as `<folder>/<file>`. */
function precachedOcrFiles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const found: string[] = [];
    for (const name of (await caches.keys()).filter((key) => key.startsWith('workbox-precache'))) {
      for (const request of await (await caches.open(name)).keys()) {
        const match = /\/(ocr\/[^/]+\/[^/]+)$/.exec(new URL(request.url).pathname);
        if (match) found.push(match[1]!);
      }
    }
    return found.sort();
  });
}

test('the scanner works offline after a single visit', async ({ page, context }) => {
  await firstVisit(page);
  // On a first visit the recognition worker starts before the service worker is in control, so
  // the OCR files it fetches pass it by. They have to come from the precache instead.
  const files = await precachedOcrFiles(page);
  expect(files.map((file) => file.split('/').pop())).toEqual([
    'eng.traineddata.gz',
    'tesseract-core-lstm.js',
    'tesseract-core-simd-lstm.js',
    'tesseract-core-simd-lstm.wasm',
    'worker.min.js',
  ]);
  expect(new Set(files.map((file) => file.split('/').slice(0, 2).join('/'))).size).toBe(1);

  // Read Sol Ring once online, so that its printings are cached (downloading all of them comes later).
  await openScanner(page);
  await scanPhoto(page, SOL_RING);
  await expect(page.getByRole('status').filter({ hasText: 'Added Sol Ring · CMM 410' })).toBeVisible({ timeout: 30_000 });

  await context.setOffline(true);
  await page.reload();
  await openScanner(page);
  await expect(page.getByText("The card reader couldn't start")).toHaveCount(0);
  await scanPhoto(page, SOL_RING);
  await expect(page.getByRole('status').filter({ hasText: 'Added Sol Ring · CMM 410' })).toBeVisible({ timeout: 30_000 });
  await expect(nav(page).getByRole('button', { name: 'Batch (2)' })).toBeVisible();
});

test("removes the OCR copies other versions left, and this version's that the precache replaced", async ({ page }) => {
  await firstVisit(page);
  // Once the reader is ready, Tesseract has stored this version's model in IndexedDB.
  await openScanner(page);
  const folder = (await precachedOcrFiles(page))[0]!.split('/').slice(0, 2).join('/');
  const old = 'ocr/6.0.0-6.0.0-eng-best-0000000';
  // What an earlier version would have left: its files in the runtime cache, this version's
  // SIMD wasm there too (cached on first use before the precache had it), and models in
  // Tesseract's IndexedDB store.
  await page.evaluate(
    async ({ folder, old }) => {
      const cache = await caches.open('manifest-ocr');
      await cache.put(`${old}/eng.traineddata.gz`, new Response('old model'));
      await cache.put(`${old}/tesseract-core-simd-lstm.wasm`, new Response('old wasm'));
      await cache.put(`${folder}/tesseract-core-simd-lstm.wasm`, new Response('runtime copy'));
      await cache.put(`${folder}/tesseract-core-lstm.wasm`, new Response('non-SIMD wasm'));
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('keyval-store');
        open.onupgradeneeded = () => open.result.createObjectStore('keyval');
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const tx = db.transaction('keyval', 'readwrite');
      tx.objectStore('keyval').put('old model', `${old}/eng.traineddata`);
      await new Promise((resolve) => (tx.oncomplete = resolve));
      db.close();
    },
    { folder, old },
  );

  await page.reload();
  const left = () =>
    page.evaluate(async () => {
      const cache = await caches.open('manifest-ocr');
      const urls = (await cache.keys()).map((request) => new URL(request.url).pathname.replace(/^.*?\/ocr\//, 'ocr/')).sort();
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('keyval-store');
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const keys = await new Promise<IDBValidKey[]>((resolve) => {
        const request = db.transaction('keyval').objectStore('keyval').getAllKeys();
        request.onsuccess = () => resolve(request.result);
      });
      db.close();
      return { cache: urls, models: keys.map(String).sort() };
    });
  // The tidy-up runs about ten seconds after start-up.
  await expect.poll(left, { timeout: 40_000, intervals: [2_000] }).toEqual({
    cache: [`${folder}/tesseract-core-lstm.wasm`],
    models: [`${folder}/eng.traineddata`],
  });
});
