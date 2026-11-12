import { describe, expect, it } from 'vitest';
import { cameraResolution, debugEnabled, formatTimings, setCameraResolution, setDebugEnabled } from './debug';

function memoryStore() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe('debug readout', () => {
  it('turns on with ?debug=1 and stays on until ?debug=0', () => {
    const store = memoryStore();
    expect(debugEnabled('', store)).toBe(false);
    expect(debugEnabled('?debug=1', store)).toBe(true);
    expect(debugEnabled('', store)).toBe(true);
    expect(debugEnabled('?scan=1&debug=0', store)).toBe(false);
    expect(debugEnabled('', store)).toBe(false);
  });

  it('still works for the page when storage is blocked', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => {} };
    expect(debugEnabled('?debug=1', blocked)).toBe(true);
    expect(debugEnabled('', blocked)).toBe(false);
  });

  it('uses a 720p camera unless ?camera=1080 asks for more, and remembers it', () => {
    const store = memoryStore();
    expect(cameraResolution('', store)).toBe(720);
    expect(cameraResolution('?camera=1080', store)).toBe(1080);
    expect(cameraResolution('', store)).toBe(1080);
    expect(cameraResolution('?camera=4k', store)).toBe(1080);
    expect(cameraResolution('?camera=0', store)).toBe(720);
  });

  it('can be switched from inside the app, and the query string still works after', () => {
    const store = memoryStore();
    expect(setDebugEnabled(true, store)).toBe(true);
    expect(debugEnabled('', store)).toBe(true);
    setDebugEnabled(false, store);
    expect(debugEnabled('', store)).toBe(false);
    expect(debugEnabled('?debug=1', store)).toBe(true);
    setCameraResolution(1080, store);
    expect(cameraResolution('', store)).toBe(1080);
    setCameraResolution(720, store);
    expect(cameraResolution('', store)).toBe(720);
  });

  it('formats timings in milliseconds, in order', () => {
    expect(formatTimings({ detect: 41.4, ocr: 180.6, total: 412 })).toBe('detect 41 · ocr 181 · total 412');
    expect(formatTimings({ detect: Number.NaN, total: 3 })).toBe('total 3');
  });
});
