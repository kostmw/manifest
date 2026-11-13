import { getGame } from '../games/registry';
import type { GameId, Printing } from '../games/types';
import { db } from './db';
import type { Batch, BatchItem, BatchSettings } from './types';

export function mergeKeyFor(printingId: string, finish: string, lang: string, condition: string): string {
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
  await db.transaction('rw', db.batches, db.items, db.reviews, async () => {
    await db.items.where('batchId').equals(id).delete();
    await db.reviews.where('batchId').equals(id).delete();
    await db.batches.delete(id);
  });
}

/**
 * Moves every card and waiting review of one batch into another, then deletes
 * the emptied batch. Rows that match (same printing, finish, language and
 * condition) are added together.
 */
export async function mergeBatches(sourceId: string, targetId: string): Promise<void> {
  if (sourceId === targetId) return;
  await db.transaction('rw', db.batches, db.items, db.reviews, async () => {
    if (!(await db.batches.get(targetId))) throw new Error('The batch to merge into is gone');
    for (const item of await db.items.where('batchId').equals(sourceId).toArray()) {
      const twin = await db.items.where({ batchId: targetId, mergeKey: item.mergeKey }).first();
      if (twin) {
        await db.items.update(twin.id, {
          qty: twin.qty + item.qty,
          addedAt: item.addedAt < twin.addedAt ? item.addedAt : twin.addedAt,
          ...mergedScans(twin, item),
        });
        await db.items.delete(item.id);
      } else {
        await db.items.update(item.id, { batchId: targetId });
      }
    }
    await db.reviews.where('batchId').equals(sourceId).modify({ batchId: targetId });
    await db.batches.delete(sourceId);
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
  /** The test log's id of the scan that adds it. */
  scanId?: string;
}

/** Scan ids kept on a batch row, for the test log's printing changes. */
const SCAN_IDS_KEPT = 20;
export const withScan = (ids: string[] | undefined, scanId: string | undefined) => (scanId ? [...(ids ?? []), scanId].slice(-SCAN_IDS_KEPT) : ids);
/** Two rows' scan ids, for the row they merge into. */
function mergedScans(into: BatchItem, from: BatchItem): Partial<BatchItem> {
  const ids = [...(into.scanIds ?? []), ...(from.scanIds ?? [])].slice(-SCAN_IDS_KEPT);
  return ids.length ? { scanIds: ids } : {};
}

/**
 * Adds to the matching row when one exists, so the same card never fills the
 * list with duplicates. Returns the row's id.
 */
export async function addCard(batch: Batch, printing: Printing, options: AddCardOptions): Promise<string> {
  // A printing that only exists in another language can't be in the batch's default language.
  const lang = options.lang ?? (printing.lang !== 'en' ? printing.lang : batch.settings.defaultLang);
  const condition = options.condition ?? batch.settings.defaultCondition;
  const qty = options.qty ?? 1;
  const mergeKey = mergeKeyFor(printing.id, options.finish, lang, condition);

  return db.transaction('rw', db.items, async () => {
    const existing = await db.items.where({ batchId: batch.id, mergeKey }).first();
    if (existing) {
      const scanIds = withScan(existing.scanIds, options.scanId);
      await db.items.update(existing.id, { qty: existing.qty + qty, ...(scanIds ? { scanIds } : {}) });
      return existing.id;
    }
    const id = crypto.randomUUID();
    await db.items.add({
      ...(options.scanId ? { scanIds: [options.scanId] } : {}),
      id,
      batchId: batch.id,
      printing,
      finish: options.finish,
      lang,
      condition,
      qty,
      addedAt: new Date().toISOString(),
      mergeKey,
    });
    return id;
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

/**
 * Changes a row's printing, finish, language or condition. Changing a row to
 * match another row merges the two. Returns the id of the row that holds the
 * cards afterwards (the other one, after a merge), or null when the row is gone.
 */
export async function updateItem(
  itemId: string,
  changes: Partial<Pick<BatchItem, 'printing' | 'finish' | 'lang' | 'condition'>>,
): Promise<string | null> {
  return db.transaction('rw', db.items, async () => {
    const item = await db.items.get(itemId);
    if (!item) return null;
    const next = { ...item, ...changes };
    const mergeKey = mergeKeyFor(next.printing.id, next.finish, next.lang, next.condition);
    const twin = await db.items.where({ batchId: item.batchId, mergeKey }).first();
    if (twin && twin.id !== item.id) {
      await db.items.update(twin.id, { qty: twin.qty + item.qty, ...mergedScans(twin, item) });
      await db.items.delete(item.id);
      return twin.id;
    }
    await db.items.update(item.id, { ...changes, mergeKey });
    return item.id;
  });
}

/**
 * Puts another printing on a row, keeping its finish when the new printing
 * comes in it, else the finish the game would pick for it.
 */
export async function changeItemPrinting(item: BatchItem, printing: Printing, game: GameId): Promise<string | null> {
  const adapter = getGame(game);
  const finish = printing.finishes.includes(item.finish) ? item.finish : adapter.defaultFinish(printing, adapter.isFoil(item.finish));
  // A printing that only exists in another language carries that language, as when it is added.
  const lang = printing.lang !== 'en' ? printing.lang : item.printing.lang !== 'en' ? adapter.defaultLang : item.lang;
  return updateItem(item.id, { printing, finish, lang });
}
