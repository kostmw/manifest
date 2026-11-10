import { describe, expect, it } from 'vitest';
import { buildCollectorIndex, CollectorIndex, collectorNumberCore } from './collectorIndex';
import type { Printing } from './types';

const printing = (name: string, set: string, number: string, released = '2023-06-23'): Printing => ({
  id: `${set}-${number}`,
  name,
  set,
  setName: set,
  number,
  finishes: ['nonfoil'],
  lang: 'en',
  released,
});

describe('collectorNumberCore', () => {
  it.each([
    ['0166', '166'],
    ['166s', '166'],
    ['166', '166'],
    ['DOM-70', '70'],
    ['0', '0'],
    ['★', null],
  ])('%s → %s', (number, core) => {
    expect(collectorNumberCore(number)).toBe(core);
  });
});

describe('collector index', () => {
  const names = ['Fangorn, Tree Shepherd', 'Old Card', 'Plains', 'Sol Ring'];
  const file = buildCollectorIndex(
    [
      printing('Fangorn, Tree Shepherd', 'ltr', '166'),
      printing('Fangorn, Tree Shepherd', 'pltr', '166s'),
      printing('Sol Ring', 'cmm', '410'),
      printing('Plains', 'cmm', '410a'),
      printing('Old Card', 'lea', '12', '1993-08-05'),
    ],
    names,
    '2014-07-01',
  );

  it('keys numbers as printed, leaving out cards too old to show a set code', () => {
    expect(file).toEqual({ cmm: { '410': [2, 3] }, ltr: { '166': 0 }, pltr: { '166': 0 } });
  });

  it('looks names up by set and number, whatever the case and zero padding', () => {
    const index = new CollectorIndex(file, names);
    expect(index.lookup('LTR', '0166')).toEqual(['Fangorn, Tree Shepherd']);
    expect(index.lookup('cmm', '410')).toEqual(['Plains', 'Sol Ring']);
    expect(index.lookup('cmm', '999')).toEqual([]);
    expect(index.lookup('lea', '12')).toEqual([]);
    expect(index.sets()).toEqual(['cmm', 'ltr', 'pltr']);
  });
});
