import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBatch, deleteBatch, mergeBatches } from './batches';
import { db } from './db';
import { emptyCounts, keysAlreadyRead, latestOpenJob, saveFile, saveJob, type ImportFile, type ImportJob } from './imports';

const job = (id: string, batchId: string, createdAt = '2026-11-17T10:00:00Z'): ImportJob => ({
  id,
  batchId,
  createdAt,
  updatedAt: createdAt,
  state: 'running',
  total: 2,
  ...emptyCounts(),
});

const file = (jobId: string, batchId: string, key: string, status: ImportFile['status']): ImportFile => ({
  jobId,
  key,
  batchId,
  name: `${key}.jpg`,
  size: 1,
  status,
  at: '2026-11-17T10:00:00Z',
});

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('import records', () => {
  it('counts a photo as read into a batch once a card from it was added or queued, not when it failed', async () => {
    const box = await createBatch('Box');
    await saveJob(job('j1', box.id));
    await saveFile(job('j1', box.id), file('j1', box.id, 'k1', 'added'));
    await saveFile(job('j1', box.id), file('j1', box.id, 'k2', 'review'));
    await saveFile(job('j1', box.id), file('j1', box.id, 'k3', 'failed'));
    expect(await keysAlreadyRead(box.id, ['k1', 'k2', 'k3', 'k4'])).toEqual(new Set(['k1', 'k2']));
    expect(await keysAlreadyRead('other', ['k1'])).toEqual(new Set());
  });

  it('finds the newest job whose summary is still open', async () => {
    const box = await createBatch('Box');
    await saveJob(job('old', box.id, '2026-11-17T09:00:00Z'));
    await saveJob({ ...job('new', box.id, '2026-11-17T11:00:00Z'), dismissed: true });
    expect((await latestOpenJob())?.id).toBe('old');
  });

  it('goes with its batch when the batch is deleted', async () => {
    const box = await createBatch('Box');
    const keep = await createBatch('Keep');
    await saveFile(job('j1', box.id), file('j1', box.id, 'k1', 'added'));
    await saveFile(job('j2', keep.id), file('j2', keep.id, 'k1', 'added'));
    await deleteBatch(box.id);
    expect(await db.imports.count()).toBe(1);
    expect(await db.importFiles.count()).toBe(1);
    expect(await keysAlreadyRead(keep.id, ['k1'])).toEqual(new Set(['k1']));
  });

  it('moves to the batch it is merged into', async () => {
    const from = await createBatch('From');
    const into = await createBatch('Into');
    await saveFile(job('j1', from.id), file('j1', from.id, 'k1', 'added'));
    await mergeBatches(from.id, into.id);
    expect(await keysAlreadyRead(into.id, ['k1'])).toEqual(new Set(['k1']));
    expect((await db.imports.get('j1'))?.batchId).toBe(into.id);
  });
});
