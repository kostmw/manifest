import { expect, test } from '@playwright/test';
import { drawFakeCard } from './fakeCard';

test('loads the OCR engine from this site, never a CDN', async ({ page, context, baseURL }) => {
  test.setTimeout(90_000);
  const origins = new Set<string>();
  const ocrFiles: string[] = [];
  // Context-wide, so requests from the recognition worker and Tesseract's own worker count too.
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return;
    origins.add(url.origin);
    if (url.pathname.includes('/ocr/')) ocrFiles.push(url.pathname.split('/').pop()!);
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

  expect(ocrFiles).toEqual(expect.arrayContaining(['worker.min.js', 'eng.traineddata.gz']));
  expect(ocrFiles.some((file) => file.endsWith('.wasm'))).toBe(true);
  const elsewhere = [...origins].filter((origin) => origin !== new URL(baseURL!).origin && origin !== 'https://cards.scryfall.io');
  expect(elsewhere).toEqual([]);
});
