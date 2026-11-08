import { expect, test } from '@playwright/test';

test('asks for the camera and shows a live preview', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Camera' }).click();
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
  await page.getByRole('button', { name: 'Camera' }).click();
  await page.getByRole('button', { name: 'Start camera' }).click();

  await expect(page.getByRole('alert')).toContainText('Camera access is blocked');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('turns the camera off when leaving the camera tab', async ({ page }) => {
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      (window as unknown as { testStream: MediaStream }).testStream = stream;
      return stream;
    };
  });
  await page.goto('./');
  await page.getByRole('button', { name: 'Camera' }).click();
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByRole('button', { name: 'Stop camera' })).toBeVisible();

  await page.getByRole('button', { name: 'Add cards' }).click();

  const state = await page.evaluate(() =>
    (window as unknown as { testStream: MediaStream }).testStream.getTracks().map((track) => track.readyState),
  );
  expect(state).toEqual(['ended']);
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

const BLOCKED_STORAGE: Record<string, () => void> = {
  'indexedDB is missing': () => {
    Object.defineProperty(window, 'indexedDB', { value: undefined });
  },
  'opening throws': () => {
    IDBFactory.prototype.open = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
  },
  'opening fails later': () => {
    IDBFactory.prototype.open = function () {
      const request = { error: new DOMException('blocked', 'UnknownError') } as unknown as IDBOpenDBRequest;
      const event = { target: request, preventDefault() {}, stopPropagation() {} } as unknown as Event;
      setTimeout(() => request.onerror?.(event));
      return request;
    };
  },
  'writes fail after opening': () => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
      if (args[1] === 'readwrite') throw new DOMException('blocked', 'QuotaExceededError');
      return original.apply(this, args);
    };
  },
};

for (const [scenario, block] of Object.entries(BLOCKED_STORAGE)) {
  test(`says so when storage is blocked: ${scenario}`, async ({ page }) => {
    await page.addInitScript(block);
    await page.goto('./');
    await expect(page.getByRole('alert')).toContainText('blocking on-device storage');
  });
}

test('explains what to do when the card index is unavailable', async ({ page }) => {
  await page.route('**/data/**', (route) => route.abort());
  await page.goto('./');
  await expect(page.getByRole('alert')).toContainText("Couldn't load the card list");

  await page.unroute('**/data/**');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('combobox', { name: 'Card name' })).toBeEnabled();
});
