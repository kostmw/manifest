/**
 * The card index as the app reads it, in any thread: the main thread, the
 * name-search worker and the recognition worker each load it through this
 * module (see indexBuilds.ts for how builds are kept on the device).
 *
 * Each thread reads the active build from the cache first, so it starts at
 * once offline or on a weak signal, and stays on that build: names,
 * collectors, fingerprints and printings always come from one build. When the
 * main thread's update check (indexUpdates.ts) switches builds, it says so on
 * a BroadcastChannel, and every thread moves to the new one (onBuildChange).
 */
import type { IndexSource } from './catalog';
import type { SetInfo } from './sets';
import { sortPrintings } from './catalog';
import {
  downloadFile,
  IndexFileMismatch,
  installFirst,
  isUsableManifest,
  manifestUrl,
  readActive,
  readCached,
  sameBuild,
  updateBuild,
  type IndexStore,
  type UpdateOutcome,
} from './indexBuilds';
import { printingShardFile, printingShardIndex } from './shard';
import type { GameId, GameIndex, IndexFile, IndexManifest, NameDictionary, Printing } from './types';

export { sortPrintings };

const CACHE_NAME = 'manifest-index-v1';
const BASE = `${import.meta.env.BASE_URL}data/`;
const CHANNEL_NAME = 'manifest-index';

type ChannelMessage =
  /** A new build is active. */
  | { type: 'switched'; buildDate: string }
  /** A thread was served a file from another build than its own: worth checking for an update. */
  | { type: 'stale' };

let storePromise: Promise<IndexStore | null> | null = null;

/** Cache Storage is missing on insecure origins, so everything also has to work without it. */
function openStore(): Promise<IndexStore | null> {
  storePromise ??= (async () => {
    try {
      if (typeof caches === 'undefined') return null;
      const cache = await caches.open(CACHE_NAME);
      return {
        match: (url) => cache.match(url),
        put: (url, response) => cache.put(url, response),
        delete: (url) => cache.delete(url),
        keys: async () => (await cache.keys()).map((request) => request.url),
      };
    } catch {
      return null;
    }
  })();
  return storePromise;
}

const listeners = new Set<(manifest: IndexManifest) => void>();
const staleListeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;

function openChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<ChannelMessage>) => {
    if (event.data?.type === 'switched') void followActive();
    if (event.data?.type === 'stale') staleListeners.forEach((listener) => listener());
  };
  return channel;
}

let manifestPromise: Promise<IndexManifest> | null = null;

/** The active build, or on the very first launch the server's, which then becomes active. */
async function pinBuild(): Promise<IndexManifest> {
  const store = await openStore();
  const active = store ? await readActive(store, BASE) : null;
  if (active) return active;
  const response = await fetch(manifestUrl(BASE), { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Card index unavailable (HTTP ${response.status})`);
  const latest: unknown = await response.json();
  if (!isUsableManifest(latest)) throw new Error("This version of the app can't read the card index. Reload to update it.");
  return store ? installFirst(store, BASE, latest) : latest;
}

/** The build this thread reads, the same one until a switch. */
export function loadManifest(): Promise<IndexManifest> {
  openChannel();
  manifestPromise ??= pinBuild().catch((error: unknown) => {
    manifestPromise = null; // Let the next attempt try again.
    throw error;
  });
  return manifestPromise;
}

/** Moves this thread to the active build, if it isn't on it already, and tells whoever is listening. */
async function followActive(): Promise<void> {
  const store = await openStore();
  const active = store ? await readActive(store, BASE) : null;
  if (!active) return;
  const current = await manifestPromise?.catch(() => null);
  if (current && sameBuild(current, active)) return;
  manifestPromise = Promise.resolve(active);
  listeners.forEach((listener) => listener(active));
}

/** Called with the new build whenever this thread moves to one. Returns a function that stops it. */
export function onBuildChange(listener: (manifest: IndexManifest) => void): () => void {
  openChannel();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called when any thread is served a file from another build than its own. */
export function onStaleBuild(listener: () => void): () => void {
  openChannel();
  staleListeners.add(listener);
  return () => staleListeners.delete(listener);
}

function indexOf(manifest: IndexManifest, game: GameId): GameIndex {
  const index = manifest.games[game];
  if (!index) throw new Error(`The card index has no data for ${game}`);
  return index;
}

async function loadGameIndex(game: GameId): Promise<GameIndex> {
  return indexOf(await loadManifest(), game);
}

const network = (url: string, init?: RequestInit) => fetch(url, init);

/** A file of the index: from the cache, else downloaded, checked against its manifest entry and cached. */
async function indexFileBytes(file: IndexFile): Promise<Uint8Array> {
  const store = await openStore();
  const cached = store ? await readCached(store, BASE, file).catch(() => null) : null;
  if (cached) return cached;
  try {
    return await downloadFile({ fetch: network, base: BASE, store }, file);
  } catch (error) {
    if (error instanceof IndexFileMismatch) {
      // This thread's build is older than the server's: never use the file, and look for the new build.
      void followActive();
      openChannel()?.postMessage({ type: 'stale' } satisfies ChannelMessage);
      staleListeners.forEach((listener) => listener());
    }
    throw error;
  }
}

async function fetchIndexFile<T>(file: IndexFile): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await indexFileBytes(file))) as T;
}

/**
 * The index as recognition reads it (see catalog.ts). Given a build, it reads
 * only that build, whatever happens meanwhile: the recognition worker passes
 * one, so that a catalog never mixes files from two builds.
 */
export function browserIndexSource(game: GameId, manifest?: IndexManifest): IndexSource {
  return {
    gameIndex: async () => (manifest ? indexOf(manifest, game) : loadGameIndex(game)),
    json: fetchIndexFile,
    bytes: indexFileBytes,
  };
}

export async function loadNameDictionary(game: GameId, manifest?: IndexManifest): Promise<NameDictionary> {
  return fetchIndexFile<NameDictionary>((manifest ? indexOf(manifest, game) : await loadGameIndex(game)).names);
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

/**
 * Looks for a newer build on the server and switches to it once it is
 * downloaded (indexBuilds.ts updateBuild). Run by the main thread only.
 */
export async function checkForIndexUpdate(
  onProgress?: (progress: { done: number; total: number; bytes: number }) => void,
): Promise<UpdateOutcome | { kind: 'unavailable' }> {
  const store = await openStore();
  if (!store) return { kind: 'unavailable' };
  return updateBuild({
    store,
    fetch: network,
    base: BASE,
    onProgress,
    announce: (manifest) => {
      openChannel()?.postMessage({ type: 'switched', buildDate: manifest.buildDate } satisfies ChannelMessage);
      void followActive();
    },
  });
}

/** Lighter image for lists. The index stores `normal` URLs, and Scryfall's sizes differ only in this path part. */
export function thumbnailUrl(imageUrl: string): string {
  return imageUrl.replace('/normal/', '/small/');
}
