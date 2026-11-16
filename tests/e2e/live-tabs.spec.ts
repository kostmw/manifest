/**
 * Leaving the Scan tab and coming back with a card still lying in view
 * (QA H1): the live session remembers the card read last, so it isn't
 * counted again when the camera starts again.
 */
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { writeLiveVideo, type Scene } from './liveVideo';

const VIDEO_PATH = resolve('.cache/e2e-live/tabs.y4m');
const SCENES: Scene[] = [
  { card: { title: '', noCard: true }, seconds: 1.5 },
  { card: { scale: 0.68, rotation: 0.03, title: 'Sol Ring' }, seconds: 40 },
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

test('a card left lying is counted once, after leaving the Scan tab and coming back', async ({ page }) => {
  await page.route('https://cards.scryfall.io/**', (route) => route.abort());
  await page.goto('./');
  const nav = page.getByRole('navigation', { name: 'Sections' });
  await nav.getByRole('button', { name: 'Scan', exact: true }).click();
  await expect(page.getByLabel('Scan a photo')).toBeEnabled({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByTestId('scan-counter')).toHaveText('1', { timeout: 30_000 });

  // Sol Ring has several printings in the sample index, so it waits in Review.
  await nav.getByRole('button', { name: /^Batch/ }).click();
  await expect(nav.getByRole('button', { name: /^Batch/ })).toHaveAttribute('aria-current', 'page');
  await nav.getByRole('button', { name: 'Scan', exact: true }).click();
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByRole('button', { name: 'Start camera' })).toHaveCount(0);
  // Several seconds of the same card in view: still one card.
  await page.waitForTimeout(6000);
  await expect(page.getByTestId('scan-counter')).toHaveText('1');
});
