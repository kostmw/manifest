/**
 * Old copies of the OCR files, removed once the service worker is running.
 * Each app version keeps Tesseract's files under a versioned folder
 * (`ocr/<versions>-<model>/`). Before they were precached, they were cached on
 * first use in `manifest-ocr`, and Tesseract keeps its own copy of the model
 * in IndexedDB, keyed by that folder. Nothing removed the copies a newer
 * version replaced: up to 20 files (about 15 MB) in the cache, plus a model of
 * a few MB in IndexedDB for every version ever used.
 */

/** The runtime cache for OCR files (vite.config.ts). */
export const OCR_RUNTIME_CACHE = 'manifest-ocr';
/** idb-keyval's defaults, which Tesseract.js uses for its model cache. */
const TESSERACT_DB = 'keyval-store';
const TESSERACT_STORE = 'keyval';

/** The `ocr/<folder>` and file name of an OCR file's URL, wherever the site is served from. */
export function ocrPath(url: string): { folder: string; file: string } | null {
  const match = /\/(ocr\/[^/]+)\/([^/]+)$/.exec(new URL(url, 'https://x.invalid').pathname);
  return match ? { folder: match[1]!, file: match[2]! } : null;
}

/**
 * Runtime-cache entries to delete: those from another version's folder, and
 * those of this version that the precache now holds. `inPrecache` says which
 * the precache really has, so nothing goes before its replacement is in.
 */
export function staleOcrCacheEntries(urls: readonly string[], currentFolder: string, inPrecache: (url: string) => boolean): string[] {
  return urls.filter((url) => {
    const path = ocrPath(url);
    return path !== null && (path.folder !== currentFolder || inPrecache(url));
  });
}

/** Tesseract's cached models from other versions. Its keys are `<cachePath>/<lang>.traineddata`. */
export function staleModelKeys(keys: readonly IDBValidKey[], currentFolder: string): string[] {
  return keys.filter((key): key is string => typeof key === 'string' && key.endsWith('.traineddata') && !key.startsWith(`${currentFolder}/`));
}

async function removeOldCacheEntries(currentFolder: string, precachedFiles: ReadonlySet<string>): Promise<number> {
  if (!(await caches.has(OCR_RUNTIME_CACHE))) return 0;
  const cache = await caches.open(OCR_RUNTIME_CACHE);
  const urls = (await cache.keys()).map((entry) => entry.url);
  const precaches = await Promise.all(
    (await caches.keys()).filter((name) => name.startsWith('workbox-precache')).map((name) => caches.open(name)),
  );
  const replaced = new Set<string>();
  for (const url of urls) {
    const path = ocrPath(url);
    if (path?.folder !== currentFolder || !precachedFiles.has(path.file)) continue;
    // Precache keys may carry a revision parameter.
    for (const precache of precaches) {
      if (await precache.match(url, { ignoreSearch: true })) {
        replaced.add(url);
        break;
      }
    }
  }
  const stale = staleOcrCacheEntries(urls, currentFolder, (url) => replaced.has(url));
  await Promise.all(stale.map((url) => cache.delete(url)));
  return stale.length;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function removeOldModels(currentFolder: string): Promise<number> {
  // Opening a database that doesn't exist would create it, so look first.
  if (typeof indexedDB.databases !== 'function') return 0;
  if (!(await indexedDB.databases()).some((db) => db.name === TESSERACT_DB)) return 0;
  const db = await request(indexedDB.open(TESSERACT_DB));
  try {
    if (!db.objectStoreNames.contains(TESSERACT_STORE)) return 0;
    const keys = await request(db.transaction(TESSERACT_STORE).objectStore(TESSERACT_STORE).getAllKeys());
    const stale = staleModelKeys(keys, currentFolder);
    if (stale.length === 0) return 0;
    const tx = db.transaction(TESSERACT_STORE, 'readwrite');
    for (const key of stale) tx.objectStore(TESSERACT_STORE).delete(key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return stale.length;
  } finally {
    db.close();
  }
}

/**
 * Removes other versions' OCR files, and this version's runtime copies that
 * the precache replaces. Never throws: whatever fails is tried next launch.
 */
export async function removeOldOcrCopies(currentFolder: string, precachedFiles: readonly string[]): Promise<{ cache: number; models: number }> {
  const result = { cache: 0, models: 0 };
  if (typeof caches !== 'undefined') {
    result.cache = await removeOldCacheEntries(currentFolder, new Set(precachedFiles)).catch(() => 0);
  }
  if (typeof indexedDB !== 'undefined') {
    result.models = await removeOldModels(currentFolder).catch(() => 0);
  }
  return result;
}
