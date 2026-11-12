import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Printing } from '../games/types';
import { addCard, createBatch, getItems } from './batches';
import { BackupError, createBackup, parseBackup, restoreBackup } from './backup';
import { db } from './db';
import { getReviews, queueReview } from './reviews';

const SOL_RING: Printing = { id: 'sol-ring-cmm', name: 'Sol Ring', set: 'cmm', setName: 'Commander Masters', number: '410', finishes: ['nonfoil', 'foil'], lang: 'en' };

async function clear() {
  await db.batches.clear();
  await db.items.clear();
  await db.reviews.clear();
}

beforeEach(clear);

async function fill() {
  const batch = await createBatch('Box 3', 'mtg', 'Shelf');
  await addCard(batch, SOL_RING, { finish: 'foil', qty: 2 });
  await queueReview({
    batchId: batch.id,
    source: 'live',
    crop: new Uint8Array([255, 216, 255, 0, 1, 2]).buffer,
    names: ['Sol Ring'],
    candidates: [],
    nameConfidence: 0.6,
    confidence: 0.3,
    titleText: 'Sol Rlng',
    collectorText: '',
    advice: ['dim'],
    reason: 'unsure-name',
    foil: false,
    lang: 'en',
    condition: 'NM',
    qty: 1,
  });
  return batch;
}

describe('backup', () => {
  it('restores everything after the storage was cleared', async () => {
    const batch = await fill();
    const text = JSON.stringify(await createBackup(new Date('2026-11-12T10:00:00Z')));
    await clear();

    const summary = await restoreBackup(parseBackup(text));

    expect(summary).toEqual({ batches: 1, cards: 2, reviews: 1, copies: 0 });
    expect(await db.batches.get(batch.id)).toMatchObject({ name: 'Box 3', location: 'Shelf' });
    expect(await getItems(batch.id)).toMatchObject([{ printing: SOL_RING, finish: 'foil', qty: 2 }]);
    const [review] = await getReviews(batch.id);
    expect(review).toMatchObject({ titleText: 'Sol Rlng', reason: 'unsure-name' });
    expect(new Uint8Array(review!.crop!)).toEqual(new Uint8Array([255, 216, 255, 0, 1, 2]));
  });

  it('restores a batch that still exists as a copy, overwriting nothing', async () => {
    const batch = await fill();
    const backup = parseBackup(JSON.stringify(await createBackup()));
    await addCard(batch, SOL_RING, { finish: 'foil' });

    expect(await restoreBackup(backup)).toMatchObject({ batches: 1, copies: 1 });

    const batches = await db.batches.toArray();
    expect(batches.map((b) => b.name).sort()).toEqual(['Box 3', 'Box 3 (restored)']);
    expect((await getItems(batch.id))[0]?.qty).toBe(3);
    const copy = batches.find((b) => b.id !== batch.id)!;
    expect((await getItems(copy.id))[0]?.qty).toBe(2);
    expect(await getReviews(copy.id)).toHaveLength(1);
  });

  it('refuses files that are not backups, with a reason', () => {
    expect(() => parseBackup('not json')).toThrow(BackupError);
    expect(() => parseBackup('{"format":"something"}')).toThrow("isn't a Manifest backup");
    expect(() => parseBackup('{"format":"manifest-backup","version":2,"batches":[]}')).toThrow('newer version');
    expect(() =>
      parseBackup(
        JSON.stringify({ format: 'manifest-backup', version: 1, batches: [{ id: 'b', name: 'B', game: 'mtg', settings: {}, items: [{ qty: 1 }], reviews: [] }] }),
      ),
    ).toThrow('incomplete');
  });
});
