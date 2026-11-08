import { describe, expect, it } from 'vitest';
import { NameIndex, editDistance, normalizeName } from './nameSearch';

const index = new NameIndex({
  names: [
    'Delver of Secrets // Insectile Aberration',
    'Fire // Ice',
    'Fire Elemental',
    'Fireball',
    'Lightning Bolt',
    'Lightning Helix',
    "Lim-Dûl's Vault",
    'Aether Vial',
    'Plains',
    'Sol Ring',
    'Sol Talisman',
    'Solemn Simulacrum',
    'Ring of Gix',
    'Ice',
  ],
  faces: {
    Fire: ['Fire // Ice'],
    Ice: ['Fire // Ice'],
    'Insectile Aberration': ['Delver of Secrets // Insectile Aberration'],
    'Delver of Secrets': ['Delver of Secrets // Insectile Aberration'],
  },
});

const names = (query: string, limit?: number) => index.search(query, limit).map((hit) => hit.name);

describe('normalizeName', () => {
  it.each([
    ["Lim-Dûl's Vault", 'lim duls vault'],
    ['Æther Vial', 'aether vial'],
    ['Fire // Ice', 'fire ice'],
    ['  SOL   ring ', 'sol ring'],
    ['Urza’s Saga', 'urzas saga'],
    ['Séance', 'seance'],
  ])('%s becomes %s', (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });
});

describe('editDistance', () => {
  it.each([
    ['sol ring', 'sol ring', 0],
    ['sol rng', 'sol ring', 1], // Missing letter.
    ['sol rinng', 'sol ring', 1], // Extra letter.
    ['sol rinb', 'sol ring', 1], // Wrong letter.
    ['sol rnig', 'sol ring', 1], // Swapped letters count once.
  ])('%s to %s is %i', (a, b, expected) => {
    expect(editDistance(a, b, 3)).toBe(expected);
  });

  it('stops counting past the limit', () => {
    expect(editDistance('sol ring', 'plains', 2)).toBe(3);
    expect(editDistance('a', 'abcdefgh', 2)).toBe(3);
  });
});

describe('NameIndex.search', () => {
  it('finds nothing for an empty query', () => {
    expect(index.search('')).toEqual([]);
    expect(index.search(' // ')).toEqual([]);
  });

  it('ranks exact, then prefix, then word prefix', () => {
    expect(names('sol')[0]).toBe('Sol Ring');
    expect(names('ring')).toEqual(expect.arrayContaining(['Sol Ring', 'Ring of Gix']));
    expect(names('ring')[0]).toBe('Ring of Gix');
  });

  it('matches words in any order', () => {
    expect(names('bolt lightning')[0]).toBe('Lightning Bolt');
  });

  it('ignores accents and punctuation', () => {
    expect(names('lim dul')[0]).toBe("Lim-Dûl's Vault");
    expect(names('æther')[0]).toBe('Aether Vial');
  });

  it('finds multi-face cards by either face and returns the full name', () => {
    const [hit] = index.search('Insectile');
    expect(hit).toMatchObject({ name: 'Delver of Secrets // Insectile Aberration', matchedFace: 'Insectile Aberration' });
  });

  it('prefers a card with that exact name over a card with that face', () => {
    expect(names('ice')[0]).toBe('Ice');
    expect(names('ice')).toContain('Fire // Ice');
  });

  it('lists each card once, even when several faces match', () => {
    const hits = names('fire');
    expect(hits.filter((name) => name === 'Fire // Ice')).toHaveLength(1);
  });

  it('tolerates typos', () => {
    expect(names('sol rnig')[0]).toBe('Sol Ring');
    expect(names('lightnng bolt')[0]).toBe('Lightning Bolt');
    expect(names('plaisn')[0]).toBe('Plains');
  });

  it('tolerates typos in a name still being typed', () => {
    expect(names('lightnng bo')[0]).toBe('Lightning Bolt');
  });

  it('does not invent matches for nonsense', () => {
    expect(names('zzzzzzzz')).toEqual([]);
  });

  it('respects the limit', () => {
    expect(names('s', 2)).toHaveLength(2);
  });
});
