import { describe, expect, it } from 'vitest';
import type { Printing } from '../games/types';
import type { PrintingCandidate } from '../recognize/identify';
import type { ReviewItem } from '../session/types';
import { bannerTargets, groupReviews, placeReview } from './quickConfirm';

const printing = (name: string, set: string, number: string): Printing => ({ id: `${set}-${number}`, name, set, setName: set.toUpperCase(), number, finishes: ['nonfoil', 'foil'], lang: 'en' });
const candidate = (p: Printing, over: Partial<PrintingCandidate> = {}): PrintingCandidate => ({ printing: p, score: 1, title: 1, hashDistance: 30, collector: null, sources: ['title'], ...over });
let made = 0;
const review = (over: Partial<ReviewItem>): ReviewItem => ({
  id: `r${(made += 1)}`,
  batchId: 'b',
  createdAt: `2026-11-15T22:00:${String(made).padStart(2, '0')}Z`,
  source: 'live',
  names: [],
  candidates: [],
  nameConfidence: 0,
  confidence: 0,
  titleText: '',
  collectorText: '',
  advice: [],
  reason: 'unsure-name',
  foil: false,
  lang: 'en',
  condition: 'NM',
  qty: 1,
  ...over,
});
const NONE = new Set<string>();
const TRK = new Set(['trk', 'ttrk']);

const PLAINS_TRK = printing('Plains', 'trk', '307');
const PLAINS_SLD = printing('Plains', 'sld', '359');
/** Rounds 7 and 8: a foil full-art Plains TRK 307 guessed as Plains SLD 359, sure of the name, not of the printing. */
const plainsGuessedSld = (over: Partial<ReviewItem> = {}) =>
  review({ names: ['Plains'], candidates: [candidate(PLAINS_SLD, { hashDistance: 34 }), candidate(PLAINS_TRK, { hashDistance: 36 })], nameConfidence: 0.95, confidence: 0.52, reason: 'unsure-printing', ...over });

describe('placeReview', () => {
  it('keeps a sure name with a doubtful printing for a look, unless something settles the printing (the Plains SLD 359 case)', () => {
    expect(placeReview(plainsGuessedSld(), NONE)).toMatchObject({ group: 'needs-look', printingInDoubt: true, settledBy: null });
    // The collector line read set and number cleanly.
    const collector = plainsGuessedSld({ candidates: [candidate(PLAINS_TRK, { collector: { number: 'exact', set: 'exact', score: 1.6 } }), candidate(PLAINS_SLD)] });
    expect(placeReview(collector, NONE)).toMatchObject({ group: 'looks-right', settledBy: 'collector', printing: PLAINS_TRK });
    // Locked to TRK, the collector number alone looked it up in the locked set.
    const numberRead = { number: 'exact' as const, set: 'unread' as const, score: 1 };
    const lookup = plainsGuessedSld({ candidates: [candidate(PLAINS_TRK, { collector: numberRead }), candidate(PLAINS_SLD)], trace: ['title:rendering-1', 'lock:number-lookup'] });
    expect(placeReview(lookup, TRK)).toMatchObject({ group: 'looks-right', settledBy: 'lock-number' });
    // A lookup that named another card (309, Swamp) settles nothing: two TRK Plains, neither with that number (QA M1).
    const PLAINS_312 = printing('Plains', 'trk', '312');
    const conflict = { number: 'conflict' as const, set: 'unread' as const, score: -0.6 };
    const otherCard = plainsGuessedSld({ candidates: [candidate(PLAINS_TRK, { collector: conflict }), candidate(PLAINS_312, { collector: conflict })], trace: ['lock:number-lookup'] });
    expect(placeReview(otherCard, TRK)).toMatchObject({ group: 'needs-look', settledBy: null });
    // A loose digit guess (1.1 with the set), or a match zeroed for contradicting the art, isn't a clean collector line (QA M2).
    for (const collector of [{ number: 'exact' as const, set: 'exact' as const, score: 1.1 }, { number: 'exact' as const, set: 'exact' as const, score: 0 }]) {
      const weak = plainsGuessedSld({ candidates: [candidate(PLAINS_TRK, { collector }), candidate(PLAINS_SLD)] });
      expect(placeReview(weak, NONE)).toMatchObject({ group: 'needs-look', settledBy: null });
    }
    // Only one of the name's printings is in the locked set.
    expect(placeReview(plainsGuessedSld({ candidates: [candidate(PLAINS_TRK), candidate(PLAINS_SLD)] }), TRK)).toMatchObject({ group: 'looks-right', settledBy: 'only-in-lock' });
    // Two in the locked set: not settled.
    const twoTrk = plainsGuessedSld({ candidates: [candidate(PLAINS_TRK), candidate(printing('Plains', 'trk', '312'))] });
    expect(placeReview(twoTrk, TRK).group).toBe('needs-look');
  });

  it('takes a name read at 0.8 or more whose printing is clear as looking right (round 10: Constable Odo at 0.88)', () => {
    const odo = review({ names: ['Constable Odo'], candidates: [candidate(printing('Constable Odo', 'trk', '230'))], nameConfidence: 0.88, confidence: 0.86 });
    expect(placeReview(odo, TRK)).toMatchObject({ group: 'looks-right', printingInDoubt: false, outsideLock: false });
    // A printing twin at a high name confidence (round 10's sweep: FDN 116 against 477) is a doubtful printing.
    const twin = review({ names: ['Anthem of Champions'], candidates: [candidate(printing('Anthem of Champions', 'fdn', '116')), candidate(printing('Anthem of Champions', 'fdn', '477'))], nameConfidence: 0.99, confidence: 0.81, reason: 'unsure-printing' });
    expect(placeReview(twin, NONE).group).toBe('needs-look');
  });

  it('lets a clearly read card from outside the lock look right, flagged (Bristly Bill SDS 15 under a TRK lock)', () => {
    const bill = review({ names: ['Bristly Bill, Spine Sower'], candidates: [candidate(printing('Bristly Bill, Spine Sower', 'sds', '15'))], nameConfidence: 0.99, confidence: 0.99, reason: 'outside-lock' });
    expect(placeReview(bill, TRK)).toMatchObject({ group: 'looks-right', outsideLock: true });
    // Read poorly, it needs a look (every wrong outside-lock review was at 0.53 or less).
    expect(placeReview({ ...bill, nameConfidence: 0.53, confidence: 0.5 }, TRK)).toMatchObject({ group: 'needs-look', outsideLock: true });
  });

  it('keeps low name confidence for a look, marking the ones with a clean collector line or close artwork to check first', () => {
    const art = review({ names: ['Unexplored Territory'], candidates: [candidate(printing('Unexplored Territory', 'trk', '303'), { hashDistance: 20 })], nameConfidence: 0.4, confidence: 0.4 });
    expect(placeReview(art, TRK)).toMatchObject({ group: 'needs-look', quick: true });
    const far = review({ names: ['Sage’s Reverie'], candidates: [candidate(printing('Sage’s Reverie', 'soc', '165'), { hashDistance: 52 })], nameConfidence: 0.29, confidence: 0.05 });
    expect(placeReview(far, TRK)).toMatchObject({ group: 'needs-look', quick: false });
    expect(placeReview(review({ reason: 'unreadable' }), TRK)).toMatchObject({ group: 'needs-look', printing: null });
  });

  it('follows what the user said: a printing they set is confirmed; a guess marked wrong needs a look', () => {
    expect(placeReview(plainsGuessedSld({ chosen: PLAINS_TRK }), NONE)).toMatchObject({ group: 'looks-right', settledBy: 'user', printing: PLAINS_TRK });
    const odo = review({ names: ['Constable Odo'], candidates: [candidate(printing('Constable Odo', 'trk', '230'))], nameConfidence: 0.95, confidence: 0.95, markedWrong: true });
    expect(placeReview(odo, TRK).group).toBe('needs-look');
    expect(placeReview({ ...odo, chosen: PLAINS_TRK }, TRK).group).toBe('needs-look');
  });
});

describe('groupReviews', () => {
  it('sorts copies together, and the quick ones first among those that need a look', () => {
    const sure = (name: string, set: string, number: string) =>
      review({ names: [name], candidates: [candidate(printing(name, set, number))], nameConfidence: 0.95, confidence: 0.95 });
    const odoA = sure('Constable Odo', 'trk', '230');
    const borg = sure('Borg', 'ttrk', '20');
    const odoB = sure('Constable Odo', 'trk', '230');
    const slow = review({ names: ['Grim Physician'], candidates: [candidate(printing('Grim Physician', 'thb', '100'), { hashDistance: 50 })], nameConfidence: 0.5, confidence: 0.25 });
    const quick = review({ names: ['Combadge'], candidates: [candidate(printing('Combadge', 'trk', '260'), { hashDistance: 20 })], nameConfidence: 0.6, confidence: 0.6 });
    const { looksRight, needsLook } = groupReviews([odoA, borg, slow, odoB, quick], () => TRK);
    expect(looksRight.map((entry) => entry.review.id)).toEqual([borg.id, odoA.id, odoB.id]);
    expect(needsLook.map((entry) => entry.review.id)).toEqual([quick.id, slow.id]);
  });
});

describe('bannerTargets', () => {
  it('offers the other reviews of the name, never one the user marked wrong', () => {
    const a = plainsGuessedSld();
    const b = plainsGuessedSld({ markedWrong: true });
    const c = plainsGuessedSld({ chosen: PLAINS_TRK });
    const d = review({ names: ['Island'] });
    expect(bannerTargets([a, b, c, d], 'Plains', PLAINS_TRK).map((item) => item.id)).toEqual([a.id]);
    // Nor one marked wrong on screen and not yet sent, nor a read that named nothing (QA L-e, L-f).
    const junk = plainsGuessedSld({ nameConfidence: 0.2, confidence: 0.1 });
    expect(bannerTargets([a, junk], 'Plains', PLAINS_TRK, new Set([a.id]))).toEqual([]);
  });
});
