import { PNG } from 'pngjs';
import { expect, test, type Page } from '@playwright/test';
import { drawFakeCard, drawFakeSpread, type FakeCardOptions } from './fakeCard';

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async ({ page }) => {
  // Thumbnails come from Scryfall's CDN. These tests shouldn't depend on it, or hit it.
  await page.route('https://cards.scryfall.io/**', (route) => route.abort());
  await page.goto('./');
  await openScanner(page);
});

async function openScanner(page: Page) {
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Scan', exact: true }).click();
  await expect(page.getByLabel('Import photos')).toBeEnabled({ timeout: 60_000 });
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Sections' });
const panel = (page: Page) => page.getByRole('region', { name: 'Import' });

type Upload = { name: string; mimeType: string; buffer: Buffer };

async function cardPhoto(page: Page, name: string, options: FakeCardOptions): Promise<Upload> {
  const dataUrl = await page.evaluate(drawFakeCard, options);
  return { name, mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1]!, 'base64') };
}

/** A small plain picture with no card in it; `seed` makes each one a different file. */
function plainPhoto(name: string, seed: number, size = 48): Upload {
  const png = new PNG({ width: size, height: size });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 90;
    png.data[i + 1] = 100 + (seed % 50);
    png.data[i + 2] = 120;
    png.data[i + 3] = 255;
  }
  // A few pixels that spell out the seed, so no two files are the same.
  for (let bit = 0; bit < 16; bit++) png.data[bit * 4] = (seed >> bit) & 1 ? 255 : 0;
  return { name, mimeType: 'image/png', buffer: PNG.sync.write(png) };
}

const SOL_RING = { title: 'Sol Ring', collector: { set: 'CMM', number: '410', rarity: 'U' } };
const TUTOR = { title: 'Demonic Tutor', collector: { set: 'CMM', number: '509', rarity: 'M' } };

/** Sol Rings, each drawn a little differently, so each is a file of its own. */
async function solRings(page: Page, count: number): Promise<Upload[]> {
  const files: Upload[] = [];
  for (let i = 0; i < count; i++) files.push(await cardPhoto(page, `ring-${i + 1}.png`, { ...SOL_RING, rotation: 0.02 + i * 0.01 }));
  return files;
}

test('imports a stack of photos: adds the sure cards, queues the unsure ones, lists the photos that gave no card', async ({ page }) => {
  const files = [
    await cardPhoto(page, 'IMG_0001.png', SOL_RING),
    await cardPhoto(page, 'IMG_0002.png', { ...TUTOR, flipped: true, rotation: -0.1 }),
    // Two printings and no collector line: the scanner can't tell which.
    await cardPhoto(page, 'IMG_0003.png', { title: 'Lightning Bolt' }),
    plainPhoto('IMG_0004.png', 4, 480),
    { name: 'IMG_0005.png', mimeType: 'image/png', buffer: Buffer.from('not really a picture') },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('box 3') },
  ];
  await page.getByLabel('Import photos').setInputFiles(files);

  const status = panel(page).getByRole('status');
  await expect(status).toContainText('Import finished: 6 photos', { timeout: 120_000 });
  await expect(page.getByTestId('import-tally')).toHaveText('2 cards added · 1 to review · 3 without a card');
  await expect(nav(page).getByRole('button', { name: 'Batch (2)' })).toBeVisible();
  await expect(nav(page).getByRole('button', { name: 'Review (1)' })).toBeVisible();

  const failures = panel(page).getByRole('list', { name: 'Photos to look at' });
  await expect(failures.getByRole('listitem')).toHaveCount(3);
  await expect(failures.getByRole('listitem').filter({ hasText: 'IMG_0004.png' })).toContainText('No card found');
  await expect(failures.getByRole('listitem').filter({ hasText: 'IMG_0005.png' })).toContainText('This browser can’t open it');
  await expect(failures.getByRole('listitem').filter({ hasText: 'notes.txt' })).toContainText('Not a picture');

  // The photo with no card can still go to review, to be named by search.
  await failures.getByRole('button', { name: 'Review IMG_0004.png anyway' }).click();
  await expect(failures.getByRole('listitem')).toHaveCount(2);
  await expect(nav(page).getByRole('button', { name: 'Review (2)' })).toBeVisible();
  await expect(page.getByTestId('import-tally')).toHaveText('2 cards added · 2 to review · 2 without a card');

  // Picking the same photos again reads nothing twice.
  await page.getByLabel('Import photos').setInputFiles(files.slice(0, 3));
  await expect(status).toContainText('Import finished: 3 photos', { timeout: 60_000 });
  await expect(page.getByTestId('import-tally')).toHaveText('0 cards added · 3 skipped');
  await expect(panel(page)).toContainText('3 photos were read into this batch before, so they were skipped.');
  await expect(nav(page).getByRole('button', { name: 'Batch (2)' })).toBeVisible();

  await panel(page).getByRole('button', { name: 'Close' }).click();
  await expect(panel(page)).toHaveCount(0);
});

test('carries on while another tab is open, pauses, resumes and cancels', async ({ page }) => {
  const files = await solRings(page, 8);
  await page.getByLabel('Import photos').setInputFiles(files);
  const status = panel(page).getByRole('status');
  await expect(status).toContainText(/Importing photos: [1-7] of 8 photos/, { timeout: 60_000 });

  // Leaving the Scan tab doesn't stop it.
  await nav(page).getByRole('button', { name: /^Batch/ }).click();
  await expect(nav(page).getByRole('button', { name: /^Batch \([2-8]\)$/ })).toBeVisible({ timeout: 60_000 });
  await nav(page).getByRole('button', { name: 'Scan', exact: true }).click();

  await panel(page).getByRole('button', { name: 'Pause' }).click();
  await expect(status).toContainText('Import paused');
  // It stops after the photo being read, then reads nothing more.
  await page.waitForTimeout(3000);
  const paused = await status.textContent();
  await page.waitForTimeout(3000);
  expect(await status.textContent()).toBe(paused);
  const readWhilePaused = Number(/(\d) of 8/.exec(paused ?? '')?.[1]);
  expect(readWhilePaused).toBeLessThan(8);

  await panel(page).getByRole('button', { name: 'Resume' }).click();
  await expect(status).toContainText(new RegExp(`Importing photos: [${readWhilePaused + 1}-7] of 8`), { timeout: 60_000 });
  await panel(page).getByRole('button', { name: 'Cancel import' }).click();
  await expect(status).toContainText(/Import cancelled: \d of 8 photos read/, { timeout: 60_000 });
  const read = Number(/(\d) of 8/.exec((await status.textContent()) ?? '')?.[1]);
  expect(read).toBeLessThan(8);
  // Every card read was kept.
  await expect(nav(page).getByRole('button', { name: `Batch (${read})` })).toBeVisible();
  await expect(panel(page)).toContainText('The cards read so far are in the batch');
});

test('after a reload, says what finished, and picking the same photos again reads only the rest', async ({ page }) => {
  const files = await solRings(page, 6);
  await page.getByLabel('Import photos').setInputFiles(files);
  await expect(panel(page).getByRole('status')).toContainText(/Importing photos: [2-5] of 6 photos/, { timeout: 60_000 });

  await page.reload();
  await openScanner(page);
  const status = panel(page).getByRole('status');
  await expect(status).toContainText(/Import stopped before it finished: [2-5] of 6 photos read/);
  const before = Number(/(\d) of 6/.exec((await status.textContent()) ?? '')?.[1]);
  await expect(panel(page)).toContainText('pick the same photos again: the ones already read are skipped');
  await expect(nav(page).getByRole('button', { name: `Batch (${before})` })).toBeVisible();

  const chooser = page.waitForEvent('filechooser');
  await panel(page).getByRole('button', { name: 'Pick the photos again' }).click();
  await (await chooser).setFiles(files);
  await expect(status).toContainText('Import finished: 6 photos', { timeout: 90_000 });
  await expect(page.getByTestId('import-tally')).toHaveText(`${6 - before} cards added · ${before} skipped`);
  // Each card once.
  await expect(nav(page).getByRole('button', { name: 'Batch (6)' })).toBeVisible();
});

test('reads a thousand photos one at a time without holding up the page', async ({ page }) => {
  test.setTimeout(600_000);
  const files = Array.from({ length: 1000 }, (_, i) => plainPhoto(`scan-${String(i + 1).padStart(4, '0')}.png`, i));
  await page.evaluate(() => {
    const w = window as unknown as { longTasks: number[] };
    w.longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.longTasks.push(entry.duration);
    }).observe({ type: 'longtask', buffered: false });
  });
  const heap = () => page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);

  await page.getByLabel('Import photos').setInputFiles(files);
  const status = panel(page).getByRole('status');
  await expect(status).toContainText(/Importing photos: (1\d\d|2\d\d) of 1,000 photos/, { timeout: 300_000 });
  const early = await heap();

  // The page answers while it runs: switching tabs and back.
  await nav(page).getByRole('button', { name: /^Batch/ }).click();
  await nav(page).getByRole('button', { name: 'Scan', exact: true }).click();

  await expect(status).toContainText('Import finished: 1,000 photos', { timeout: 540_000 });
  await expect(page.getByTestId('import-tally')).toHaveText('0 cards added · 1,000 without a card');
  const failures = panel(page).getByRole('list', { name: 'Photos to look at' });
  await expect(failures.getByRole('listitem')).toHaveCount(30);
  await expect(panel(page).getByRole('button', { name: 'Show all 1,000' })).toBeVisible();

  const longTasks = await page.evaluate(() => (window as unknown as { longTasks: number[] }).longTasks);
  const late = await heap();
  console.log(`long tasks: ${longTasks.length}, longest ${Math.round(Math.max(0, ...longTasks))} ms; heap ${Math.round(early / 1e6)} → ${Math.round(late / 1e6)} MB`);
  // No main-thread task long enough to freeze the page.
  expect(Math.max(0, ...longTasks)).toBeLessThan(500);
  // Memory doesn't grow with the number of photos read.
  if (early > 0) expect(late - early).toBeLessThan(40e6);
});

/** A photo of several fake cards in a row on the table. */
async function spreadPhoto(page: Page, name: string, cards: FakeCardOptions[], size = { width: 2400, height: 1150 }): Promise<Upload> {
  const layers: string[] = [];
  const pitch = size.width / cards.length;
  for (const [i, card] of cards.entries()) {
    layers.push(
      await page.evaluate(drawFakeCard, {
        ...card,
        transparent: true,
        width: size.width,
        height: size.height,
        // As big as in the one-card photos: the collector line is what settles a printing.
        scale: 1.15,
        rotation: card.rotation ?? 0.03 * (i - 1),
        offset: { x: -size.width / 2 + pitch * (i + 0.5), y: 0 },
      }),
    );
  }
  const dataUrl = await page.evaluate(drawFakeSpread, { layers, width: size.width, height: size.height });
  return { name, mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1]!, 'base64') };
}

// At the angles the one-card tests read them at.
const THREE = [{ ...SOL_RING, rotation: 0.06 }, { ...TUTOR, flipped: true, rotation: -0.1 }, { title: 'Lightning Bolt', rotation: 0.06 }];

test('reads every card in a photo of several, from Scan a photo', async ({ page }) => {
  const upload = await spreadPhoto(page, 'spread.png', THREE);
  if (process.env.SAVE_SPREAD) (await import('node:fs')).writeFileSync(process.env.SAVE_SPREAD, upload.buffer);
  await page.getByLabel('Scan a photo').setInputFiles(upload);
  const summary = page.getByTestId('photo-several');
  await expect(summary).toContainText('Found 3 cards in the photo: 2 added, 1 waiting in Review.', { timeout: 60_000 });
  await expect(nav(page).getByRole('button', { name: 'Batch (2)' })).toBeVisible();
  await expect(nav(page).getByRole('button', { name: 'Review (1)' })).toBeVisible();
  const strip = page.getByRole('list', { name: 'Last cards scanned' });
  await expect(strip.getByRole('button', { name: 'Sol Ring, CMM 410, added' })).toBeVisible();
  await expect(strip.getByRole('button', { name: 'Demonic Tutor, CMM 509, added' })).toBeVisible();
  // One card per photo still gets its own confirm step.
  await expect(page.getByRole('region', { name: 'Scan result' })).toHaveCount(0);
});

test('imports photos of several cards, each card filed', async ({ page }) => {
  const files = [await spreadPhoto(page, 'page-1.png', THREE), await cardPhoto(page, 'single.png', SOL_RING)];
  await page.getByLabel('Import photos').setInputFiles(files);
  await expect(panel(page).getByRole('status')).toContainText('Import finished: 2 photos', { timeout: 90_000 });
  await expect(page.getByTestId('import-tally')).toHaveText('3 cards added · 1 to review');
  await expect(nav(page).getByRole('button', { name: 'Batch (3)' })).toBeVisible();
});
