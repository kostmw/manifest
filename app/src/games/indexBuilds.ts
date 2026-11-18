/**
 * Index builds on the device: one consistent build in use, a newer one
 * switched to only once it is all here, and nothing cached that doesn't match
 * its manifest.
 *
 * Every file of a build is named by its manifest entry and cached under
 * `<file>?v=<first 16 hex of sha256>`, so builds share the files they have in
 * common. Two manifests are kept in the same cache:
 *
 * - the active one (`manifest.json`): the build every part of the app reads;
 * - a candidate (`manifest.json?candidate`): a newer build being downloaded.
 *   It becomes active in one write, once every file it needs is cached.
 *
 * GitHub Pages ignores the `?v=`, so around a deploy, or for an app that has
 * been open for days, an old version's URL returns the new file. Every
 * download is therefore checked against the manifest's sha256 before it is
 * cached or used. Entries carry the checked hash in a header, so a cache read
 * needs no second check; entries cached before this existed are checked once.
 *
 * No browser globals beyond fetch's Response and WebCrypto: the cache, the
 * network and the announcement of a switch are passed in, for tests.
 */
import type { GameId, IndexFile, IndexManifest } from './types';

/** The parts of Cache Storage this needs, with URLs as strings. */
export interface IndexStore {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
  delete(url: string): Promise<boolean>;
  /** Every cached URL, absolute. */
  keys(): Promise<string[]>;
}

export interface BuildDeps {
  store: IndexStore;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Where the index files are served, ending in a slash (e.g. `/manifest/data/`). */
  base: string;
  /** Told when a new build becomes active, so that every part of the app moves to it. */
  announce?: (manifest: IndexManifest) => void;
  /** Files downloaded so far out of those the update needs, as it goes. */
  onProgress?: (progress: { done: number; total: number; bytes: number }) => void;
  /** Downloads at once. */
  concurrency?: number;
}

/** A downloaded file whose content isn't what its manifest says: the server has moved on to another build. */
export class IndexFileMismatch extends Error {
  constructor(readonly file: string) {
    super(`${file} on the server is from another build of the card index`);
    this.name = 'IndexFileMismatch';
  }
}

const SHA_HEADER = 'X-Manifest-Sha256';

export const manifestUrl = (base: string) => `${base}manifest.json`;
export const candidateUrl = (base: string) => `${base}manifest.json?candidate`;
export const fileUrl = (base: string, file: IndexFile) => `${base}${file.file}?v=${file.sha256.slice(0, 16)}`;

/** A manifest this version of the app can read. */
export function isUsableManifest(value: unknown): value is IndexManifest {
  const manifest = value as IndexManifest | null;
  return Boolean(manifest && manifest.schema === 1 && typeof manifest.buildDate === 'string' && manifest.games && typeof manifest.games === 'object');
}

export function sameBuild(a: IndexManifest, b: IndexManifest): boolean {
  return a.buildDate === b.buildDate;
}

/** Every file of a build, all games. */
export function buildFiles(manifest: IndexManifest): IndexFile[] {
  const files: IndexFile[] = [];
  for (const game of Object.values(manifest.games)) {
    if (!game) continue;
    files.push(game.names, ...(game.collectors ? [game.collectors] : []), ...(game.sets ? [game.sets] : []), ...(game.hashes ?? []), ...game.shards);
  }
  return files;
}

/** `pathname + search` of a URL, which is how cache keys are compared (keys come back absolute). */
function keyOf(url: string): string {
  const parsed = new URL(url, 'https://x.invalid');
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * The files a candidate needs before it can become active: everything but the
 * printings, which are fetched by card name; and, so that an update never
 * takes away what worked offline, the printings shards whose active version
 * is cached. When the shard count changes, shards can't be matched up, so all
 * of them.
 */
export function requiredFiles(active: IndexManifest | null, candidate: IndexManifest, cached: ReadonlySet<string>, base: string): IndexFile[] {
  const files: IndexFile[] = [];
  for (const [id, game] of Object.entries(candidate.games) as [GameId, IndexManifest['games'][GameId]][]) {
    if (!game) continue;
    files.push(game.names, ...(game.collectors ? [game.collectors] : []), ...(game.sets ? [game.sets] : []), ...(game.hashes ?? []));
    const before = active?.games[id];
    if (!before || before.shards.length !== game.shards.length) {
      files.push(...game.shards);
      continue;
    }
    game.shards.forEach((shard, i) => {
      if (cached.has(keyOf(fileUrl(base, before.shards[i]!)))) files.push(shard);
    });
  }
  return files;
}

/** Cached index files that no build being kept refers to. The manifests themselves are never stale. */
export function staleEntries(cachedUrls: readonly string[], keep: readonly IndexManifest[], base: string): string[] {
  const wanted = new Set(keep.flatMap((manifest) => buildFiles(manifest).map((file) => keyOf(fileUrl(base, file)))));
  return cachedUrls.filter((url) => {
    const { pathname, search } = new URL(url, 'https://x.invalid');
    if (pathname.endsWith('/manifest.json')) return false;
    return !wanted.has(`${pathname}${search}`);
  });
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Insecure origins (a phone testing a computer's dev server over the LAN) have no WebCrypto, and no Cache Storage either. */
const canVerify = () => typeof crypto !== 'undefined' && typeof crypto.subtle?.digest === 'function';

async function matches(bytes: Uint8Array, file: IndexFile): Promise<boolean> {
  return !canVerify() || (await sha256Hex(bytes)) === file.sha256;
}

function cachedResponse(bytes: Uint8Array, file: IndexFile): Response {
  const type = file.file.endsWith('.json') ? 'application/json' : 'application/octet-stream';
  return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': type, [SHA_HEADER]: file.sha256 } });
}

/**
 * A file from the cache, or null when it isn't there. One cached before
 * hashes were recorded is checked now, and dropped if it turns out to be from
 * another build.
 */
export async function readCached(store: IndexStore, base: string, file: IndexFile): Promise<Uint8Array | null> {
  const url = fileUrl(base, file);
  const hit = await store.match(url);
  if (!hit) return null;
  const bytes = new Uint8Array(await hit.arrayBuffer());
  if (hit.headers.get(SHA_HEADER) === file.sha256) return bytes;
  if (await matches(bytes, file)) {
    await store.put(url, cachedResponse(bytes, file)).catch(() => {});
    return bytes;
  }
  await store.delete(url);
  return null;
}

/** Whether a file is cached and known to match, without reading it unless it was cached before hashes were recorded. */
async function isCachedAndChecked(store: IndexStore, base: string, file: IndexFile): Promise<boolean> {
  const hit = await store.match(fileUrl(base, file));
  if (!hit) return false;
  if (hit.headers.get(SHA_HEADER) === file.sha256) return true;
  return (await readCached(store, base, file)) !== null;
}

/** Downloads a file, checks it against its manifest entry and caches it. Throws IndexFileMismatch, and caches nothing, if it doesn't match. */
export async function downloadFile(deps: Pick<BuildDeps, 'fetch' | 'base'> & { store: IndexStore | null }, file: IndexFile): Promise<Uint8Array> {
  const url = fileUrl(deps.base, file);
  const response = await deps.fetch(url);
  if (!response.ok) throw new Error(`Couldn't download ${file.file} (HTTP ${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!(await matches(bytes, file))) throw new IndexFileMismatch(file.file);
  if (deps.store) await deps.store.put(url, cachedResponse(bytes, file)).catch(() => {});
  return bytes;
}

async function readManifest(store: IndexStore, url: string): Promise<IndexManifest | null> {
  try {
    const hit = await store.match(url);
    const value: unknown = hit ? await hit.json() : null;
    return isUsableManifest(value) ? value : null;
  } catch {
    return null;
  }
}

async function writeManifest(store: IndexStore, url: string, manifest: IndexManifest): Promise<void> {
  await store.put(url, new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json' } }));
}

/** The build the app uses, or null before the first one is in. */
export function readActive(store: IndexStore, base: string): Promise<IndexManifest | null> {
  return readManifest(store, manifestUrl(base));
}

/** Makes a build active, unless one already is. For the very first build, which has nothing to replace. */
export async function installFirst(store: IndexStore, base: string, manifest: IndexManifest): Promise<IndexManifest> {
  const existing = await readActive(store, base);
  if (existing) return existing;
  await writeManifest(store, manifestUrl(base), manifest);
  return manifest;
}

export type UpdateOutcome =
  /** The server's manifest couldn't be fetched: offline, or the site is down. Nothing changed. */
  | { kind: 'offline' }
  /** The server's manifest is one this version of the app can't read. Nothing changed. */
  | { kind: 'unsupported' }
  /** There was no build yet: the server's became active straight away. */
  | { kind: 'installed'; manifest: IndexManifest }
  /** Already on the server's build. */
  | { kind: 'up-to-date'; manifest: IndexManifest }
  /** The server's build was downloaded and is now active. */
  | { kind: 'switched'; manifest: IndexManifest; downloaded: number; bytes: number }
  /** The download stopped (the connection went): the active build stays, and the next update carries on. */
  | { kind: 'incomplete'; error: unknown }
  /** The server returned a file from yet another build (a deploy in progress): try again later. */
  | { kind: 'mismatch'; file: string };

/**
 * Looks for a newer build and, if there is one, downloads what it needs and
 * switches to it. Until then, and whatever goes wrong, the active build stays
 * as it is. Old files are cleaned out first: those neither the active build
 * nor the candidate uses, so the build before the active one is kept until
 * this next update, for any part of the app still reading it.
 */
export async function updateBuild(deps: BuildDeps): Promise<UpdateOutcome> {
  const { store, base } = deps;
  let latest: unknown;
  try {
    const response = await deps.fetch(manifestUrl(base), { cache: 'no-cache' });
    if (!response.ok) return { kind: 'offline' };
    latest = await response.json();
  } catch {
    return { kind: 'offline' };
  }
  if (!isUsableManifest(latest)) return { kind: 'unsupported' };

  const active = await readActive(store, base);
  if (!active) {
    const installed = await installFirst(store, base, latest);
    if (installed === latest) deps.announce?.(latest);
    return { kind: 'installed', manifest: installed };
  }
  const cachedUrls = await store.keys();
  if (sameBuild(active, latest)) {
    await Promise.all(staleEntries(cachedUrls, [active], base).map((url) => store.delete(url)));
    await store.delete(candidateUrl(base));
    return { kind: 'up-to-date', manifest: active };
  }

  // A newer build. Any earlier candidate is replaced; the files they share stay.
  await writeManifest(store, candidateUrl(base), latest);
  const stale = staleEntries(cachedUrls, [active, latest], base);
  await Promise.all(stale.map((url) => store.delete(url)));
  const staleSet = new Set(stale);
  const cached = new Set(cachedUrls.filter((url) => !staleSet.has(url)).map(keyOf));

  const needed = requiredFiles(active, latest, cached, base);
  const missing: IndexFile[] = [];
  for (const file of needed) {
    if (!cached.has(keyOf(fileUrl(base, file))) || !(await isCachedAndChecked(store, base, file))) missing.push(file);
  }

  let done = needed.length - missing.length;
  let bytes = 0;
  deps.onProgress?.({ done, total: needed.length, bytes });
  const queue = [...missing];
  const stopped: { outcome: UpdateOutcome | null } = { outcome: null };
  const worker = async () => {
    while (queue.length > 0 && !stopped.outcome) {
      const file = queue.shift()!;
      try {
        bytes += (await downloadFile(deps, file)).byteLength;
        done += 1;
        deps.onProgress?.({ done, total: needed.length, bytes });
      } catch (error) {
        stopped.outcome ??= error instanceof IndexFileMismatch ? { kind: 'mismatch', file: error.file } : { kind: 'incomplete', error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, deps.concurrency ?? 4) }, worker));
  if (stopped.outcome) return stopped.outcome;

  // Everything is here: switch in one write.
  await writeManifest(store, manifestUrl(base), latest);
  await store.delete(candidateUrl(base));
  deps.announce?.(latest);
  return { kind: 'switched', manifest: latest, downloaded: missing.length, bytes };
}
