/**
 * The owner's round-6 test, as a video for Chromium's fake camera: one foil
 * left in the deck box while the hand-held phone moves over it, with the
 * flashlight's hotspot wandering across the art, the picture blurring, and
 * the camera re-exposing (blown out, then dark) as the flashlight is switched.
 * On the phone that one card was counted 9 times in a minute. It must count
 * once; a different card put on top must count; and an identical copy put
 * down after the card was taken away must count too.
 *
 * Chromium's fake camera has no flashlight, so the app never hears of these
 * switches: the scanner has to cope from the picture alone.
 */
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { FakeCardOptions } from './fakeCard';
import { writeLiveVideo, type Scene } from './liveVideo';

const VIDEO_PATH = resolve('.cache/e2e-live/flashlight.y4m');
const TABLE = { title: '', noCard: true };
const card = { scale: 0.68, rotation: 0.03 };
const SOL_RING = { ...card, title: 'Sol Ring' };
const AETHER_VIAL = { ...card, title: 'Aether Vial', art: ['#20100a', '#f0c080'] as [string, string], rotation: -0.02 };

/**
 * The foil lying there for about 9 s, a quarter second a frame: the phone
 * drifts and twice jumps by about a seventh of the card's diagonal (and back),
 * the hotspot wanders, the picture blurs now and then, and the flashlight
 * switching blows the picture out or darkens it for half a second.
 */
function lyingUnderFlashlight(): Scene[] {
  const spots = [{ x: 244, y: 228 }, { x: 170, y: 190 }, { x: 320, y: 260 }, { x: 210, y: 300 }, { x: 300, y: 160 }];
  const offsets = [0, 0, 0, 0, 80, 80, 80, 80, 80, 0, 0, 0, -75, -75, -75, -75, -75, 0, 0, 0];
  const scenes: Scene[] = [];
  for (let i = 0; i < 36; i++) {
    const look: FakeCardOptions = {
      ...SOL_RING,
      hotspot: 50 + (i % 3) * 8,
      hotspotAt: spots[i % spots.length],
      shimmer: (i * 17) % 60,
      offset: { x: offsets[i % offsets.length]! + ((i * 7) % 9) - 4, y: ((i * 5) % 7) - 3 },
    };
    if (i % 7 === 3) look.blur = 8;
    // The flashlight switched: blown out for a moment, then settling.
    if (i === 14 || i === 15) look.exposure = 2.4 - (i - 14) * 0.6;
    if (i === 26 || i === 27) {
      look.exposure = 0.35 + (i - 26) * 0.25;
      delete look.hotspot;
    }
    scenes.push({ card: look, seconds: 0.25 });
  }
  return scenes;
}

// The video loops, so everything is asserted on its first pass (about 19 s).
const SCENES: Scene[] = [
  { card: TABLE, seconds: 1.5 },
  ...lyingUnderFlashlight(),
  { card: AETHER_VIAL, seconds: 3 },
  { card: TABLE, seconds: 1.5 },
  { card: { ...SOL_RING, offset: { x: 10, y: 0 } }, seconds: 3 },
  { card: TABLE, seconds: 1.5 },
];

test.describe.configure({ timeout: 150_000 });

test.use({
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${VIDEO_PATH}`],
  },
});

test.beforeAll(async () => {
  await writeLiveVideo(VIDEO_PATH, SCENES);
});

test('counts a foil once while the phone moves over it and the flashlight switches, and every other card', async ({ page }) => {
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
  await expect(strip.nth(0)).toContainText('Aether Vial');
  await expect(strip.nth(1)).toContainText('Sol Ring');
  // Taken away, and an identical copy put down: counted.
  await expect(page.getByTestId('scan-counter')).toHaveText('3', { timeout: 30_000 });
  await expect(strip.nth(0)).toContainText('Sol Ring');
  await expect(strip).toHaveCount(3);
});
