/**
 * Full backup and restore of every batch, its cards and its waiting reviews,
 * as one JSON file, so nothing is lost when the browser's storage is cleared.
 */
import type { GameId, Printing } from '../games/types';
import { mergeKeyFor } from './batches';
import { db } from './db';
import type { Batch, BatchItem, ReviewItem } from './types';

export const BACKUP_FORMAT = 'manifest-backup';
export const BACKUP_VERSION = 1;

type BackupItem = Omit<BatchItem, 'batchId' | 'mergeKey'>;
/** A review with its crop as base64 JPEG. */
type BackupReview = Omit<ReviewItem, 'batchId' | 'crop'> & { crop?: string };

export interface BackupBatch extends Batch {
  items: BackupItem[];
  reviews: BackupReview[];
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  /** ISO timestamp. */
  exportedAt: string;
  batches: BackupBatch[];
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): ArrayBuffer {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function createBackup(now: Date = new Date()): Promise<BackupFile> {
  return db.transaction('r', db.batches, db.items, db.reviews, async () => {
    const batches = await db.batches.orderBy('createdAt').toArray();
    const items = await db.items.toArray();
    const reviews = await db.reviews.orderBy('createdAt').toArray();
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: now.toISOString(),
      batches: batches.map((batch) => ({
        ...batch,
        items: items
          .filter((item) => item.batchId === batch.id)
          .sort((a, b) => a.addedAt.localeCompare(b.addedAt))
          .map(({ batchId: _batchId, mergeKey: _mergeKey, ...item }) => item),
        reviews: reviews
          .filter((review) => review.batchId === batch.id)
          .map(({ batchId: _batchId, crop, ...review }) => ({ ...review, ...(crop ? { crop: toBase64(crop) } : {}) })),
      })),
    };
  });
}

export function backupFileName(now: Date = new Date()): string {
  return `manifest-backup-${now.toISOString().slice(0, 10)}.json`;
}

export class BackupError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';

function isPrinting(value: unknown): value is Printing {
  return (
    isObject(value) &&
    isString(value.id) &&
    isString(value.name) &&
    isString(value.set) &&
    isString(value.number) &&
    Array.isArray(value.finishes) &&
    isString(value.lang)
  );
}

/** Checks the shape of a backup well enough that restoring it can't store junk. */
export function parseBackup(text: string, games: readonly GameId[] = ['mtg']): BackupFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new BackupError("This file isn't a Manifest backup: it isn't JSON.");
  }
  if (!isObject(data) || data.format !== BACKUP_FORMAT) throw new BackupError("This file isn't a Manifest backup.");
  if (data.version !== BACKUP_VERSION) {
    throw new BackupError('This backup was made by a newer version of Manifest. Reload the app to update it, then try again.');
  }
  if (!Array.isArray(data.batches)) throw new BackupError('This backup is damaged: it has no list of batches.');
  for (const batch of data.batches as unknown[]) {
    if (
      !isObject(batch) ||
      !isString(batch.id) ||
      !isString(batch.name) ||
      !games.includes(batch.game as GameId) ||
      !isObject(batch.settings) ||
      !Array.isArray(batch.items) ||
      !Array.isArray(batch.reviews)
    ) {
      throw new BackupError('This backup is damaged: a batch is missing its name, game, settings or cards.');
    }
    for (const item of batch.items as unknown[]) {
      if (!isObject(item) || !isPrinting(item.printing) || typeof item.qty !== 'number' || item.qty < 1 || !isString(item.finish)) {
        throw new BackupError(`This backup is damaged: a card in “${batch.name}” is incomplete.`);
      }
    }
    for (const review of batch.reviews as unknown[]) {
      if (!isObject(review) || !Array.isArray(review.names) || !Array.isArray(review.candidates)) {
        throw new BackupError(`This backup is damaged: a card waiting for review in “${batch.name}” is incomplete.`);
      }
    }
  }
  return data as unknown as BackupFile;
}

export interface RestoreSummary {
  batches: number;
  cards: number;
  reviews: number;
  /** Batches that already existed here, restored as copies beside them. */
  copies: number;
}

/**
 * Adds every batch in the backup. Nothing here is overwritten: a batch that
 * already exists (the same one, backed up earlier) is restored as a copy with
 * "(restored)" after its name, for the user to compare, merge or delete.
 */
export async function restoreBackup(backup: BackupFile): Promise<RestoreSummary> {
  const summary: RestoreSummary = { batches: 0, cards: 0, reviews: 0, copies: 0 };
  await db.transaction('rw', db.batches, db.items, db.reviews, async () => {
    for (const { items, reviews, ...stored } of backup.batches) {
      const exists = Boolean(await db.batches.get(stored.id));
      const batch: Batch = {
        id: exists ? crypto.randomUUID() : stored.id,
        game: stored.game,
        name: exists ? `${stored.name} (restored)` : stored.name,
        ...(stored.location ? { location: stored.location } : {}),
        createdAt: stored.createdAt ?? new Date().toISOString(),
        settings: stored.settings,
      };
      await db.batches.add(batch);
      summary.batches += 1;
      if (exists) summary.copies += 1;

      const rows = new Map<string, BatchItem>();
      for (const item of items) {
        const mergeKey = mergeKeyFor(item.printing.id, item.finish, item.lang, item.condition);
        const twin = rows.get(mergeKey);
        if (twin) twin.qty += item.qty;
        else rows.set(mergeKey, { ...item, id: crypto.randomUUID(), batchId: batch.id, mergeKey });
        summary.cards += item.qty;
      }
      await db.items.bulkAdd([...rows.values()]);

      await db.reviews.bulkAdd(
        reviews.map(({ crop, ...review }) => ({
          ...review,
          id: crypto.randomUUID(),
          batchId: batch.id,
          ...(crop ? { crop: fromBase64(crop) } : {}),
        })),
      );
      summary.reviews += reviews.length;
    }
  });
  return summary;
}
