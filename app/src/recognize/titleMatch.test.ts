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
    expect(alignmentCost('sol ring', 'sol ring oo')).toBeCloseTo(2 * 0.15);
    expect(alignmentCost('sol ring', 'l sol ring')).toBeCloseTo(JUNK_COST);
    expect(alignmentCost('sol ring', 'sol ringx')).toBeCloseTo(JUNK_COST);
    expect(alignmentCost('sol ring', 'sal ring')).toBe(1);
  });

  it('charges half for junk after a name read exactly, as whole words, then a space (round 10: mana symbols)', () => {
    expect(alignmentCost('constable odo', 'constable odo btots')).toBeCloseTo(5 * 0.15);
    // Not after a name with an edit in it, nor junk glued to the name.
    expect(alignmentCost('minion', 'minio oa')).toBeCloseTo(1 + 2 * JUNK_COST);
    expect(alignmentCost('sol ring', 'sol ringoo')).toBeCloseTo(2 * JUNK_COST);
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

describe('matchTitle when a short name hides inside a word of a longer one (round 8)', () => {
  const names = new NameIndex({ names: ['Minion', 'Minions', 'Dominion Saboteur', 'Dominion Supervisor', 'Forest', 'Foresee'], faces: {} });

  it('doesn’t take "Dominion …" for Minion: the word belongs to Dominion Saboteur', () => {
    for (const reading of ['Dominion ee 40:', 'Dominion ae ao:']) {
      const match = matchTitle(names, reading);
      expect(match.candidates[0]?.name).not.toBe('Minion');
      expect(match.candidates.findIndex((c) => c.name === 'Dominion Saboteur')).toBeLessThanOrEqual(1);
    }
  });

  it('still reads a name with junk glued to its front that makes no word ("Riforest")', () => {
    const match = matchTitle(names, 'Riforest');
    expect(match.candidates[0]?.name).toBe('Forest');
    expect(match.candidates[0]?.similarity).toBeCloseTo(0.9, 2);
  });
});

describe('matchTitle when only the first words of a long name were read (round 9)', () => {
  const names = new NameIndex({
    names: ['Dominion Saboteur', 'Dominion Supervisor', 'Dominion Infiltration', 'Glaze Fiend', 'Minion', 'Shock', 'Shock Troops', 'Forest', 'Forest Bear'],
    faces: {},
  });

  it('puts the long name first when its first word is read, garbled, and the rest is junk', () => {
    // Under the flashlight, a foil Dominion Saboteur: "Doninio ir Q O:,". Glaze Fiend came first before.
    const garbled = matchTitle(names, 'Doninio ir Q O:,');
    expect(garbled.candidates[0]?.name).toBe('Dominion Saboteur');
    // Of the names that start alike, the one with the least left unread first, and two at most.
    expect(garbled.candidates[1]?.name).toBe('Dominion Supervisor');
    expect(garbled.candidates.map((c) => c.name)).not.toContain('Dominion Infiltration');
    expect(matchTitle(names, 'Dominio oa').candidates[0]?.name).toBe('Dominion Saboteur');
  });

  it('puts a long name among the candidates when only its last words were read (round 10)', () => {
    const names = new NameIndex({ names: ['Grim Physician', 'Photosynthetic Physician', 'Terraformer', 'Astute Terraformer', 'Musician'], faces: {} });
    const physician = matchTitle(names, 'ie Physician 44');
    expect(physician.candidates.map((c) => c.name)).toContain('Photosynthetic Physician');
    const photosynthetic = physician.candidates.find((c) => c.name === 'Photosynthetic Physician')!.similarity;
    expect(photosynthetic).toBeGreaterThan(0.55);
    expect(photosynthetic).toBeLessThanOrEqual(0.75);
    // A misread last word, its first word missing: still a candidate, behind the name read whole.
    const terraformer = matchTitle(names, 'getaformer');
    expect(terraformer.candidates.slice(0, 2).map((c) => c.name)).toEqual(['Terraformer', 'Astute Terraformer']);
    expect(terraformer.candidates[1]!.similarity).toBeGreaterThan(0.55);
  });

  it('adds names read only in part without pushing out names read whole', () => {
    const many = new NameIndex({ names: ['Island', 'Stab', 'Stun', 'Stand // Deliver', 'Stand Firm', 'Standstill', 'Stand Together', 'Standard Bearer'], faces: { Stand: ['Stand // Deliver'] } });
    // An Island misread as "stand": Island stays among the candidates, for its artwork to settle it.
    const match = matchTitle(many, 'stand');
    expect(match.candidates.map((c) => c.name)).toContain('Island');
    expect(match.candidates.length).toBeLessThanOrEqual(7);
  });

  it("is never sure of a name read only in part, so such a card waits for review", () => {
    for (const reading of ['Doninio ir Q O:,', 'Dominion', 'Dominion ee 40:']) {
      const match = matchTitle(names, reading);
      expect(match.candidates[0]?.similarity).toBeLessThanOrEqual(0.75);
      expect(match.confidence).toBeLessThan(0.5);
    }
  });

  it('keeps a short name read whole sure, though longer names start with it', () => {
    // (Five letters: capped at 0.95, as before.)
    const shock = matchTitle(names, 'Shock');
    expect(shock.confidence).toBe(0.95);
    expect(shock.candidates.slice(0, 2).map((c) => c.name)).toEqual(['Shock', 'Shock Troops']);
    expect(matchTitle(names, 'Forest').confidence).toBe(1);
    expect(matchTitle(names, 'Riforest').confidence).toBeCloseTo(0.9, 2);
  });
});
