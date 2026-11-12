import { expect, test } from '@playwright/test';
import { drawFakeCard } from './fakeCard';

test('loads the OCR engine from this site, never a CDN', async ({ page, context, baseURL }) => {
  test.setTimeout(90_000);
  const site = new URL(baseURL!).origin;
  const origins = new Set<string>();
  const ocrFiles: string[] = [];
  const workerScripts: string[] = [];
  const note = (address: string) => {
    const url = new URL(address);
    if (url.protocol === 'data:' || url.protocol === 'blob:') return null;
    origins.add(url.origin);
    return url;
  };
  // Context-wide, so requests from the recognition worker and Tesseract's own worker count too.
  context.on('request', (request) => {
    const url = note(request.url());
    if (url?.pathname.includes('/ocr/')) ocrFiles.push(url.pathname.split('/').pop()!);
  });
  // A worker started by another worker (Tesseract's, started by the recognition worker) has its
  // script request reported only when a service worker fetches it, not while page.route below
  // intercepts requests; whether the service worker is in control by then depends on timing. The
  // worker itself is always reported, with the URL its script came from.
  page.on('worker', (worker) => {
    const url = note(worker.url());
    if (url) workerScripts.push(url.href);
  });
  await page.route('https://cards.scryfall.io/**', (route) => route.abort());

  await page.goto('./');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Scan', exact: true }).click();
  await expect(page.getByLabel('Scan a photo')).toBeEnabled({ timeout: 60_000 });
  const dataUrl = await page.evaluate(drawFakeCard, { title: 'Sol Ring' });
  await page.getByLabel('Scan a photo').setInputFiles({
    name: 'card.png',
    mimeType: 'image/png',
    buffer: Buffer.from(dataUrl.split(',')[1]!, 'base64'),
  });
  await expect(page.getByRole('region', { name: 'Scan result' })).toBeVisible({ timeout: 30_000 });

  // Tesseract's worker runs from this site's own copy of its script.
  const tesseractWorker = workerScripts.find((script) => script.endsWith('/worker.min.js'));
  expect(tesseractWorker, `workers: ${workerScripts.join(', ')}`).toBeDefined();
  expect(new URL(tesseractWorker!).origin).toBe(site);
  expect(new URL(tesseractWorker!).pathname).toContain('/ocr/');
  // And it fetched the engine and the model from here too.
  expect(ocrFiles).toEqual(expect.arrayContaining(['eng.traineddata.gz']));
  expect(ocrFiles.some((file) => file.endsWith('.wasm'))).toBe(true);
  expect(ocrFiles.some((file) => /^tesseract-core.*\.js$/.test(file))).toBe(true);
  // Nothing, requests or worker scripts, came from anywhere else (Scryfall thumbnails are blocked above).
  const elsewhere = [...origins].filter((origin) => origin !== site && origin !== 'https://cards.scryfall.io');
  expect(elsewhere).toEqual([]);
});
