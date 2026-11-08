import { getGame } from '../games/registry';
import type { GameId, Printing } from '../games/types';
import { db } from './db';
import type { Batch, BatchItem, BatchSettings } from './types';

function mergeKeyFor(printingId: string, finish: string, lang: string, condition: string): string {
  return JSON.stringify([printingId, finish, lang, condition]);
}

export async function createBatch(name: string, game: GameId = 'mtg', location?: string): Promise<Batch> {
  const adapter = getGame(game);
  const batch: Batch = {
    id: crypto.randomUUID(),
    game,
    name,
    ...(location ? { location } : {}),
    createdAt: new Date().toISOString(),
    settings: { defaultLang: adapter.defaultLang, defaultCondition: adapter.defaultCondition },
  };
  await db.batches.add(batch);
  return batch;
}

/** Returns the newest batch, creating the first one if needed. Safe to call twice at once. */
export async function ensureBatch(): Promise<Batch> {
  return db.transaction('rw', db.batches, async () => {
    const newest = await db.batches.orderBy('createdAt').last();
    return newest ?? createBatch('My first batch');
  });
}

export async function updateBatch(id: string, changes: Partial<Pick<Batch, 'name' | 'location'>>): Promise<void> {
  await db.batches.update(id, changes);
}

/** Changes settings inside the database, so that two quick edits can't undo each other. */
export async function updateBatchSettings(id: string, changes: Partial<BatchSettings>): Promise<void> {
  await db.batches.where('id').equals(id).modify((batch) => {
    batch.settings = { ...batch.settings, ...changes };
  });
}

export async function deleteBatch(id: string): Promise<void> {
  await db.transaction('rw', db.batches, db.items, async () => {
    await db.items.where('batchId').equals(id).delete();
    await db.batches.delete(id);
  });
}

export async function getItems(batchId: string): Promise<BatchItem[]> {
  return db.items.where('batchId').equals(batchId).sortBy('addedAt');
}

export interface AddCardOptions {
  finish: string;
  lang?: string;
  condition?: string;
  qty?: number;
}

/** Adds to the matching row when one exists, so the same card never fills the list with duplicates. */
export async function addCard(batch: Batch, printing: Printing, options: AddCardOptions): Promise<void> {
  // A printing that only exists in another language can't be in the batch's default language.
  const lang = options.lang ?? (printing.lang !== 'en' ? printing.lang : batch.settings.defaultLang);
  const condition = options.condition ?? batch.settings.defaultCondition;
  const qty = options.qty ?? 1;
  const mergeKey = mergeKeyFor(printing.id, options.finish, lang, condition);

  await db.transaction('rw', db.items, async () => {
    const existing = await db.items.where({ batchId: batch.id, mergeKey }).first();
    if (existing) {
      await db.items.update(existing.id, { qty: existing.qty + qty });
      return;
    }
    await db.items.add({
      id: crypto.randomUUID(),
      batchId: batch.id,
      printing,
      finish: options.finish,
      lang,
      condition,
      qty,
      addedAt: new Date().toISOString(),
      mergeKey,
    });
  });
}

/**
 * Adjusts inside the database, so that fast tapping counts every tap. Reaching
 * zero removes the row.
 */
export async function changeQuantity(itemId: string, delta: number): Promise<void> {
  await db.transaction('rw', db.items, async () => {
    const item = await db.items.get(itemId);
    if (!item) return;
    const qty = item.qty + delta;
    if (qty <= 0) await db.items.delete(itemId);
    else await db.items.update(itemId, { qty });
  });
}

export async function removeItem(itemId: string): Promise<void> {
  await db.items.delete(itemId);
}

/** Changing a row to match another row merges the two. */
export async function updateItem(
  itemId: string,
  changes: Partial<Pick<BatchItem, 'finish' | 'lang' | 'condition'>>,
): Promise<void> {
  await db.transaction('rw', db.items, async () => {
    const item = await db.items.get(itemId);
    if (!item) return;
    const next = { ...item, ...changes };
    const mergeKey = mergeKeyFor(next.printing.id, next.finish, next.lang, next.condition);
    const twin = await db.items.where({ batchId: item.batchId, mergeKey }).first();
    if (twin && twin.id !== item.id) {
      await db.items.update(twin.id, { qty: twin.qty + item.qty });
      await db.items.delete(item.id);
      return;
    }
    await db.items.update(item.id, { ...changes, mergeKey });
  });
}
