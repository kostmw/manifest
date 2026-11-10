/**
 * Visual fingerprints for every printing, built incrementally: a cache file
 * remembers each printing's fingerprint together with the image version it
 * came from, so a nightly build only downloads cards that are new or whose
 * scan changed. CI keeps the cache between runs; the images themselves are
 * only kept when an image directory is given (useful locally).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Printing } from '../app/src/games/types';
import { FINGERPRINT_BYTES, FINGERPRINT_VERSION, fingerprintCardImage, type FingerprintRegions } from '../app/src/recognize/fingerprint';
import { CardImageStore, imageVersion, scryfallImageFetcher, smallImageUrl } from './cardImages';
import { decodeJpeg } from './jpeg';

export type FingerprintMode = 'fetch' | 'cache-only' | 'none';

interface CacheFile {
  version: number;
  /** Printing id → [image version, fingerprint as hex]. An empty fingerprint means Scryfall had no image. */
  entries: Record<string, [string, string]>;
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));

async function readCache(path: string): Promise<CacheFile> {
  if (!existsSync(path)) return { version: FINGERPRINT_VERSION, entries: {} };
  const cache = JSON.parse(await readFile(path, 'utf8')) as CacheFile;
  // A different algorithm makes every cached fingerprint useless.
  return cache.version === FINGERPRINT_VERSION ? cache : { version: FINGERPRINT_VERSION, entries: {} };
}

async function writeCache(path: string, cache: CacheFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.partial`, JSON.stringify(cache));
  await rename(`${path}.partial`, path);
}

export interface FingerprintOptions {
  mode: Exclude<FingerprintMode, 'none'>;
  regions: FingerprintRegions;
  cacheFile: string;
  /** Keep downloaded images here between builds; null keeps none. */
  imageDir: string | null;
  log?: (message: string) => void;
}

export interface FingerprintResult {
  fingerprints: Map<string, Uint8Array>;
  /** Printings that have an image URL but no fingerprint (cache-only builds, or failed downloads). */
  missing: number;
  downloaded: number;
}

/** Fingerprints by printing id. Printings without an image get none. */
export async function buildFingerprints(printings: readonly Printing[], options: FingerprintOptions): Promise<FingerprintResult> {
  const log = options.log ?? (() => {});
  const cache = await readCache(options.cacheFile);
  const fingerprints = new Map<string, Uint8Array>();
  const todo: Printing[] = [];
  for (const printing of printings) {
    if (!printing.image) continue;
    const cached = cache.entries[printing.id];
    if (cached && cached[0] === imageVersion(smallImageUrl(printing.image))) {
      if (cached[1]) fingerprints.set(printing.id, fromHex(cached[1]));
    } else {
      todo.push(printing);
    }
  }

  let downloaded = 0;
  let failed = 0;
  const store = new CardImageStore(scryfallImageFetcher(), options.imageDir);
  // A cache-only build never downloads, but still uses images already on disk.
  const work = options.mode === 'fetch' ? todo : todo.filter((printing) => store.has(printing.id, printing.image!));
  if (work.length > 0) {
    log(`Fingerprinting ${work.length} printings (${printings.length - todo.length} cached)…`);
    const queue = [...work];
    let sinceSave = 0;
    const started = Date.now();
    // The fetcher paces the requests; these loops only keep it busy.
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (let printing = queue.shift(); printing; printing = queue.shift()) {
          const version = imageVersion(smallImageUrl(printing.image!));
          try {
            const bytes = await store.get(printing.id, printing.image!);
            if (bytes) {
              const fingerprint = fingerprintCardImage(decodeJpeg(bytes), options.regions);
              fingerprints.set(printing.id, fingerprint);
              cache.entries[printing.id] = [version, toHex(fingerprint)];
            } else {
              cache.entries[printing.id] = [version, ''];
            }
            downloaded++;
          } catch (error) {
            // One bad image shouldn't sink the build; it's retried next time.
            failed++;
            if (failed <= 10) log(`  ${printing.id}: ${(error as Error).message}`);
          }
          if (++sinceSave >= 2000) {
            sinceSave = 0;
            await writeCache(options.cacheFile, cache);
            const rate = downloaded / ((Date.now() - started) / 1000);
            log(`  ${downloaded}/${work.length} (${rate.toFixed(1)}/s)`);
          }
        }
      }),
    );
    await writeCache(options.cacheFile, cache);
  }

  const missing = printings.filter((p) => p.image && !fingerprints.has(p.id) && cache.entries[p.id]?.[1] !== '').length;
  if (missing > 0) log(`${missing} printings have no fingerprint${options.mode === 'cache-only' ? ' (cache-only build)' : ''}.`);
  for (const fingerprint of fingerprints.values()) {
    if (fingerprint.length !== FINGERPRINT_BYTES) throw new Error('Cached fingerprint has the wrong size');
  }
  return { fingerprints, missing, downloaded };
}
