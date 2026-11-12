import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Printing } from '../games/types';
import { addCard, createBatch, getItems } from './batches';
import { db } from './db';
import { decideIntake, intake, type ScannedCard } from './intake';
import { acceptReview, acceptReviews, discardReview, getReviews, queueReview, reviewFinish, similarReviews, type NewReview } from './reviews';

const FOREST_A: Printing = { id: 'forest-a', name: 'Forest', set: 'dmu', setName: 'Dominaria United', number: '277', finishes: ['nonfoil', 'foil'], lang: 'en' };
const FOREST_B: Printing = { ...FOREST_A, id: 'forest-b', set: 'one', setName: 'Phyrexia', number: '271' };
const ISLAND: Printing = { ...FOREST_A, id: 'island', name: 'Island', number: '265' };

const candidate = (printing: Printing) => ({ printing, score: 1, title: 1, hashDistance: 8, collector: null, sources: ['title' as const] });

function scanned(overrides: Partial<ScannedCard> = {}): ScannedCard {
  return {
    decision: 'accept',
    names: ['Forest'],
    printings: [candidate(FOREST_A), candidate(FOREST_B)],
    nameConfidence: 0.98,
    confidence: 0.95,
    titleText: 'Forest',
    collectorText: '',
    advice: [],
    gaveUp: false,
    guessedOutline: false,
    card: null,
    ...overrides,
  };
}

function newReview(batchId: string, overrides: Partial<NewReview> = {}): NewReview {
  return {
    batchId,
    source: 'live',
    names: ['Forest'],
    candidates: [candidate(FOREST_A), candidate(FOREST_B)],
    nameConfidence: 0.95,
    confidence: 0.5,
    titleText: 'Forest',
    collectorText: '',
    advice: [],
    reason: 'unsure-printing',
    foil: false,
    lang: 'en',
    condition: 'NM',
    qty: 1,
    ...overrides,
  };
}

beforeEach(async () => {
  await db.batches.clear();
  await db.items.clear();
  await db.reviews.clear();
});

describe('decideIntake', () => {
  it('adds a confident exact printing', () => {
    expect(decideIntake(scanned())).toEqual({ kind: 'add', printing: FOREST_A });
  });

  it('sends everything else to review, saying why', () => {
    expect(decideIntake(scanned({ decision: 'review', confidence: 0.5 }))).toEqual({ kind: 'review', reason: 'unsure-printing' });
    expect(decideIntake(scanned({ decision: 'review', nameConfidence: 0.6, confidence: 0.5 }))).toEqual({ kind: 'review', reason: 'unsure-name' });
    expect(decideIntake(scanned({ decision: 'review', names: [], printings: [], gaveUp: true }))).toEqual({ kind: 'review', reason: 'unreadable' });
    expect(decideIntake(scanned({ decision: 'review', guessedOutline: true }))).toEqual({ kind: 'review', reason: 'check' });
  });

  it('never adds a card from outside the locked sets', () => {
    expect(decideIntake(scanned({ outsideLock: true }))).toEqual({ kind: 'review', reason: 'outside-lock' });
  });

  it('never adds a sure name without a printing', () => {
    expect(decideIntake(scanned({ printings: [] }))).toEqual({ kind: 'review', reason: 'unsure-printing' });
  });
});

describe('intake', () => {
  it('adds a confident card to the batch, foil when the batch says so', async () => {
    const batch = await createBatch('B');
    const outcome = await intake({ ...batch, settings: { ...batch.settings, foil: true } }, scanned(), 'live');
    expect(outcome).toMatchObject({ kind: 'added', printing: FOREST_A, finish: 'foil' });
    expect(await getItems(batch.id)).toMatchObject([{ printing: { id: 'forest-a' }, finish: 'foil', qty: 1 }]);
    expect(await db.reviews.count()).toBe(0);
  });

  it('queues an unsure card with its crop and the settings it was scanned with', async () => {
    const batch = await createBatch('B');
    const german = { ...batch, settings: { defaultLang: 'de', defaultCondition: 'LP', foil: true } };
    const card = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
    const outcome = await intake(german, scanned({ decision: 'review', confidence: 0.4, card }), 'photo');
    expect(outcome.kind).toBe('review');
    const [stored] = await getReviews(batch.id);
    expect(stored).toMatchObject({ reason: 'unsure-printing', lang: 'de', condition: 'LP', foil: true, source: 'photo', qty: 1 });
    expect(new Uint8Array(stored!.crop!)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await getItems(batch.id)).toEqual([]);
  });
});

describe('reviews', () => {
  it('accepts a review as the chosen printing, into the batch and out of the queue', async () => {
    const batch = await createBatch('B');
    const queued = await queueReview(newReview(batch.id, { lang: 'de', qty: 2 }));
    await acceptReview(batch, queued, { printing: FOREST_B, finish: 'nonfoil', qty: 2 });
    expect(await getItems(batch.id)).toMatchObject([{ printing: { id: 'forest-b' }, lang: 'de', condition: 'NM', qty: 2 }]);
    expect(await getReviews(batch.id)).toEqual([]);
  });

  it('adds an accepted review to a matching row', async () => {
    const batch = await createBatch('B');
    const row = await addCard(batch, FOREST_A, { finish: 'nonfoil' });
    const queued = await queueReview(newReview(batch.id));
    expect(await acceptReview(batch, queued, { printing: FOREST_A, finish: 'nonfoil', qty: 1 })).toEqual([row]);
    expect(await getItems(batch.id)).toMatchObject([{ id: row, qty: 2 }]);
  });

  it('applies one choice to all similar reviews at once', async () => {
    const batch = await createBatch('B');
    const first = await queueReview(newReview(batch.id));
    const second = await queueReview(newReview(batch.id, { foil: true }));
    const island = await queueReview(newReview(batch.id, { names: ['Island'], candidates: [candidate(ISLAND)] }));
    const all = await getReviews(batch.id);
    const similar = similarReviews(all, first, 'Forest');
    expect(similar.map((review) => review.id)).toEqual([second.id]);

    await acceptReviews(
      batch,
      [first, ...similar].map((review) => ({ review, resolution: { printing: FOREST_B, finish: reviewFinish(batch, review, FOREST_B), qty: review.qty } })),
    );
    expect((await getItems(batch.id)).map((item) => [item.printing.id, item.finish, item.qty]).sort()).toEqual([
      ['forest-b', 'foil', 1],
      ['forest-b', 'nonfoil', 1],
    ]);
    expect((await getReviews(batch.id)).map((review) => review.id)).toEqual([island.id]);
  });

  it('discards a review', async () => {
    const batch = await createBatch('B');
    const queued = await queueReview(newReview(batch.id));
    await discardReview(queued.id);
    expect(await getReviews(batch.id)).toEqual([]);
  });

  it('skips a review that was already handled', async () => {
    const batch = await createBatch('B');
    const queued = await queueReview(newReview(batch.id));
    await discardReview(queued.id);
    expect(await acceptReview(batch, queued, { printing: FOREST_A, finish: 'nonfoil', qty: 1 })).toEqual([]);
    expect(await getItems(batch.id)).toEqual([]);
  });
});
