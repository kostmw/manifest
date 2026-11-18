/**
 * Bulk imports, as stored: each job, and what became of each file it read.
 * The photos themselves aren't kept (a thousand phone photos would take
 * gigabytes), only a key per file, so that after a reload the same photos can
 * be picked again and the ones already read are skipped.
 */
import { db } from './db';

/**
 * `running` and `paused` jobs that no import in this page is working on were
 * cut short by a reload (see capture/importQueue.ts).
 */
export type ImportState = 'running' | 'paused' | 'done' | 'cancelled' | 'stopped';

export interface ImportJob {
  id: string;
  batchId: string;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
  state: ImportState;
  /** Why a `stopped` job stopped. */
  why?: 'batch-gone';
  /** Files picked, skipped ones included. */
  total: number;
  /** Files by what became of them. */
  photos: { added: number; review: number; failed: number; skipped: number };
  /** Cards found in them; `unread`: outlines in photos of several cards that named no card (see ImportFile.unread). */
  cards: { added: number; review: number; unread?: number };
  /** The user closed its summary. */
  dismissed?: true;
}

/** Why a file gave no card. */
export type ImportFailure =
  /** Not a picture at all (a PDF or a text file in a folder). */
  | 'not-image'
  /** A picture this browser can't open (HEIC in desktop Chrome, a damaged file). */
  | 'unopenable'
  /** Opened, but no card was found in it. */
  | 'no-card'
  /** Reading it went wrong (or took far too long). */
  | 'error'
  /** A photo of several cards: some outlines in it named no card (see ImportFile.unread). The others were filed. */
  | 'unread'
  /** A photo of several cards with mostly the same cards as an earlier photo in the import (see ImportFile.repeatOf). */
  | 'repeat';

export interface ImportFile {
  jobId: string;
  /** See capture/fileKey.ts: the file's size and a hash of its start. */
  key: string;
  batchId: string;
  name: string;
  size: number;
  /** Every card found added, some waiting for review, or none found. */
  status: 'added' | 'review' | 'failed';
  failure?: ImportFailure;
  itemIds?: string[];
  reviewIds?: string[];
  /** For `no-card`: the photo, small, as JPEG bytes, for "Review it anyway". */
  picture?: ArrayBuffer;
  /**
   * A photo of several cards: pictures of the outlines in it that named no
   * card (an empty binder pocket, or a card too worn or glared to read), as
   * JPEG bytes, for "Review it anyway". Cleared once sent to review.
   */
  unread?: ArrayBuffer[];
  /**
   * A photo of several cards that shares most of its cards with an earlier
   * photo in the same import: probably the same binder page photographed
   * twice, so its cards may be counted twice. Cleared when the user keeps them.
   */
  repeatOf?: { name: string; shared: number };
  /** The user took this photo's cards back out of the batch (a repeated page). */
  takenOut?: true;
  /** ISO timestamp. */
  at: string;
}

export const emptyCounts = (): Pick<ImportJob, 'photos' | 'cards'> => ({
  photos: { added: 0, review: 0, failed: 0, skipped: 0 },
  cards: { added: 0, review: 0 },
});

export async function saveJob(job: ImportJob): Promise<void> {
  await db.imports.put(job);
}

/** Saves what became of a file together with the job's new counts, so the two never disagree after a reload. */
export async function saveFile(job: ImportJob, file: ImportFile): Promise<void> {
  await db.transaction('rw', db.imports, db.importFiles, async () => {
    await db.importFiles.put(file);
    await db.imports.put(job);
  });
}

/** The keys among these that a finished file in this batch already has: those photos were read into it before. */
export async function keysAlreadyRead(batchId: string, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const found = await db.importFiles
    .where('[batchId+key]')
    .anyOf(keys.map((key) => [batchId, key]))
    .filter((file) => file.status !== 'failed')
    .toArray();
  return new Set(found.map((file) => file.key));
}

export async function getJob(id: string): Promise<ImportJob | undefined> {
  return db.imports.get(id);
}

/** The newest job whose summary hasn't been closed, in any batch. */
export async function latestOpenJob(): Promise<ImportJob | undefined> {
  const jobs = await db.imports.orderBy('createdAt').reverse().toArray();
  return jobs.find((job) => !job.dismissed);
}

/** A job's files that gave no card, or have outlines that named none, oldest first. */
export async function jobFailures(jobId: string): Promise<ImportFile[]> {
  const files = await db.importFiles.where('jobId').equals(jobId).toArray();
  return files
    .filter((file) => !file.takenOut && (file.status === 'failed' || (file.unread?.length ?? 0) > 0 || file.repeatOf))
    .sort((a, b) => a.at.localeCompare(b.at));
}

export async function getImportFile(jobId: string, key: string): Promise<ImportFile | undefined> {
  return db.importFiles.get([jobId, key]);
}

export async function dismissJob(id: string): Promise<void> {
  await db.imports.update(id, { dismissed: true });
}

/** A batch's import records, when the batch itself goes (see batches.ts). */
export async function deleteBatchImports(batchId: string): Promise<void> {
  await db.importFiles.where('[batchId+key]').between([batchId, ''], [batchId, '￿']).delete();
  await db.imports.where('batchId').equals(batchId).delete();
}

/** Moves a batch's import records to another batch, when the two are merged (see batches.ts). */
export async function moveBatchImports(fromId: string, toId: string): Promise<void> {
  await db.importFiles.where('[batchId+key]').between([fromId, ''], [fromId, '\uffff']).modify({ batchId: toId });
  await db.imports.where('batchId').equals(fromId).modify({ batchId: toId });
}
