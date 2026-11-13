import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { drawFakeCard, type FakeCardOptions } from './fakeCard';

test.describe.configure({ timeout: 90_000 });

test.beforeEach(async ({ page }) => {
  // Thumbnails come from Scryfall's CDN. These tests shouldn't depend on it, or hit it.
  await page.route('https://cards.scryfall.io/**', (route) => route.abort());
  await page.goto('./');
  await openScanner(page);
});

async function openScanner(page: Page) {
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Scan', exact: true }).click();
  // The card reader is ready once the photo button works.
  await expect(page.getByLabel('Scan a photo')).toBeEnabled({ timeout: 60_000 });
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Sections' });

async function scanPhoto(page: Page, options: FakeCardOptions) {
  const dataUrl = await page.evaluate(drawFakeCard, options);
  const buffer = Buffer.from(dataUrl.split(',')[1]!, 'base64');
  await page.getByLabel('Scan a photo').setInputFiles({ name: 'card.png', mimeType: 'image/png', buffer });
}

const SOL_RING = { title: 'Sol Ring', collector: { set: 'CMM', number: '410', rarity: 'U' } };

test('adds a confidently read card straight to the batch, and undoes it in one tap', async ({ page }) => {
  await scanPhoto(page, SOL_RING);

  await expect(page.getByRole('status').filter({ hasText: 'Added Sol Ring · CMM 410' })).toBeVisible({ timeout: 30_000 });
  await expect(nav(page).getByRole('button', { name: 'Batch (1)' })).toBeVisible();
  await expect(page.getByTestId('scan-counter')).toHaveText('1');
  const strip = page.getByRole('list', { name: 'Last cards scanned' });
  await expect(strip.getByRole('button', { name: 'Sol Ring, CMM 410, added' })).toBeVisible();
  // No confirm step: nothing waits for review.
  await expect(page.getByRole('region', { name: 'Scan result' })).toHaveCount(0);

  await strip.getByRole('button', { name: 'Undo Sol Ring' }).click();
  await expect(nav(page).getByRole('button', { name: 'Batch', exact: true })).toBeVisible();
  await expect(page.getByTestId('scan-counter')).toHaveText('0');
  await expect(strip).toHaveCount(0);
});

test('adds the batch’s foil finish to a confidently read card', async ({ page }) => {
  await page.getByRole('region', { name: 'Scan settings' }).getByLabel('All foil').check();
  await scanPhoto(page, SOL_RING);
  await expect(page.getByRole('status').filter({ hasText: 'Added Sol Ring · CMM 410' })).toBeVisible({ timeout: 30_000 });
  await nav(page).getByRole('button', { name: 'Batch (1)' }).click();
  await expect(page.getByRole('combobox', { name: 'Finish of Sol Ring' })).toHaveValue('foil');
});

test('reads a card that is upside down, collector line included', async ({ page }) => {
  await scanPhoto(page, { title: 'Demonic Tutor', collector: { set: 'CMM', number: '509', rarity: 'M' }, flipped: true, rotation: -0.1 });
  await expect(page.getByRole('status').filter({ hasText: 'Added Demonic Tutor · CMM 509' })).toBeVisible({ timeout: 30_000 });
  // That printing only comes etched.
  await nav(page).getByRole('button', { name: 'Batch (1)' }).click();
  await expect(page.getByRole('combobox', { name: 'Finish of Demonic Tutor' })).toHaveValue('etched');
});

test('finds a card by its collector line when the title is unreadable, and asks to check it', async ({ page }) => {
  await scanPhoto(page, { title: 'Xqzv Jwkp', collector: { set: 'CMM', number: '703', rarity: 'U' } });
  const result = page.getByRole('region', { name: 'Scan result' });
  await expect(result.getByRole('list', { name: 'Candidates' }).getByRole('button').first()).toHaveAccessibleName('Pick Sol Ring, CMM 703', {
    timeout: 30_000,
  });
  await expect(nav(page).getByRole('button', { name: 'Review (1)' })).toBeVisible();
  await result.getByRole('button', { name: /^Add CMM 703/ }).click();
  await expect(result).toHaveCount(0);
  await expect(nav(page).getByRole('button', { name: 'Batch (1)' })).toBeVisible();
  await expect(nav(page).getByRole('button', { name: 'Review', exact: true })).toBeVisible();
});

test('shows every printing of a name on request', async ({ page }) => {
  await scanPhoto(page, { title: 'Lightning Bolt' });
  const result = page.getByRole('region', { name: 'Scan result' });
  // Two printings and no collector line: the scanner can't tell which.
  await expect(result.getByText('Recognized the card. Which printing is it?')).toBeVisible({ timeout: 30_000 });
  await result.getByRole('button', { name: 'All printings of Lightning Bolt' }).click();
  await expect(page.getByRole('heading', { name: /^Lightning Bolt/ })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Printings' }).getByRole('listitem')).toHaveCount(2);
  await result.getByRole('button', { name: 'Use M11 149' }).click();
  await expect(result.getByText('Chosen: Lightning Bolt (M11 149)')).toBeVisible();
  await result.getByRole('button', { name: /^Add M11 149/ }).click();
  await expect(nav(page).getByRole('button', { name: 'Batch (1)' })).toBeVisible();
});

test('lets the user pick when the reading is unsure', async ({ page }) => {
  // A misspelt title: close to a real name, but not close enough to be sure.
  await scanPhoto(page, { title: 'Hogaak, Arsen Necrop' });
  const result = page.getByRole('region', { name: 'Scan result' });
  await expect(result.getByText('Not sure. Is it one of these?')).toBeVisible({ timeout: 30_000 });
  await result.getByRole('button', { name: 'Pick Hogaak, Arisen Necropolis, MH1 202' }).click();
  await result.getByRole('button', { name: 'Add MH1 202' }).click();
  await expect(nav(page).getByRole('button', { name: 'Batch (1)' })).toBeVisible();
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
  await expect(page.getByRole('status').filter({ hasText: 'Slide a card into view' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sound on' })).toBeVisible();
});

test("says it couldn't read a card, with a hint, and keeps it for review", async ({ page }) => {
  // Gibberish for a title and no collector line: nothing to go on (the e2e index has no fingerprints).
  await scanPhoto(page, { title: 'Xqzv Jwkp' });
  const result = page.getByRole('region', { name: 'Scan result' });
  await expect(result.getByText("Couldn't read this card.")).toBeVisible({ timeout: 30_000 });
  await expect(result.getByRole('alert')).toContainText(/light|flatter/);
  await expect(result.getByRole('button', { name: /^Search by name/ })).toBeVisible();
  await expect(result.getByTestId('debug-result')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: "Couldn't read that one: it's waiting in Review" })).toBeVisible();
  await result.getByRole('button', { name: 'Later: keep it in Review' }).click();
  await expect(result).toHaveCount(0);
  await expect(nav(page).getByRole('button', { name: 'Review (1)' })).toBeVisible();
});

test('works through the review queue with the keyboard', async ({ page }) => {
  await scanPhoto(page, { title: 'Lightning Bolt' });
  const result = page.getByRole('region', { name: 'Scan result' });
  await expect(result).toBeVisible({ timeout: 30_000 });
  await result.getByRole('button', { name: 'Later: keep it in Review' }).click();

  await nav(page).getByRole('button', { name: 'Review (1)' }).click();
  await expect(page.getByTestId('review-position')).toHaveText('1 of 1 to review');
  const card = page.getByRole('region', { name: 'Card to review' });
  await expect(card.getByRole('img', { name: 'The card as scanned' })).toBeVisible();
  const candidates = card.getByRole('list', { name: 'Candidates' }).getByRole('button');
  await expect(candidates).toHaveCount(2);
  await expect(candidates.first()).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press('2');
  await expect(candidates.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('f');
  await expect(card.getByLabel('Foil')).toBeChecked();
  await page.keyboard.press('+');
  await expect(card.getByLabel('Quantity')).toHaveText('2');
  await page.keyboard.press('Enter');

  await expect(page.getByText('All done: nothing left to review.')).toBeVisible();
  await nav(page).getByRole('button', { name: 'Batch (2)' }).click();
  await expect(page.getByLabel(/^Quantity of Lightning Bolt/)).toHaveText('2');
});

test('applies one choice to every similar card waiting for review', async ({ page }) => {
  for (const rotation of [0.05, -0.04, 0.02]) {
    await scanPhoto(page, { title: 'Lightning Bolt', rotation });
    const result = page.getByRole('region', { name: 'Scan result' });
    await expect(result).toBeVisible({ timeout: 30_000 });
    await result.getByRole('button', { name: 'Later: keep it in Review' }).click();
  }
  await nav(page).getByRole('button', { name: 'Review (3)' }).click();
  const card = page.getByRole('region', { name: 'Card to review' });
  await card.getByRole('button', { name: 'Pick Lightning Bolt, M11 149' }).click();
  await card.getByRole('button', { name: 'Use M11 149 for all 3 Lightning Bolt' }).click();
  await expect(page.getByText('All done: nothing left to review.')).toBeVisible();
  await expect(nav(page).getByRole('button', { name: 'Batch (3)' })).toBeVisible();
});

test('locks the batch to a set, which settles look-alike printings', async ({ page }) => {
  const settings = page.getByRole('region', { name: 'Scan settings' });
  await settings.getByRole('button', { name: 'Sets: any' }).click();
  await settings.getByRole('combobox', { name: 'Add a set' }).fill('m11');
  await settings.getByRole('option', { name: /^M11 · Magic 2011/ }).click();
  await expect(settings.getByRole('list', { name: 'Locked sets' })).toContainText('M11');
  await settings.getByRole('button', { name: 'Done' }).click();
  await expect(settings.getByRole('button', { name: 'Sets: M11' })).toBeVisible();

  // Without the lock this card waits for review (two printings); with it, only one competes.
  await scanPhoto(page, { title: 'Lightning Bolt' });
  await expect(page.getByRole('status').filter({ hasText: 'Added Lightning Bolt · M11 149' })).toBeVisible({ timeout: 30_000 });

  // A card from another set waits for review, flagged.
  await scanPhoto(page, SOL_RING);
  const result = page.getByRole('region', { name: 'Scan result' });
  await expect(result.getByText("This card isn't from the locked sets (M11). Is it one of these?")).toBeVisible({ timeout: 30_000 });
});

async function openScannerWithDebug(page: Page) {
  await page.goto('./?debug=1');
  await openScanner(page);
}

test('shows per-stage timings for a photo with ?debug=1', async ({ page }) => {
  await openScannerWithDebug(page);
  await scanPhoto(page, SOL_RING);
  await expect(page.getByTestId('debug-result')).toContainText(/capture \d+ · pixels \d+ · detect \d+ .*ocr \d+.* wall \d+ ms/, { timeout: 30_000 });
});

test('shows live frame timings with ?debug=1', async ({ page }) => {
  await openScannerWithDebug(page);
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByTestId('debug-live')).toContainText(/\d+×\d+ · [\d.]+ fps · capture \d+ · pixels \d+ · detect \d+/);
});

test('turns the timings on and off from inside the app', async ({ page }) => {
  await page.getByText('Sound and testing', { exact: true }).click();
  await page.getByLabel('Show timings').check();
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByTestId('debug-live')).toBeVisible();
  // Remembered, like ?debug=1.
  await page.reload();
  await openScanner(page);
  await page.getByText('Sound and testing', { exact: true }).click();
  await expect(page.getByLabel('Show timings')).toBeChecked();
  await page.getByLabel('Show timings').uncheck();
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByRole('status').first()).toBeVisible();
  await expect(page.getByTestId('debug-live')).toHaveCount(0);
});

test('records a test log of scans and corrections, and saves it as one file', async ({ page }) => {
  await page.getByText('Sound and testing', { exact: true }).click();
  await page.getByLabel('Record a test log').check();
  await expect(page.getByLabel('Include card pictures (small, about 10 KB each)')).toBeChecked();

  // One card added and then undone, one sent to review and settled by hand.
  await scanPhoto(page, SOL_RING);
  const strip = page.getByRole('list', { name: 'Last cards scanned' });
  await expect(strip.getByRole('button', { name: 'Undo Sol Ring' })).toBeVisible({ timeout: 30_000 });
  await strip.getByRole('button', { name: 'Undo Sol Ring' }).click();
  await scanPhoto(page, { title: 'Lightning Bolt' });
  const result = page.getByRole('region', { name: 'Scan result' });
  await result.getByRole('button', { name: 'Pick Lightning Bolt, M11 149' }).click({ timeout: 30_000 });
  await result.getByRole('button', { name: /^Add M11 149/ }).click();
  await expect(result).toHaveCount(0);

  await expect(page.getByTestId('testlog-count')).toHaveText(/^2 scans in the log/, { timeout: 10_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download test log' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^manifest-testlog-\d{8}-\d{4}\.json$/);
  const log = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(log).toMatchObject({ format: 'manifest-testlog', version: 1 });
  expect(log.reads).toHaveLength(2);
  const [solRing, bolt] = log.reads;
  expect(solRing).toMatchObject({ source: 'photo', outcome: { kind: 'added' }, ocr: { title: expect.stringContaining('Sol') } });
  expect(solRing.trace).toContain('title:rendering-1');
  expect(solRing.timings).toHaveProperty('ocr');
  expect(solRing.candidates[0]).toMatchObject({ set: 'cmm', number: '410' });
  expect(solRing.crop).toMatch(/^\/9j\//);
  expect(bolt.outcome).toEqual({ kind: 'review', reason: 'unsure-printing' });
  expect(log.events).toEqual([
    expect.objectContaining({ type: 'undo', readIds: [solRing.id] }),
    expect.objectContaining({ type: 'review-accepted', readIds: [bolt.id], printing: expect.objectContaining({ set: 'm11', number: '149' }), via: 'candidate-2' }),
  ]);

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Clear log' }).click();
  await expect(page.getByTestId('testlog-count')).toHaveText(/^0 scans/);
});
