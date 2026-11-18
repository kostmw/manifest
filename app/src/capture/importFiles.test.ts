import { describe, expect, it } from 'vitest';
import { fileKey, importable, isClutter, isImageFile } from './importFiles';

describe('fileKey', () => {
  it('gives the same photo the same key, whatever it is called', async () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 251);
    expect(await fileKey(new File([bytes], 'IMG_0001.JPG'))).toBe(await fileKey(new File([bytes], 'image.jpg')));
  });

  it('tells photos apart by their size and their first 64 KB', async () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 251);
    const key = await fileKey(new File([bytes], 'a.jpg'));
    const changedStart = bytes.slice();
    changedStart[10] = 7;
    expect(await fileKey(new File([changedStart], 'a.jpg'))).not.toBe(key);
    expect(await fileKey(new File([bytes.slice(0, 99_999)], 'a.jpg'))).not.toBe(key);
    expect(key).toMatch(/^100000:[0-9a-f]{32}$/);
  });
});

describe('isImageFile', () => {
  it('goes by the type, or by the name when there is no type', () => {
    expect(isImageFile({ name: 'a.jpg', type: 'image/jpeg' })).toBe(true);
    expect(isImageFile({ name: 'scan.pdf', type: 'application/pdf' })).toBe(false);
    expect(isImageFile({ name: 'IMG_1.HEIC', type: '' })).toBe(true);
    expect(isImageFile({ name: 'notes', type: '' })).toBe(false);
  });
});

describe('importable', () => {
  it('leaves out hidden files and sorts by folder and name, numbers by value', () => {
    const file = (name: string, path = '') => Object.assign(new File(['x'], name), path ? { webkitRelativePath: path } : {});
    const files = [file('scan10.jpg'), file('.DS_Store'), file('scan2.jpg'), file('Thumbs.db'), file('scan1.jpg')];
    expect(importable(files).map((f) => f.name)).toEqual(['scan1.jpg', 'scan2.jpg', 'scan10.jpg']);
    expect(isClutter({ name: 'desktop.ini' })).toBe(true);
    const nested = [file('b.jpg', 'box/2/b.jpg'), file('a.jpg', 'box/10/a.jpg'), file('c.jpg', 'box/1/c.jpg')];
    expect(importable(nested).map((f) => f.name)).toEqual(['c.jpg', 'b.jpg', 'a.jpg']);
  });
});
