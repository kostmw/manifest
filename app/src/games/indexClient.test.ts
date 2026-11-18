import { describe, expect, it } from 'vitest';
import { sortPrintings, thumbnailUrl } from './indexClient';
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
