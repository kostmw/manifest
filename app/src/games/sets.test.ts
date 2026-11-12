import { describe, expect, it } from 'vitest';
import { buildSetList, searchSets } from './sets';
import type { Printing } from './types';

const printing = (set: string, setName: string, released: string): Printing => ({
  id: `${set}-${released}`,
  name: 'X',
  set,
  setName,
  number: '1',
  finishes: ['nonfoil'],
  lang: 'en',
  released,
});

describe('sets', () => {
  const sets = buildSetList([
    printing('ltr', 'The Lord of the Rings: Tales of Middle-earth', '2023-06-23'),
    printing('ltr', 'The Lord of the Rings: Tales of Middle-earth', '2023-06-20'),
    printing('pltr', 'Tales of Middle-earth Promos', '2023-06-23'),
    printing('lea', 'Limited Edition Alpha', '1993-08-05'),
  ]);

  it('lists each set once, newest first, with its earliest date and printing count', () => {
    expect(sets).toEqual([
      { code: 'pltr', name: 'Tales of Middle-earth Promos', released: '2023-06-23', printings: 1 },
      { code: 'ltr', name: 'The Lord of the Rings: Tales of Middle-earth', released: '2023-06-20', printings: 2 },
      { code: 'lea', name: 'Limited Edition Alpha', released: '1993-08-05', printings: 1 },
    ]);
  });

  it('finds sets by code or by any word of the name, exact codes first', () => {
    expect(searchSets(sets, 'LTR').map((set) => set.code)).toEqual(['ltr']);
    expect(searchSets(sets, 'tales').map((set) => set.code)).toEqual(['pltr', 'ltr']);
    expect(searchSets(sets, 'alpha').map((set) => set.code)).toEqual(['lea']);
    expect(searchSets(sets, '')).toEqual([]);
  });
});
