import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Printing } from '../games/types';
import {
  addCard,
  changeQuantity,
  createBatch,
  deleteBatch,
  ensureBatch,
  changeItemPrinting,
  getItems,
  mergeBatches,
  removeItem,
  updateBatch,
  updateBatchSettings,
  updateItem,
} from './batches';
import { db } from './db';

const SOL_RING: Printing = {
  id: 'sol-ring-cmm',
  name: 'Sol Ring',
  set: 'cmm',
  setName: 'Commander Masters',
  number: '410',
  finishes: ['nonfoil', 'foil'],
  lang: 'en',
};

const SOL_RING_FOIL_ONLY: Printing = { ...SOL_RING, id: 'sol-ring-promo', set: 'pcmm', setName: 'CMM Promos', number: '1', finishes: ['foil'] };

beforeEach(async () => {
  await db.batches.clear();
  await db.items.clear();
  await db.reviews.clear();
});

describe('batches', () => {
  it('creates a batch with the game default settings', async () => {
    const batch = await createBatch('Box 3', 'mtg', 'Box 3 – Rares');
    expect(batch).toMatchObject({
      name: 'Box 3',
      location: 'Box 3 – Rares',
      settings: { defaultLang: 'en', defaultCondition: 'NM' },
    });
    expect(await db.batches.get(batch.id)).toEqual(batch);
  });

  it('creates only one first batch when asked twice at once, as React StrictMode does', async () => {
    const [a, b] = await Promise.all([ensureBatch(), ensureBatch()]);
    expect(a.id).toBe(b.id);
    expect(await db.batches.count()).toBe(1);
  });

  it('returns the newest existing batch', async () => {
    await createBatch('Old');
    await new Promise((resolve) => setTimeout(resolve, 2));
    const newer = await createBatch('New');
    expect((await ensureBatch()).id).toBe(newer.id);
  });

  it('renames a batch and changes its defaults', async () => {
    const batch = await createBatch('Old');
    await updateBatch(batch.id, { name: 'New' });
    await updateBatchSettings(batch.id, { defaultLang: 'de', defaultCondition: 'LP' });
    expect(await db.batches.get(batch.id)).toMatchObject({
      name: 'New',
      settings: { defaultLang: 'de', defaultCondition: 'LP' },
    });
  });

  it('keeps both settings when they are changed at the same moment', async () => {
    const batch = await createBatch('B');
    await Promise.all([
      updateBatchSettings(batch.id, { defaultLang: 'ja' }),
      updateBatchSettings(batch.id, { defaultCondition: 'HP' }),
    ]);
    expect((await db.batches.get(batch.id))?.settings).toEqual({ defaultLang: 'ja', defaultCondition: 'HP' });
  });

  it('deletes a batch with its items, leaving other batches alone', async () => {
    const doomed = await createBatch('Doomed');
    const kept = await createBatch('Kept');
    await addCard(doomed, SOL_RING, { finish: 'nonfoil' });
    await addCard(kept, SOL_RING, { finish: 'nonfoil' });

    await deleteBatch(doomed.id);

    expect(await db.batches.get(doomed.id)).toBeUndefined();
    expect(await getItems(doomed.id)).toEqual([]);
    expect(await getItems(kept.id)).toHaveLength(1);
  });

  it('deletes the reviews waiting in a deleted batch', async () => {
    const doomed = await createBatch('Doomed');
    await db.reviews.add(review('r1', doomed.id));
    await deleteBatch(doomed.id);
    expect(await db.reviews.count()).toBe(0);
  });

  it('merges one batch into another, adding matching rows together and moving reviews', async () => {
    const from = await createBatch('From');
    const into = await createBatch('Into');
    await addCard(from, SOL_RING, { finish: 'nonfoil', qty: 2 });
    await addCard(from, SOL_RING, { finish: 'foil' });
    await addCard(into, SOL_RING, { finish: 'nonfoil', qty: 3 });
    await db.reviews.add(review('r1', from.id));

    await mergeBatches(from.id, into.id);

    expect(await db.batches.get(from.id)).toBeUndefined();
    const items = await getItems(into.id);
    expect(items.map((item) => [item.finish, item.qty]).sort()).toEqual([
      ['foil', 1],
      ['nonfoil', 5],
    ]);
    expect((await db.reviews.get('r1'))?.batchId).toBe(into.id);
  });

  it("doesn't merge a batch into itself", async () => {
    const batch = await createBatch('B');
    await addCard(batch, SOL_RING, { finish: 'nonfoil' });
    await mergeBatches(batch.id, batch.id);
    expect(await getItems(batch.id)).toHaveLength(1);
  });
});

function review(id: string, batchId: string) {
  return {
    id,
    batchId,
    createdAt: new Date().toISOString(),
    source: 'live' as const,
    names: ['Sol Ring'],
    candidates: [],
    nameConfidence: 0.5,
    confidence: 0.4,
    titleText: '',
    collectorText: '',
    advice: [],
    reason: 'unsure-name' as const,
    foil: false,
    lang: 'en',
    condition: 'NM',
    qty: 1,
  };
}

describe('items', () => {
  it('raises the quantity when the same card is added again, returning the same row', async () => {
    const batch = await createBatch('B');
    const first = await addCard(batch, SOL_RING, { finish: 'nonfoil' });
    const second = await addCard(batch, SOL_RING, { finish: 'nonfoil', qty: 2 });
    const items = await getItems(batch.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.qty).toBe(3);
    expect(second).toBe(first);
    expect(items[0]?.id).toBe(first);
  });

  it('changes the printing of a row, keeping its finish when the new printing has it', async () => {
    const batch = await createBatch('B');
    await addCard(batch, SOL_RING, { finish: 'foil', qty: 2 });
    const [item] = await getItems(batch.id);
    const other = { ...SOL_RING, id: 'sol-ring-c21', set: 'c21', number: '263' };
    await changeItemPrinting(item!, other, 'mtg');
    expect((await getItems(batch.id))[0]).toMatchObject({ printing: { id: 'sol-ring-c21' }, finish: 'foil', qty: 2 });
  });

  it('changes the finish too when the new printing only comes in another', async () => {
    const batch = await createBatch('B');
    await addCard(batch, SOL_RING, { finish: 'nonfoil' });
    const [item] = await getItems(batch.id);
    await changeItemPrinting(item!, SOL_RING_FOIL_ONLY, 'mtg');
    expect((await getItems(batch.id))[0]).toMatchObject({ printing: { id: 'sol-ring-promo' }, finish: 'foil' });
  });

  it('merges rows when a changed printing matches another row', async () => {
    const batch = await createBatch('B');
    const other = { ...SOL_RING, id: 'sol-ring-c21', set: 'c21', number: '263' };
    await addCard(batch, SOL_RING, { finish: 'nonfoil', qty: 2 });
    const kept = await addCard(batch, other, { finish: 'nonfoil' });
    const wrong = (await getItems(batch.id)).find((item) => item.printing.id === SOL_RING.id)!;
    expect(await changeItemPrinting(wrong, other, 'mtg')).toBe(kept);
    expect(await getItems(batch.id)).toMatchObject([{ id: kept, qty: 3 }]);
  });

  it('keeps different finishes, languages and conditions apart', async () => {
    const batch = await createBatch('B');
    await addCard(batch, SOL_RING, { finish: 'nonfoil' });
    await addCard(batch, SOL_RING, { finish: 'foil' });
    await addCard(batch, SOL_RING, { finish: 'nonfoil', lang: 'de' });
    await addCard(batch, SOL_RING, { finish: 'nonfoil', condition: 'LP' });
    expect(await getItems(batch.id)).toHaveLength(4);
  });

  it('applies the batch defaults to new cards', async () => {
    const batch = await createBatch('B');
    const german = { ...batch, settings: { defaultLang: 'de', defaultCondition: 'LP' } };
    await addCard(german, SOL_RING, { finish: 'nonfoil' });
    expect((await getItems(batch.id))[0]).toMatchObject({ lang: 'de', condition: 'LP' });
  });

  it('keeps the language of a printing that has no English version', async () => {
    const batch = await createBatch('B');
    await addCard(batch, { ...SOL_RING, id: 'es-only', lang: 'es' }, { finish: 'nonfoil' });
    expect((await getItems(batch.id))[0]?.lang).toBe('es');
  });

  it('removes a row when its quantity reaches zero', async () => {
    const batch = await createBatch('B');
    await addCard(batch, SOL_RING, { finish: 'nonfoil', qty: 2 });
    const [item] = await getItems(batch.id);
    await changeQuantity(item!.id, -1);
    expect((await getItems(batch.id))[0]?.qty).toBe(1);
    await changeQuantity(item!.id, -1);
    expect(await getItems(batch.id)).toEqual([]);
  });

  it('counts every tap when the quantity is changed quickly', async () => {
    const batch = await createBatch('B');
    await addCard(batch, SOL_RING, { finish: 'nonfoil' });
    const [item] = await getItems(batch.id);
    await Promise.all([changeQuantity(item!.id, 1), changeQuantity(item!.id, 1), changeQuantity(item!.id, 1)]);
    expect((await getItems(batch.id))[0]?.qty).toBe(4);
  });

  it('ignores a quantity change for a row that is already gone', async () => {
    await expect(changeQuantity('missing', 1)).resolves.toBeUndefined();
  });

  it('removes a row directly', async () => {
    const batch = await createBatch('B');
    await addCard(batch, SOL_RING, { finish: 'nonfoil' });
    await removeItem((await getItems(batch.id))[0]!.id);
    expect(await getItems(batch.id)).toEqual([]);
  });

  it('updates a finish, so that a later add of that finish merges with it', async () => {
    const batch = await createBatch('B');
    await addCard(batch, SOL_RING, { finish: 'nonfoil' });
    await updateItem((await getItems(batch.id))[0]!.id, { finish: 'foil' });
    await addCard(batch, SOL_RING, { finish: 'foil' });
    const items = await getItems(batch.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ finish: 'foil', qty: 2 });
  });

  it('merges two rows when an edit makes them the same', async () => {
    const batch = await createBatch('B');
    await addCard(batch, SOL_RING, { finish: 'nonfoil', qty: 2 });
    await addCard(batch, SOL_RING, { finish: 'foil', qty: 3 });
    const foil = (await getItems(batch.id)).find((item) => item.finish === 'foil')!;
    await updateItem(foil.id, { finish: 'nonfoil' });
    const items = await getItems(batch.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ finish: 'nonfoil', qty: 5 });
  });
});
