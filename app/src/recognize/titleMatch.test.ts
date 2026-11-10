import { describe, expect, it } from 'vitest';
import { NameIndex } from './nameSearch';
import { alignmentCost, JUNK_COST, matchTitle, shortNameCap } from './titleMatch';

const index = new NameIndex({
  names: [
    'Sol Ring',
    'Sol Ring // Sol Ring',
    'Soaring',
    'Ensoul Ring',
    'Delver of Secrets // Insectile Aberration',
    'Delver of Secrets // Delver of Secrets',
    'Keeper of Secrets',
    'Copy',
    'Fry',
    'Ow',
    'Ox',
    '_____',
    'Solitude',
    'Shock',
    'Shockwave Sentinel',
    'Hogaak, Arisen Necropolis',
    'Hidden Necropolis',
  ],
  faces: {
    'Delver of Secrets': ['Delver of Secrets // Delver of Secrets', 'Delver of Secrets // Insectile Aberration'],
    'Insectile Aberration': ['Delver of Secrets // Insectile Aberration'],
    'Sol Ring': ['Sol Ring // Sol Ring'],
  },
  aliases: { Yojimbo: ['Solitude'] },
});

describe('alignmentCost', () => {
  it('is zero for an exact reading', () => {
    expect(alignmentCost('sol ring', 'sol ring')).toBe(0);
  });

  it('charges junk around the name less than real edits', () => {
    expect(alignmentCost('sol ring', 'sol ring oo')).toBeCloseTo(2 * JUNK_COST);
    expect(alignmentCost('sol ring', 'l sol ring')).toBeCloseTo(JUNK_COST);
    expect(alignmentCost('sol ring', 'sol ringx')).toBeCloseTo(JUNK_COST);
    expect(alignmentCost('sol ring', 'sal ring')).toBe(1);
  });

  it('charges little for a lost or extra space', () => {
    expect(alignmentCost('sol ring', 'solring')).toBeLessThan(0.5);
    expect(alignmentCost('goblin', 'gob lin')).toBeLessThan(0.5);
  });
});

describe('matchTitle', () => {
  it('reads through mana-symbol junk with high confidence', () => {
    const match = matchTitle(index, 'Sol Ring ®');
    expect(match.candidates[0]?.name).toBe('Sol Ring');
    expect(match.confidence).toBeGreaterThan(0.9);
  });

  it("doesn't let a reversible printing of the same card lower the confidence", () => {
    const match = matchTitle(index, 'Sol Ring');
    expect(match.candidates.map((c) => c.name).slice(0, 2)).toEqual(['Sol Ring', 'Sol Ring // Sol Ring']);
    expect(match.confidence).toBeGreaterThan(0.9);
  });

  it('prefers the double-faced card to its reversible printing when a face matches', () => {
    expect(matchTitle(index, 'Delver of Secrets').candidates[0]?.name).toBe('Delver of Secrets // Insectile Aberration');
    expect(matchTitle(index, 'Insectile Aberration').candidates[0]?.matchedFace).toBe('Insectile Aberration');
  });

  it('finds a card by the alternate name printed on it', () => {
    expect(matchTitle(index, 'Yojimbo').candidates[0]).toMatchObject({ name: 'Solitude', matchedFace: 'Yojimbo' });
  });

  it('finds short names that share no trigrams with the reading', () => {
    expect(matchTitle(index, 'Cory').candidates[0]?.name).toBe('Copy');
  });

  it("never lets a short name or an all-punctuation name pass on junk", () => {
    const match = matchTitle(index, '5 oW');
    expect(match.candidates[0]?.name).toBe('Ow');
    expect(match.confidence).toBeLessThanOrEqual(shortNameCap('ow'));
    expect(match.candidates.map((c) => c.name)).not.toContain('_____');
  });

  it("isn't sure when two different names read about the same", () => {
    expect(matchTitle(index, 'Hogaak Arsen Necrop').confidence).toBeLessThan(0.9);
  });

  it('gives up on readings with no letters', () => {
    expect(matchTitle(index, ' . : ')).toEqual({ candidates: [], confidence: 0, reading: '' });
  });
});
