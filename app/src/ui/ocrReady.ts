/**
 * Whether the OCR engine can start offline: the files this device's
 * recognition worker loads (recognize.worker.ts picks the SIMD build when the
 * browser has wasm SIMD) must be in a cache the service worker serves from.
 *
 * The service worker caches them when they go through it, but on a first
 * visit the recognition worker starts before the service worker is in
 * control, so its requests pass it by. Asking for any that are missing from
 * the page, which is in control by then, gets them cached.
 */

declare const __OCR_DIR__: string;

/** The wasm SIMD test module recognize.worker.ts uses to choose the engine (from wasm-feature-detect). */
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

const MODEL = 'eng.traineddata.gz';

/** The OCR files this device loads. */
export function ocrFilesNeeded(simd: boolean): string[] {
  const core = simd ? 'tesseract-core-simd-lstm' : 'tesseract-core-lstm';
  return ['worker.min.js', `${core}.js`, `${core}.wasm`, MODEL];
}

function ocrUrl(file: string): string {
  return new URL(`${import.meta.env.BASE_URL}${__OCR_DIR__}/${file}`, location.href).href;
}

/** Tesseract keeps the model it loaded in IndexedDB (idb-keyval's database), keyed by the versioned folder, and reads it from there first. */
async function modelInTesseractStore(): Promise<boolean> {
  try {
    if (typeof indexedDB.databases !== 'function' || !(await indexedDB.databases()).some((db) => db.name === 'keyval-store')) return false;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('keyval-store');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      if (!db.objectStoreNames.contains('keyval')) return false;
      const key = await new Promise<IDBValidKey | undefined>((resolve, reject) => {
        const request = db.transaction('keyval').objectStore('keyval').getKey(`${__OCR_DIR__}/eng.traineddata`);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return key !== undefined;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** OCR files this device needs that it couldn't load offline. */
export async function missingOcrFiles(): Promise<string[]> {
  if (typeof caches === 'undefined') return ocrFilesNeeded(true);
  const files = ocrFilesNeeded(WebAssembly.validate(SIMD_PROBE));
  const missing: string[] = [];
  for (const file of files) {
    // Precache keys may carry a revision parameter.
    if (await caches.match(ocrUrl(file), { ignoreSearch: true })) continue;
    if (file === MODEL && (await modelInTesseractStore())) continue;
    missing.push(file);
  }
  return missing;
}

/**
 * Asks for the given OCR files through the service worker, which caches them.
 * Does nothing until a service worker is in control. Resolves with whether
 * they're all cached now.
 */
export async function cacheOcrFiles(files: readonly string[]): Promise<boolean> {
  if (files.length === 0) return true;
  if (!navigator.serviceWorker?.controller) return false;
  await Promise.all(files.map((file) => fetch(ocrUrl(file), { priority: 'low' } as RequestInit).then((response) => response.arrayBuffer(), () => null)));
  return (await missingOcrFiles()).length === 0;
}
