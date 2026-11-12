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

test('reads a card and its exact printing from a photo, and adds it to the batch', async ({ page }) => {
  await scanPhoto(page, { title: 'Sol Ring', collector: { set: 'CMM', number: '410', rarity: 'U' } });

  const result = page.getByRole('region', { name: 'Scan result' });
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(result.getByText('Recognized', { exact: true })).toBeVisible();
  await expect(result.getByRole('list', { name: 'Candidates' }).getByRole('button').first()).toHaveAccessibleName(
    'Choose Sol Ring',
  );
  await expect(result.getByText(/Collector line read as/)).toBeVisible();
  // The sample index has two printings of Sol Ring; the collector line picks one.
  const best = result.getByRole('list', { name: 'Printing candidates' }).getByRole('listitem').first();
  await expect(best).toContainText('CMM 410');

  await best.getByRole('button', { name: 'Add CMM 410 Nonfoil' }).click();
  await expect(page.getByText(/^Added Sol Ring/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Batch (1)' })).toBeVisible();

  await page.getByRole('button', { name: 'Scan next card' }).click();
  await expect(result).toBeHidden();
});

test('reads a card that is upside down, collector line included', async ({ page }) => {
  await scanPhoto(page, { title: 'Demonic Tutor', collector: { set: 'CMM', number: '509', rarity: 'M' }, flipped: true, rotation: -0.1 });
  const result = page.getByRole('region', { name: 'Scan result' });
  await expect(result.getByRole('list', { name: 'Candidates' }).getByRole('button').first()).toHaveAccessibleName(
    'Choose Demonic Tutor',
    { timeout: 30_000 },
  );
  await expect(result.getByRole('list', { name: 'Printing candidates' }).getByRole('listitem').first()).toContainText('CMM 509');
});

test('finds a card by its collector line when the title is unreadable', async ({ page }) => {
  await scanPhoto(page, { title: 'Xqzv Jwkp', collector: { set: 'CMM', number: '703', rarity: 'U' } });
  const result = page.getByRole('region', { name: 'Scan result' });
  await expect(result.getByRole('list', { name: 'Printing candidates' }).getByRole('listitem').first()).toContainText(
    'CMM 703',
    { timeout: 30_000 },
  );
  await expect(result.getByRole('list', { name: 'Candidates' }).getByRole('button').first()).toHaveAccessibleName('Choose Sol Ring');
});

test('shows every printing of a name on request', async ({ page }) => {
  await scanPhoto(page, { title: 'Lightning Bolt' });
  const result = page.getByRole('region', { name: 'Scan result' });
  await expect(result.getByRole('list', { name: 'Printing candidates' })).toBeVisible({ timeout: 30_000 });
  // Two printings and no collector line: the scanner can't tell which.
  await expect(result.getByText('Recognized the card. Which printing is it?')).toBeVisible();
  await result.getByRole('button', { name: 'Choose Lightning Bolt' }).click();
  await expect(page.getByRole('heading', { name: /^Lightning Bolt/ })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Printings' }).getByRole('listitem')).toHaveCount(2);
  await result.getByRole('button', { name: 'Back to closest printings' }).click();
  await expect(result.getByRole('list', { name: 'Printing candidates' })).toBeVisible();
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
  await expect(page.getByRole('alert')).toContainText("Couldn't find a card");
});

test('explains what to do while no card is in view of the camera', async ({ page }) => {
  await page.getByRole('button', { name: 'Start camera' }).click();
  // Chromium's fake camera shows a test pattern, not a card.
  await expect(page.getByRole('status')).toContainText('Place one card flat in view');
});

test("says it couldn't read a card, with a hint and a way to search instead", async ({ page }) => {
  // Gibberish for a title and no collector line: nothing to go on (the e2e index has no fingerprints).
  await scanPhoto(page, { title: 'Xqzv Jwkp' });
  const result = page.getByRole('region', { name: 'Scan result' });
  await expect(result.getByText("Couldn't read this card.")).toBeVisible({ timeout: 30_000 });
  await expect(result.getByRole('alert')).toContainText(/light|flatter/);
  await expect(result.getByRole('button', { name: 'Search by name instead' })).toBeVisible();
  await expect(result.getByTestId('debug-result')).toHaveCount(0);
});

async function openScannerWithDebug(page: Page) {
  await page.goto('./?debug=1');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Scan', exact: true }).click();
  await expect(page.getByLabel('Scan a photo')).toBeEnabled({ timeout: 60_000 });
}

test('shows per-stage timings for a photo with ?debug=1', async ({ page }) => {
  await openScannerWithDebug(page);
  await scanPhoto(page, { title: 'Sol Ring', collector: { set: 'CMM', number: '410', rarity: 'U' } });
  const timings = page.getByRole('region', { name: 'Scan result' }).getByTestId('debug-result');
  await expect(timings).toContainText(/capture \d+ · pixels \d+ · detect \d+ .*ocr \d+.* wall \d+ ms/, { timeout: 30_000 });
});

test('shows live frame timings with ?debug=1', async ({ page }) => {
  await openScannerWithDebug(page);
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByTestId('debug-live')).toContainText(/\d+×\d+ · [\d.]+ fps · capture \d+ · pixels \d+ · detect \d+/);
});

test('turns the timings on and off from inside the app', async ({ page }) => {
  await page.getByText('Testing', { exact: true }).click();
  await page.getByLabel('Show timings').check();
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByTestId('debug-live')).toBeVisible();
  // Remembered, like ?debug=1.
  await page.reload();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Scan', exact: true }).click();
  await expect(page.getByLabel('Scan a photo')).toBeEnabled({ timeout: 60_000 });
  await page.getByText('Testing', { exact: true }).click();
  await expect(page.getByLabel('Show timings')).toBeChecked();
  await page.getByLabel('Show timings').uncheck();
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByRole('status').first()).toBeVisible();
  await expect(page.getByTestId('debug-live')).toHaveCount(0);
});
