/**
 * The owner's M4 test, as a video for Chromium's fake camera: a foil card left
 * lying under the flashlight (a hotspot on the art, shimmer bands moving, the
 * picture blurring now and then so detection loses the card) must count once;
 * a different card put on top must still count.
 */
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { writeLiveVideo, type Scene } from './liveVideo';

const VIDEO_PATH = resolve('.cache/e2e-live/glare.y4m');
const TABLE = { title: '', noCard: true };
const card = { scale: 0.68, rotation: 0.03 };
const FOIL = { ...card, title: 'Sol Ring', hotspot: 55 };
const AETHER_VIAL = { ...card, title: 'Aether Vial', art: ['#20100a', '#f0c080'] as [string, string], rotation: -0.02 };

/** The foil lying still for `seconds`: plain, shimmering two ways, and blurred, in turn. */
function lyingFoil(seconds: number): Scene[] {
  const looks = [{ ...FOIL }, { ...FOIL, shimmer: 0 }, { ...FOIL, blur: 9 }, { ...FOIL, shimmer: 30 }, { ...FOIL }, { ...FOIL, shimmer: 15 }];
  return Array.from({ length: Math.round(seconds * 2) }, (_, i) => ({ card: looks[i % looks.length]!, seconds: 0.5 }));
}

// The video loops, so everything is asserted on its first pass (about 14 s).
const SCENES: Scene[] = [{ card: TABLE, seconds: 1.5 }, ...lyingFoil(7), { card: AETHER_VIAL, seconds: 3.5 }, { card: TABLE, seconds: 2 }];

test.describe.configure({ timeout: 120_000 });

test.use({
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${VIDEO_PATH}`],
  },
});

test.beforeAll(async () => {
  await writeLiveVideo(VIDEO_PATH, SCENES);
});

test('counts a shimmering card under the flashlight once, while it lies there', async ({ page }) => {
  await page.route('https://cards.scryfall.io/**', (route) => route.abort());
  await page.goto('./?debug=1');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Scan', exact: true }).click();
  await expect(page.getByLabel('Scan a photo')).toBeEnabled({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Start camera' }).click();

  const strip = page.getByRole('list', { name: 'Last cards scanned' }).getByRole('listitem');
  await expect(page.getByTestId('scan-counter')).toHaveText('1', { timeout: 30_000 });
  await expect(strip.first()).toContainText('Sol Ring');
  // When the second card is counted it is Aether Vial: the foil wasn't counted again while it lay there.
  await expect(page.getByTestId('scan-counter')).toHaveText('2', { timeout: 30_000 });
  await expect(strip).toHaveCount(2);
  await expect(strip.nth(0)).toContainText('Aether Vial');
  await expect(strip.nth(1)).toContainText('Sol Ring');
});
