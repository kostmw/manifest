import { describe, expect, it } from 'vitest';
import { sortPrintings, staleCacheEntries, thumbnailUrl } from './indexClient';
import type { Printing } from './types';

const p = (id: string, released: string | undefined, set: string, number: string): Printing => ({
  id,
  name: 'Plains',
  set,
  setName: set,
  number,
  finishes: ['nonfoil'],
  lang: 'en',
  ...(released ? { released } : {}),
});

describe('staleCacheEntries', () => {
  const origin = 'https://kostmw.github.io';
  const current = new Set(['/manifest/data/printings.mtg.00.json?v=new', '/manifest/data/names.mtg.json?v=same']);

  it('finds old versions of files, and keeps current ones', () => {
    expect(
      staleCacheEntries(
        [
          `${origin}/manifest/data/printings.mtg.00.json?v=old`,
          `${origin}/manifest/data/printings.mtg.00.json?v=new`,
          `${origin}/manifest/data/names.mtg.json?v=same`,
        ],
        current,
      ),
    ).toEqual([`${origin}/manifest/data/printings.mtg.00.json?v=old`]);
  });

  it('never removes the cached manifest, which offline use depends on', () => {
    expect(staleCacheEntries([`${origin}/manifest/data/manifest.json`], current)).toEqual([]);
  });
});

describe('sortPrintings', () => {
  it('puts the newest first, then orders by set and number', () => {
    const sorted = sortPrintings([
      p('old', '1993-08-05', 'lea', '286'),
      p('new-20', '2020-07-03', 'm21', '20'),
      p('new-3', '2020-07-03', 'm21', '3'),
      p('undated', undefined, 'zzz', '1'),
    ]);
    expect(sorted.map((printing) => printing.id)).toEqual(['new-3', 'new-20', 'old', 'undated']);
  });
});

describe('thumbnailUrl', () => {
  it('points at the small image', () => {
    expect(thumbnailUrl('https://cards.scryfall.io/normal/front/a/b/ab.jpg?1')).toBe(
      'https://cards.scryfall.io/small/front/a/b/ab.jpg?1',
    );
  });
});
