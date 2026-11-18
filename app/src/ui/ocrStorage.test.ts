import { describe, expect, it } from 'vitest';
import { ocrPath, staleModelKeys, staleOcrCacheEntries } from './ocrStorage';

const CURRENT = 'ocr/7.0.0-7.0.0-eng-fast-923915d';
const OLD = 'ocr/6.0.1-6.0.0-eng-best-1a2b3c4';
const site = 'https://kostmw.github.io/manifest';

describe('ocrPath', () => {
  it('finds the versioned folder wherever the site is served from', () => {
    expect(ocrPath(`${site}/${CURRENT}/eng.traineddata.gz`)).toEqual({ folder: CURRENT, file: 'eng.traineddata.gz' });
    expect(ocrPath(`http://localhost:4173/${CURRENT}/worker.min.js`)).toEqual({ folder: CURRENT, file: 'worker.min.js' });
    expect(ocrPath(`${site}/data/names.mtg.json?v=1`)).toBeNull();
  });
});

describe('staleOcrCacheEntries', () => {
  const urls = [
    `${site}/${OLD}/eng.traineddata.gz`,
    `${site}/${OLD}/tesseract-core-simd-lstm.wasm`,
    `${site}/${CURRENT}/tesseract-core-simd-lstm.wasm`,
    `${site}/${CURRENT}/tesseract-core-lstm.wasm`,
  ];

  it("removes other versions' files, and this version's once the precache has them", () => {
    const precached = new Set([`${site}/${CURRENT}/tesseract-core-simd-lstm.wasm`]);
    expect(staleOcrCacheEntries(urls, CURRENT, (url) => precached.has(url))).toEqual([urls[0], urls[1], urls[2]]);
  });

  it("keeps this version's files the precache doesn't have yet, and the ones it never holds", () => {
    expect(staleOcrCacheEntries(urls, CURRENT, () => false)).toEqual([urls[0], urls[1]]);
  });

  it('ignores anything that is not an OCR file', () => {
    expect(staleOcrCacheEntries([`${site}/index.html`], CURRENT, () => true)).toEqual([]);
  });
});

describe('staleModelKeys', () => {
  it("removes other versions' models and keeps this version's", () => {
    const keys = [`${CURRENT}/eng.traineddata`, `${OLD}/eng.traineddata`, './eng.traineddata'];
    expect(staleModelKeys(keys, CURRENT)).toEqual([`${OLD}/eng.traineddata`, './eng.traineddata']);
  });

  it("leaves keys that aren't Tesseract models alone", () => {
    expect(staleModelKeys(['settings', 42, `${OLD}/notes`], CURRENT)).toEqual([]);
  });
});
