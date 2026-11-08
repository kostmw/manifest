/**
 * Renders the PWA icons from app/public/icon.svg. Run by hand when the icon
 * changes (`npx tsx scripts/render-icons.ts`); the PNGs are committed.
 */
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const svg = await readFile('app/public/icon.svg', 'utf8');
const browser = await chromium.launch();

async function render(file: string, size: number, artScale: number): Promise<void> {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<!doctype html><body style="margin:0;background:#18181b;display:grid;place-items:center;height:100vh">
     <div style="width:${artScale * 100}%;aspect-ratio:1">${svg}</div></body>`,
  );
  await page.screenshot({ path: `app/public/${file}` });
  await page.close();
}

await render('icon-192.png', 192, 1);
await render('icon-512.png', 512, 1);
// Maskable icons can be cropped to a circle, so the art stays in the safe zone.
await render('icon-maskable-512.png', 512, 0.8);
await browser.close();
