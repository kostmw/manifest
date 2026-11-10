/**
 * Card images for building the fingerprint index. They come from Scryfall's
 * image CDN in the `small` size (146×204, about 12 KB), which is plenty for
 * 32×32 perceptual hashes. A local directory can keep them between builds;
 * CI keeps only the hashes. Images never go into git.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PoliteFetcher } from './politeFetch';

export const IMAGE_HEADERS = {
  'User-Agent': 'ManifestIndexBuilder/0.1 (+https://github.com/kostmw/manifest)',
  Accept: 'image/jpeg,image/*;q=0.8',
};

/** The index stores `normal` URLs; Scryfall's sizes differ only in this path part. */
export function smallImageUrl(normalUrl: string): string {
  return normalUrl.replace('/normal/', '/small/');
}

/** Scryfall appends a timestamp that changes whenever the scan does. */
export function imageVersion(url: string): string {
  return /\?(\d+)/.exec(url)?.[1] ?? '';
}

export class CardImageStore {
  constructor(
    private readonly fetcher: PoliteFetcher,
    /** Keep downloaded images here, or null to keep nothing. */
    private readonly dir: string | null,
  ) {}

  private path(id: string, version: string): string {
    return join(this.dir!, id.slice(0, 2), `${id}.${version || '0'}.jpg`);
  }

  has(id: string, url: string): boolean {
    return this.dir !== null && existsSync(this.path(id, imageVersion(smallImageUrl(url))));
  }

  /** JPEG bytes, or null when Scryfall has no image. */
  async get(id: string, url: string): Promise<Uint8Array | null> {
    const small = smallImageUrl(url);
    const version = imageVersion(small);
    if (this.dir) {
      const path = this.path(id, version);
      if (existsSync(path)) return new Uint8Array(await readFile(path));
    }
    const bytes = await this.fetcher.bytes(small);
    if (bytes && this.dir) {
      const path = this.path(id, version);
      await mkdir(join(this.dir, id.slice(0, 2)), { recursive: true });
      await writeFile(`${path}.partial`, bytes);
      await rename(`${path}.partial`, path);
    }
    return bytes;
  }
}

export function scryfallImageFetcher(): PoliteFetcher {
  // *.scryfall.io has no published rate limit; this stays at the API's polite 50 ms anyway.
  return new PoliteFetcher({ headers: IMAGE_HEADERS, minGapMs: 50, concurrency: 6 });
}
