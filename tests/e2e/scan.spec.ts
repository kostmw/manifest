import { expect, test, type Page } from '@playwright/test';
import { drawFakeCard, type FakeCardOptions } from './fakeCard';

test.describe.configure({ timeout: 90_000 });

test.beforeEach(async ({ page }) => {
  // Thumbnails come from Scryfall's CDN. These tests shouldn't depend on it, or hit it.
  await page.route('https://cards.scryfall.io/**', (route) => route.abort());
  await page.goto('./');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Scan', exact: true }).click();
  // The card reader is ready once the photo button works.
  await expect(page.getByLabel('Scan a photo')).toBeEnabled({ timeout: 60_000 });
});

async function scanPhoto(page: Page, options: FakeCardOptions) {
  const dataUrl = await page.evaluate(drawFakeCard, options);
  const buffer = Buffer.from(dataUrl.split(',')[1]!, 'base64');
  await page.getByLabel('Scan a photo').setInputFiles({ name: 'card.png', mimeType: 'image/png', buffer });
}

test('reads a card from a photo and adds it to the batch', async ({ page }) => {
  await scanPhoto(page, { title: 'Sol Ring' });

  const result = page.getByRole('region', { name: 'Scan result' });
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(result.getByText('Recognized')).toBeVisible();
  await expect(result.getByRole('list', { name: 'Candidates' }).getByRole('button').first()).toHaveAccessibleName(
    'Choose Sol Ring',
  );
  await expect(page.getByRole('heading', { name: /^Sol Ring/ })).toBeVisible();

  await page.getByRole('button', { name: 'Add CMM 410 Nonfoil' }).click();
  await expect(page.getByText(/^Added Sol Ring/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Batch (1)' })).toBeVisible();

  await page.getByRole('button', { name: 'Scan next card' }).click();
  await expect(result).toBeHidden();
});

test('reads a card that is upside down', async ({ page }) => {
  await scanPhoto(page, { title: 'Demonic Tutor', flipped: true, rotation: -0.1 });
  const candidates = page.getByRole('list', { name: 'Candidates' });
  await expect(candidates.getByRole('button').first()).toHaveAccessibleName('Choose Demonic Tutor', { timeout: 30_000 });
});

test('lets the user pick when the reading is unsure', async ({ page }) => {
  // A misspelt title: close to a real name, but not close enough to be sure.
  await scanPhoto(page, { title: 'Hogaak, Arsen Necrop' });
  const result = page.getByRole('region', { name: 'Scan result' });
  await expect(result.getByText('Not sure. Is it one of these?')).toBeVisible({ timeout: 30_000 });
  await result.getByRole('button', { name: 'Choose Hogaak, Arisen Necropolis' }).click();
  await expect(page.getByRole('heading', { name: /^Hogaak, Arisen Necropolis/ })).toBeVisible();
});

test('says so when a photo has no card in it', async ({ page }) => {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#556677';
    ctx.fillRect(0, 0, 640, 480);
    return canvas.toDataURL('image/png');
  });
  await page.getByLabel('Scan a photo').setInputFiles({
    name: 'empty.png',
    mimeType: 'image/png',
    buffer: Buffer.from(dataUrl.split(',')[1]!, 'base64'),
  });
  await expect(page.getByRole('alert')).toContainText('No card found');
});

test('explains what to do while no card is in view of the camera', async ({ page }) => {
  await page.getByRole('button', { name: 'Start camera' }).click();
  // Chromium's fake camera shows a test pattern, not a card.
  await expect(page.getByRole('status')).toContainText('Place one card flat in view');
});
