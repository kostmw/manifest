import type { IndexSource } from './catalog';
import type { SetInfo } from './sets';
import { sortPrintings } from './catalog';
import { printingShardFile, printingShardIndex } from './shard';
import type { GameId, GameIndex, IndexFile, IndexManifest, NameDictionary, Printing } from './types';

export { sortPrintings };

const CACHE_NAME = 'manifest-index-v1';
const BASE = `${import.meta.env.BASE_URL}data/`;
const MANIFEST_URL = `${BASE}manifest.json`;

function versionedUrl(file: IndexFile): string {
  return `${BASE}${file.file}?v=${file.sha256.slice(0, 16)}`;
}

/** Cache Storage is missing on insecure origins, so everything also has to work without it. */
async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

/** Cached files that the current manifest no longer points to. */
export function staleCacheEntries(cachedUrls: readonly string[], currentUrls: ReadonlySet<string>): string[] {
  return cachedUrls.filter((url) => {
    const { pathname, search } = new URL(url, 'https://x.invalid');
    if (!search) return false; // The manifest's own entry has no version.
    return !currentUrls.has(`${pathname}${search}`);
  });
}

async function removeStaleEntries(cache: Cache, manifest: IndexManifest): Promise<void> {
  const current = new Set<string>();
  for (const game of Object.values(manifest.games)) {
    for (const file of [game.names, ...game.shards, ...(game.hashes ?? []), ...(game.collectors ? [game.collectors] : []), ...(game.sets ? [game.sets] : [])]) {
      current.add(versionedUrl(file));
    }
  }
  const keys = await cache.keys();
  const stale = staleCacheEntries(keys.map((request) => request.url), current);
  await Promise.all(stale.map((url) => cache.delete(url)));
}

async function fetchManifest(): Promise<IndexManifest> {
  const cache = await openCache();
  try {
    const response = await fetch(MANIFEST_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Card index unavailable (HTTP ${response.status})`);
    const copy = response.clone();
    const manifest = (await response.json()) as IndexManifest;
    if (cache) {
      await cache.put(MANIFEST_URL, copy);
      void removeStaleEntries(cache, manifest);
    }
    return manifest;
  } catch (error) {
    const cached = await cache?.match(MANIFEST_URL);
    if (cached) return (await cached.json()) as IndexManifest;
    throw error;
  }
}

let manifestPromise: Promise<IndexManifest> | null = null;

export function loadManifest(): Promise<IndexManifest> {
  manifestPromise ??= fetchManifest().catch((error: unknown) => {
    manifestPromise = null; // Let the next attempt try again.
    throw error;
  });
  return manifestPromise;
}

async function loadGameIndex(game: GameId): Promise<GameIndex> {
  const index = (await loadManifest()).games[game];
  if (!index) throw new Error(`The card index has no data for ${game}`);
  return index;
}

/** File names change content but never name, so the version in the URL decides what is cached. */
async function fetchIndexResponse(file: IndexFile): Promise<Response> {
  const url = versionedUrl(file);
  const cache = await openCache();
  const cached = await cache?.match(url);
  if (cached) return cached;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't download ${file.file} (HTTP ${response.status})`);
  if (cache) await cache.put(url, response.clone());
  return response;
}

async function fetchIndexFile<T>(file: IndexFile): Promise<T> {
  return (await (await fetchIndexResponse(file)).json()) as T;
}

/** The index as recognition reads it (see catalog.ts), fetched and cached like everything else. */
export function browserIndexSource(game: GameId): IndexSource {
  return {
    gameIndex: () => loadGameIndex(game),
    json: fetchIndexFile,
    bytes: async (file) => new Uint8Array(await (await fetchIndexResponse(file)).arrayBuffer()),
  };
}

export async function loadNameDictionary(game: GameId): Promise<NameDictionary> {
  return fetchIndexFile<NameDictionary>((await loadGameIndex(game)).names);
}

export async function loadPrintings(game: GameId, name: string): Promise<Printing[]> {
  const index = await loadGameIndex(game);
  const shardNumber = printingShardIndex(name, index.shards.length);
  const expected = printingShardFile(game, shardNumber);
  const file = index.shards[shardNumber];
  if (file?.file !== expected) throw new Error(`The card index is missing ${expected}`);
  const shard = await fetchIndexFile<Printing[]>(file);
  return sortPrintings(shard.filter((printing) => printing.name === name));
}

/** Every set, newest first. Null for an index built before set lists existed. */
export async function loadSets(game: GameId): Promise<SetInfo[] | null> {
  const index = await loadGameIndex(game);
  return index.sets ? fetchIndexFile<SetInfo[]>(index.sets) : null;
}

/** Lighter image for lists. The index stores `normal` URLs, and Scryfall's sizes differ only in this path part. */
export function thumbnailUrl(imageUrl: string): string {
  return imageUrl.replace('/normal/', '/small/');
}
