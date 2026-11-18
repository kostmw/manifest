import { expect, test, type Page } from '@playwright/test';
import { drawFakeCard, type FakeCardOptions } from './fakeCard';

/**
 * Ready offline (ui/offline.ts): after a single visit the whole card index
 * and the OCR engine are on the device, so every part of the app works with
 * no network. Each step below is a row of the M6 offline audit.
 */
test.describe.configure({ timeout: 120_000 });

const nav = (page: Page) => page.getByRole('navigation', { name: 'Sections' });
const offlineStatus = (page: Page) => page.getByTestId('offline-status');

async function openScanner(page: Page) {
  await nav(page).getByRole('button', { name: 'Scan', exact: true }).click();
  await expect(page.getByLabel('Scan a photo')).toBeEnabled({ timeout: 60_000 });
}

async function scanPhoto(page: Page, options: FakeCardOptions) {
  const dataUrl = await page.evaluate(drawFakeCard, options);
  await page.getByLabel('Scan a photo').setInputFiles({ name: 'card.png', mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1]!, 'base64') });
}

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

test('after a single visit, every part of the app works offline', async ({ page, context }) => {
  // One visit, doing nothing: the card data and the OCR engine download in the background.
  await page.goto('./');
  await expect(offlineStatus(page)).toContainText('ready offline', { timeout: 60_000 });

  await context.setOffline(true);
  const failed: string[] = [];
  context.on('requestfailed', (request) => {
    const url = new URL(request.url());
    if (url.origin === new URL(page.url()).origin) failed.push(url.pathname);
  });
  await page.reload();

  // The app shell, and what it says about the card data.
  await expect(nav(page)).toBeVisible();
  await expect(offlineStatus(page)).toContainText('ready offline');

  // The OCR engine, the names and the collector numbers: the card reader starts.
  await openScanner(page);
  await expect(page.getByText("The card reader couldn't start")).toHaveCount(0);

  // "Scan a photo" end to end, of a card whose printings were never opened.
  await scanPhoto(page, { title: 'Aether Vial', collector: { set: 'MMA', number: '197', rarity: 'R' } });
  await expect(page.getByRole('status').filter({ hasText: 'Added Aether Vial · MMA 197' })).toBeVisible({ timeout: 30_000 });

  // The live camera starts.
  await page.getByRole('button', { name: 'Start camera' }).click();
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return Boolean(video && video.readyState >= 2 && !video.paused);
  });

  // Locking the batch to a set (the set list).
  const settings = page.getByRole('region', { name: 'Scan settings' });
  await settings.getByRole('button', { name: 'Sets: any' }).click();
  await settings.getByRole('combobox', { name: 'Add a set' }).fill('m11');
  await settings.getByRole('option', { name: /^M11 · Magic 2011/ }).click();
  await settings.getByRole('button', { name: 'Done' }).click();
  await expect(settings.getByRole('button', { name: 'Sets: M11' })).toBeVisible();

  // Manual search of a card never opened, and adding it to the batch.
  await choose(page, 'demonic tutor', 'Demonic Tutor');
  await page.getByRole('button', { name: 'Add CMM 509 Etched' }).click();
  await expect(page.getByText(/^Added Demonic Tutor/)).toBeVisible();

  // Every export.
  await nav(page).getByRole('button', { name: /^Batch/ }).click();
  const format = page.getByRole('combobox', { name: 'Format' });
  const formats = await format.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  expect(formats.length).toBeGreaterThanOrEqual(8);
  for (const value of formats) {
    await format.selectOption(value);
    await expect(page.getByTestId('export-preview')).toContainText(/Demonic Tutor|Aether Vial/);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
    expect(download.suggestedFilename()).toBeTruthy();
  }

  // None of it needed the network.
  expect(failed.filter((path) => path.includes('/data/') || path.includes('/ocr/'))).toEqual([]);
});

test('shows the first download as it goes', async ({ page, context }) => {
  // A slow connection for the card data, so that the download takes a while.
  await context.route('**/data/**', async (route) => {
    if (!route.request().url().includes('manifest.json')) await new Promise((resolve) => setTimeout(resolve, 150));
    await route.continue();
  });
  await page.goto('./');
  await expect(page.getByRole('status').filter({ hasText: /^Downloading card data for offline use: \d+%/ })).toBeVisible({ timeout: 30_000 });
  await expect(offlineStatus(page)).toContainText(/downloading for offline use, \d+%/);
  // The app is usable meanwhile.
  await choose(page, 'sol ring', 'Sol Ring');
  await expect(page.getByRole('button', { name: 'Add CMM 410 Nonfoil' })).toBeVisible();
  await expect(offlineStatus(page)).toContainText('ready offline', { timeout: 60_000 });
  await expect(page.getByRole('status').filter({ hasText: /^Downloading card data/ })).toHaveCount(0);
});

test("says what isn't on the device yet when offline before the download finished", async ({ page, context }) => {
  // The printings never arrive.
  await context.route('**/data/printings.*', (route) => route.abort('internetdisconnected'));
  await page.goto('./');
  await openScanner(page);
  await expect(offlineStatus(page)).toContainText('not ready offline yet', { timeout: 30_000 });

  await context.unroute('**/data/printings.*');
  await context.setOffline(true);
  await page.reload();
  await expect(offlineStatus(page)).toContainText('not ready offline: connect to finish downloading');
  await choose(page, 'sol ring', 'Sol Ring');
  await expect(page.getByText("The printings of Sol Ring aren't on this device yet. Connect once to finish downloading card data.")).toBeVisible();
});
