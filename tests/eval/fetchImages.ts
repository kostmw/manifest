/**
 * Downloads card images for the eval set, politely: one request at a time,
 * at least 100 ms apart, honouring HTTP 429, and cached by Scryfall id so a
 * card is only ever fetched once. Images go to .cache, never into git.
 */
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const HEADERS = {
  'User-Agent': 'ManifestEval/0.1 (+https://github.com/kostmw/manifest)',
  Accept: 'image/jpeg,image/*;q=0.8',
};
const MIN_GAP_MS = 100;
const MAX_ATTEMPTS = 4;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function cachedImagePath(cacheDir: string, id: string): string {
  return join(cacheDir, `${id}.jpg`);
}

export async function fetchImages(
  cards: readonly { id: string; image: string }[],
  cacheDir: string,
  log: (message: string) => void = () => {},
): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  const missing = cards.filter((card) => !existsSync(cachedImagePath(cacheDir, card.id)));
  if (missing.length > 0) log(`Downloading ${missing.length} card images from Scryfall…`);

  let last = 0;
  for (const [index, card] of missing.entries()) {
    for (let attempt = 1; ; attempt++) {
      const wait = last + MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();

      const response = await fetch(card.image, { headers: HEADERS });
      if (response.status === 429 || response.status >= 500) {
        if (attempt >= MAX_ATTEMPTS) throw new Error(`Scryfall image ${card.id}: HTTP ${response.status}`);
        const retryAfter = Number(response.headers.get('Retry-After'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * attempt);
        continue;
      }
      if (!response.ok) throw new Error(`Scryfall image ${card.id}: HTTP ${response.status}`);

      const path = cachedImagePath(cacheDir, card.id);
      await writeFile(`${path}.partial`, new Uint8Array(await response.arrayBuffer()));
      await rename(`${path}.partial`, path);
      break;
    }
    if ((index + 1) % 50 === 0) log(`  ${index + 1}/${missing.length}`);
  }
}
