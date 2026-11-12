/**
 * Writes a Y4M video of fake cards for Chromium's fake camera
 * (--use-file-for-fake-video-capture), so the live scanner can be tested end
 * to end: cards put down, taken away, stacked, or left lying. The frames are
 * drawn by drawFakeCard in a throwaway browser, then converted to I420.
 */
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import { drawFakeCard, type FakeCardOptions } from './fakeCard';

export interface Scene {
  card: FakeCardOptions;
  seconds: number;
}

export const VIDEO = { width: 960, height: 540, fps: 4 };

/** RGBA → I420 (BT.601, full range, as the Y4M default 420jpeg expects). */
function toI420(rgba: Uint8Array, width: number, height: number): Buffer {
  const out = Buffer.alloc((width * height * 3) / 2);
  const uOffset = width * height;
  const vOffset = uOffset + (width * height) / 4;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      out[y * width + x] = Math.round(0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!);
    }
  }
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const i = ((y + dy) * width + x + dx) * 4;
        r += rgba[i]!;
        g += rgba[i + 1]!;
        b += rgba[i + 2]!;
      }
      r /= 4;
      g /= 4;
      b /= 4;
      const c = (y / 2) * (width / 2) + x / 2;
      out[uOffset + c] = Math.max(0, Math.min(255, Math.round(128 - 0.168736 * r - 0.331264 * g + 0.5 * b)));
      out[vOffset + c] = Math.max(0, Math.min(255, Math.round(128 + 0.5 * r - 0.418688 * g - 0.081312 * b)));
    }
  }
  return out;
}

export async function writeLiveVideo(path: string, scenes: readonly Scene[]): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await mkdir(dirname(path), { recursive: true });
    const file = await open(path, 'w');
    try {
      await file.write(`YUV4MPEG2 W${VIDEO.width} H${VIDEO.height} F${VIDEO.fps}:1 Ip A1:1\n`);
      for (const scene of scenes) {
        const dataUrl = await page.evaluate(drawFakeCard, { ...scene.card, width: VIDEO.width, height: VIDEO.height });
        const png = PNG.sync.read(Buffer.from(dataUrl.split(',')[1]!, 'base64'));
        const frame = toI420(png.data, png.width, png.height);
        for (let i = 0; i < Math.round(scene.seconds * VIDEO.fps); i++) {
          await file.write('FRAME\n');
          await file.write(frame);
        }
      }
    } finally {
      await file.close();
    }
  } finally {
    await browser.close();
  }
}
