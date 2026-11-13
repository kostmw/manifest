/**
 * The live scanner end to end, on a video of fake cards played by Chromium's
 * fake camera: two identical copies count as two, a card left lying counts
 * once, and a different card put on top counts at once.
 */
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { writeLiveVideo, type Scene } from './liveVideo';

const VIDEO_PATH = resolve('.cache/e2e-live/stack.y4m');
const TABLE = { title: '', noCard: true };
const card = { scale: 0.68, rotation: 0.03 };
const SOL_RING = { ...card, title: 'Sol Ring' };
/** One printing in the sample index, so it is added without review. Other art, so another fingerprint. */
const AETHER_VIAL = { ...card, title: 'Aether Vial', art: ['#20100a', '#f0c080'] as [string, string], rotation: -0.02 };

// The video loops, so everything is asserted on its first pass (about 15 s).
const SCENES: Scene[] = [
  { card: TABLE, seconds: 1.5 },
  // A card put down and left lying for a while: counted once.
  { card: SOL_RING, seconds: 3.5 },
  // Taken away, and an identical copy put down a little to the side: counted again.
  { card: TABLE, seconds: 1 },
  { card: { ...SOL_RING, offset: { x: 18, y: -6 }, rotation: 0.0 }, seconds: 3.5 },
  // A different card put straight on top, the view never empty: counted at once.
  { card: AETHER_VIAL, seconds: 3.5 },
  { card: TABLE, seconds: 2 },
];

test.describe.configure({ timeout: 120_000 });

test.use({
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${VIDEO_PATH}`],
  },
});

test.beforeAll(async () => {
  await writeLiveVideo(VIDEO_PATH, SCENES);
});

test('counts copies and stacked cards without a confirm step, while the camera keeps watching', async ({ page }) => {
  await page.route('https://cards.scryfall.io/**', (route) => route.abort());
  // As in Safari, whose Audio Session API is how the beeps get past the silent switch.
  await page.addInitScript(() => Object.defineProperty(navigator, 'audioSession', { value: { type: 'auto' }, configurable: true }));
  await page.goto('./');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Scan', exact: true }).click();
  await expect(page.getByLabel('Scan a photo')).toBeEnabled({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Start camera' }).click();

  const strip = page.getByRole('list', { name: 'Last cards scanned' }).getByRole('listitem');
  // Each card is filed as soon as it is read: the camera never stops for a result screen.
  await expect(page.getByTestId('scan-counter')).toHaveText('1', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Start camera' })).toHaveCount(0);
  await expect(strip.first()).toContainText('Sol Ring');

  // When the third card is counted, it is Aether Vial: the Sol Ring left lying wasn't counted twice.
  await expect(page.getByTestId('scan-counter')).toHaveText('3', { timeout: 30_000 });
  await expect(strip).toHaveCount(3);
  await expect(strip.nth(0)).toContainText('Aether Vial');
  await expect(strip.nth(0).getByRole('button', { name: /^Aether Vial, .*, added$/ })).toBeVisible();
  await expect(strip.nth(1)).toContainText('Sol Ring');
  await expect(strip.nth(2)).toContainText('Sol Ring');

  // After the first card, once: the silent switch may be why there is no beep.
  const tip = page.getByRole('complementary', { name: 'Sound tip' });
  await expect(tip).toContainText('silent switch');
  await tip.getByRole('button', { name: 'Beep even in silent mode' }).click();
  await expect(tip).toHaveCount(0);
  await page.getByText('Sound and testing', { exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Sound' })).toHaveValue('always');
  expect(await page.evaluate(() => (navigator as Navigator & { audioSession: { type: string } }).audioSession.type)).toBe('playback');
});
