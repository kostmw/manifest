import { expect, test } from '@playwright/test';

test('asks for the camera and shows a live preview', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Start camera' }).click();

  const video = page.getByTestId('camera-video');
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.videoWidth))
    .toBeGreaterThan(0);

  // Frames must actually advance, or this is a frozen picture rather than a preview.
  const firstTime = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime))
    .toBeGreaterThan(firstTime);

  await page.getByRole('button', { name: 'Stop camera' }).click();
  await expect(video).toBeHidden();
  await expect(page.getByRole('button', { name: 'Start camera' })).toBeVisible();
});

test('explains what to do when the camera is denied', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });
  await page.goto('./');
  await page.getByRole('button', { name: 'Start camera' }).click();

  await expect(page.getByRole('alert')).toContainText('Camera access is blocked');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('shows the legal notice and data attribution', async ({ page }) => {
  await page.goto('./');
  const footer = page.getByRole('contentinfo');
  await expect(footer).toContainText('unofficial fan content');
  await expect(footer).toContainText('Wizards of the Coast');
  await expect(footer).toContainText('Card data © Scryfall');
});

test('serves an installable web app manifest and a service worker', async ({ page, request }) => {
  await page.goto('./');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();

  const response = await request.get(new URL(href!, page.url()).toString());
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(
    expect.arrayContaining(['192x192', '512x512']),
  );

  const registered = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return Boolean(registration.active);
  });
  expect(registered).toBe(true);
});
