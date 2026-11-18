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
import type { IndexFile, IndexManifest } from './types';

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
  /** How the download is going, after each file. */
  onProgress?: (progress: UpdateProgress) => void;
  /** Downloads at once (default 6). */
  concurrency?: number;
  /** Storage used and available, to check there is room before downloading (navigator.storage.estimate). */
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
  /** Awaited between files, so that a background download can make way for the app. */
  pause?: () => Promise<void>;
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

/** Thrown when the device has no room left to cache the index. */
export function isQuotaError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED');
}

/**
 * Downloads a file, checks it against its manifest entry and caches it.
 * Throws IndexFileMismatch, and caches nothing, if it doesn't match. A
 * background download (the offline copy) asks for low network priority, and
 * fails if the file can't be cached; a file the app needs now is returned
 * even then.
 */
export async function downloadFile(
  deps: Pick<BuildDeps, 'fetch' | 'base'> & { store: IndexStore | null },
  file: IndexFile,
  options: { background?: boolean } = {},
): Promise<Uint8Array> {
  const url = fileUrl(deps.base, file);
  const response = await deps.fetch(url, options.background ? ({ priority: 'low' } as RequestInit) : undefined);
  if (!response.ok) throw new Error(`Couldn't download ${file.file} (HTTP ${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!(await matches(bytes, file))) throw new IndexFileMismatch(file.file);
  if (deps.store) {
    const stored = deps.store.put(url, cachedResponse(bytes, file));
    await (options.background ? stored : stored.catch(() => {}));
  }
  return bytes;
}

/** A build's files that aren't cached yet (or were cached unchecked and turn out to be from another build). */
export async function missingFiles(store: IndexStore, base: string, manifest: IndexManifest, cachedUrls?: readonly string[]): Promise<IndexFile[]> {
  const cached = new Set((cachedUrls ?? (await store.keys())).map(keyOf));
  const missing: IndexFile[] = [];
  for (const file of buildFiles(manifest)) {
    if (!cached.has(keyOf(fileUrl(base, file))) || !(await isCachedAndChecked(store, base, file))) missing.push(file);
  }
  return missing;
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
  /** There was no build yet: the server's became active straight away, and is now all downloaded. */
  | { kind: 'installed'; manifest: IndexManifest; downloaded: number }
  /** Already on the server's build, which is all downloaded (`downloaded` files were missing). */
  | { kind: 'up-to-date'; manifest: IndexManifest; downloaded: number }
  /** The server's build was downloaded and is now active. */
  | { kind: 'switched'; manifest: IndexManifest; downloaded: number }
  /** The download stopped (the connection went): the active build stays, and the next update carries on. */
  | { kind: 'incomplete'; error: unknown }
  /** The server returned a file from yet another build (a deploy in progress): try again later. */
  | { kind: 'mismatch'; file: string }
  /** The device has no room for the files: nothing more is downloaded. */
  | { kind: 'storage' };

export interface UpdateProgress {
  /** The build being downloaded. */
  buildDate: string;
  /** A newer build than the active one (the active one stays in use meanwhile), rather than the active one filled in. */
  updating: boolean;
  done: number;
  total: number;
  /** Bytes as cached (the manifest's sizes; the download itself is compressed). */
  bytes: number;
  totalBytes: number;
}

/** Attempts per file before the download counts as stopped: a dropped request on a phone is common. */
const ATTEMPTS = 3;

/**
 * Downloads a build's missing files, the scanner's first (names, collectors,
 * sets, fingerprints), then the printings. Stops at the first file that can't
 * be had.
 */
async function downloadAll(deps: BuildDeps, manifest: IndexManifest, cachedUrls: readonly string[], updating: boolean): Promise<UpdateOutcome | { kind: 'done'; downloaded: number }> {
  const all = buildFiles(manifest);
  const missing = await missingFiles(deps.store, deps.base, manifest, cachedUrls);
  const totalBytes = all.reduce((sum, file) => sum + file.bytes, 0);
  let bytes = totalBytes - missing.reduce((sum, file) => sum + file.bytes, 0);
  let done = all.length - missing.length;
  const progress = () => deps.onProgress?.({ buildDate: manifest.buildDate, updating, done, total: all.length, bytes, totalBytes });
  if (missing.length === 0) return { kind: 'done', downloaded: 0 };

  // Room for what is left, as cached. Browsers keep Cache Storage decompressed.
  const estimate = await deps.estimate?.().catch(() => null);
  if (estimate?.quota !== undefined && estimate.usage !== undefined && estimate.quota - estimate.usage < (totalBytes - bytes) * 1.1) {
    return { kind: 'storage' };
  }

  progress();
  const queue = [...missing];
  const stopped: { outcome: UpdateOutcome | null } = { outcome: null };
  const worker = async () => {
    while (queue.length > 0 && !stopped.outcome) {
      const file = queue.shift()!;
      for (let attempt = 1; ; attempt++) {
        try {
          await downloadFile(deps, file, { background: true });
          done += 1;
          bytes += file.bytes;
          progress();
          break;
        } catch (error) {
          if (error instanceof IndexFileMismatch) stopped.outcome ??= { kind: 'mismatch', file: error.file };
          else if (isQuotaError(error)) stopped.outcome ??= { kind: 'storage' };
          else if (attempt < ATTEMPTS && !stopped.outcome) continue;
          else stopped.outcome ??= { kind: 'incomplete', error };
          break;
        }
      }
      await deps.pause?.();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, deps.concurrency ?? 6) }, worker));
  return stopped.outcome ?? { kind: 'done', downloaded: missing.length };
}

/**
 * Looks for a newer build and makes sure the build in use is all on the
 * device. A newer build is downloaded in full and only then switched to;
 * until then, and whatever goes wrong, the active build stays as it is. Old
 * files are cleaned out first: those neither the active build nor the
 * candidate uses, so the build before the active one is kept until this next
 * update, for any part of the app still reading it.
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

  let active = await readActive(store, base);
  let installed = false;
  if (!active) {
    // The very first build has nothing to replace: it is used straight away, its files fetched as needed and below.
    active = await installFirst(store, base, latest);
    installed = active === latest;
    if (installed) deps.announce?.(latest);
  }
  const cachedUrls = await store.keys();
  if (sameBuild(active, latest)) {
    await Promise.all(staleEntries(cachedUrls, [active], base).map((url) => store.delete(url)));
    await store.delete(candidateUrl(base));
    const filled = await downloadAll(deps, active, cachedUrls, false);
    if (filled.kind !== 'done') return filled;
    return { kind: installed ? 'installed' : 'up-to-date', manifest: active, downloaded: filled.downloaded };
  }

  // A newer build. Any earlier candidate is replaced; the files they share stay.
  await writeManifest(store, candidateUrl(base), latest);
  const stale = staleEntries(cachedUrls, [active, latest], base);
  await Promise.all(stale.map((url) => store.delete(url)));
  const staleSet = new Set(stale);
  const downloaded = await downloadAll(deps, latest, cachedUrls.filter((url) => !staleSet.has(url)), true);
  if (downloaded.kind !== 'done') return downloaded;

  // Everything is here: switch in one write.
  await writeManifest(store, manifestUrl(base), latest);
  await store.delete(candidateUrl(base));
  deps.announce?.(latest);
  return { kind: 'switched', manifest: latest, downloaded: downloaded.downloaded };
}
