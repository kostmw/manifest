import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Printing } from '../games/types';
import {
  addCard,
  changeQuantity,
  createBatch,
  deleteBatch,
  ensureBatch,
  getItems,
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

beforeEach(async () => {
  await db.batches.clear();
  await db.items.clear();
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
});

describe('items', () => {
  it('raises the quantity when the same card is added again', async () => {
    const batch = await createBatch('B');
    await addCard(batch, SOL_RING, { finish: 'nonfoil' });
    await addCard(batch, SOL_RING, { finish: 'nonfoil', qty: 2 });
    const items = await getItems(batch.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.qty).toBe(3);
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
