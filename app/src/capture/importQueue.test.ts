import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Printing } from '../games/types';
import type { FileRead, ScanResult } from '../recognize/recognize.worker';
import { createBatch, deleteBatch } from '../session/batches';
import { db } from '../session/db';
import { getImportFile } from '../session/imports';
import type { IntakeOutcome } from '../session/intake';
import { getReviews } from '../session/reviews';
import type { Batch } from '../session/types';
import { filesDone, ImportRunner, wasInterrupted, type ImportDeps, type ImportView } from './importQueue';

const SOL_RING: Printing = { id: 'sol-ring', name: 'Sol Ring', set: 'cmm', setName: 'Commander Masters', number: '410', finishes: ['nonfoil'], lang: 'en' };

/** A photo file: its bytes say what the fake reader finds in it. */
const photo = (name: string, says = 'card', type = 'image/jpeg') => new File([`${says}:${name}`], name, { type });

function scan(decision: 'accept' | 'review'): ScanResult {
  return {
    decision,
    names: ['Sol Ring'],
    printings: [{ printing: SOL_RING, score: 1, title: 1, hashDistance: null, collector: null, sources: ['title'] }],
    nameConfidence: decision === 'accept' ? 0.99 : 0.6,
    confidence: decision === 'accept' ? 0.99 : 0.6,
    titleText: 'Sol Ring',
    collectorText: '',
    card: null,
    timings: {},
    elapsedMs: 1,
    advice: [],
    gaveUp: false,
    guessedOutline: false,
    outsideLock: false,
    trace: [],
    quality: null,
    frame: { width: 100, height: 100 },
  } as unknown as ScanResult;
}

interface Harness {
  runner: ImportRunner;
  reads: string[];
  /** Most reads in flight at once. */
  maxInFlight: () => number;
  awake: boolean[];
  /** Makes the next reads wait until released. */
  hold: () => () => void;
  failFiling: (on: boolean) => void;
}

function harness(overrides: Partial<ImportDeps> = {}): Harness {
  const reads: string[] = [];
  const awake: boolean[] = [];
  let inFlight = 0;
  let most = 0;
  let gate: Promise<void> | null = null;
  let filingFails = false;
  let clock = 0;
  const deps: ImportDeps = {
    async read(file): Promise<FileRead> {
      inFlight++;
      most = Math.max(most, inFlight);
      try {
        if (gate) await gate;
        reads.push(file.name);
        const says = (await file.text()).split(':')[0];
        if (says === 'throw') throw new Error('worker trouble');
        if (says === 'hang') return await new Promise<never>(() => {});
        if (says === 'broken') return { kind: 'unopenable' };
        if (says === 'empty') return { kind: 'no-card', picture: new Blob(['jpeg']), frame: { width: 10, height: 10 }, timings: {} };
        // A binder page: three cards read, two outlines that named nothing.
        if (says === 'page') return { kind: 'cards', results: [scan('accept'), scan('accept'), scan('review')], unread: [new Blob(['a']), new Blob(['b'])], frame: { width: 10, height: 10 }, timings: {} };
        return { kind: 'cards', results: [scan(says === 'unsure' ? 'review' : 'accept')], unread: [], frame: { width: 10, height: 10 }, timings: {} };
      } finally {
        inFlight--;
      }
    },
    batch: (id) => db.batches.get(id),
    async file(batch: Batch, result): Promise<IntakeOutcome> {
      if (filingFails) throw new Error('QuotaExceededError');
      if (result.decision === 'accept') return { kind: 'added', itemId: crypto.randomUUID(), printing: SOL_RING, finish: 'nonfoil' };
      const review = { id: crypto.randomUUID(), batchId: batch.id } as never;
      return { kind: 'review', review };
    },
    keepAwake: (on) => awake.push(on),
    now: () => (clock += 1000),
    ...overrides,
  };
  return {
    runner: new ImportRunner(deps),
    reads,
    maxInFlight: () => most,
    awake,
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((resolve) => (release = resolve));
      return () => {
        gate = null;
        release();
      };
    },
    failFiling: (on) => (filingFails = on),
  };
}

/** Resolves once the runner's view passes the test. */
function until(runner: ImportRunner, test: (view: ImportView) => boolean): Promise<ImportView> {
  return new Promise((resolve) => {
    const check = () => {
      const view = runner.getSnapshot();
      if (view && test(view)) {
        unsubscribe();
        resolve(view);
      }
    };
    const unsubscribe = runner.subscribe(check);
    check();
  });
}

const finished = (runner: ImportRunner) => until(runner, (view) => view.job.state !== 'running' && view.job.state !== 'paused');

let batch: Batch;

beforeEach(async () => {
  await db.delete();
  await db.open();
  batch = await createBatch('Box 3');
});

describe('ImportRunner', () => {
  it('reads every photo once, in order, one at a time, and files each card', async () => {
    const { runner, reads, maxInFlight, awake } = harness();
    await runner.start(batch, [photo('a.jpg'), photo('b.jpg', 'unsure'), photo('c.jpg')]);
    const view = await finished(runner);
    expect(reads).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(maxInFlight()).toBe(1);
    expect(view.job.state).toBe('done');
    expect(view.job.photos).toEqual({ added: 2, review: 1, failed: 0, skipped: 0 });
    expect(view.job.cards).toEqual({ added: 2, review: 1 });
    expect(view.last).toEqual({ name: 'Sol Ring', code: 'CMM 410', kind: 'added' });
    expect(awake.at(0)).toBe(true);
    expect(awake.at(-1)).toBe(false);
    // Saved as it went.
    const stored = await db.imports.get(view.job.id);
    expect(stored?.state).toBe('done');
    expect(await db.importFiles.where('jobId').equals(view.job.id).count()).toBe(3);
  });

  it('lists the photos that give no card, with why, and never drops one', async () => {
    const { runner } = harness();
    await runner.start(batch, [photo('notes.txt', 'card', 'text/plain'), photo('broken.heic', 'broken', ''), photo('table.jpg', 'empty'), photo('odd.jpg', 'throw'), photo('ok.jpg')]);
    const view = await finished(runner);
    expect(view.job.photos).toEqual({ added: 1, review: 0, failed: 4, skipped: 0 });
    expect(view.failures.map(({ name, failure, canRetry, canReview }) => ({ name, failure, canRetry, canReview }))).toEqual([
      { name: 'notes.txt', failure: 'not-image', canRetry: false, canReview: false },
      { name: 'broken.heic', failure: 'unopenable', canRetry: false, canReview: false },
      { name: 'table.jpg', failure: 'no-card', canRetry: false, canReview: true },
      { name: 'odd.jpg', failure: 'error', canRetry: true, canReview: false },
    ]);
    expect(filesDone(view.job)).toBe(view.job.total);
  });

  it('reads a failed photo again on Retry', async () => {
    let fail = true;
    const { runner } = harness({
      read: async () => {
        if (fail) {
          fail = false;
          throw new Error('worker trouble');
        }
        return { kind: 'cards', results: [scan('accept')], unread: [], frame: { width: 1, height: 1 }, timings: {} };
      },
    });
    await runner.start(batch, [photo('a.jpg')]);
    let view = await finished(runner);
    expect(view.failures).toHaveLength(1);
    runner.retry(view.failures[0]!.key);
    view = await until(runner, (v) => v.job.state === 'done' && v.job.photos.added === 1);
    expect(view.failures).toHaveLength(0);
    expect(view.job.photos.failed).toBe(0);
  });

  it('gives up on a read that hangs, and moves on', async () => {
    const { runner } = harness({ timeoutMs: 20 });
    await runner.start(batch, [photo('stuck.jpg', 'hang'), photo('next.jpg')]);
    const view = await finished(runner);
    expect(view.failures.map((failure) => failure.failure)).toEqual(['error']);
    expect(view.job.photos.added).toBe(1);
  });

  it('sends a photo with no card to review anyway, with its picture', async () => {
    const { runner } = harness();
    await runner.start(batch, [photo('table.jpg', 'empty')]);
    let view = await finished(runner);
    expect(await runner.reviewAnyway(view.failures[0]!.key)).toBe(true);
    view = runner.getSnapshot()!;
    expect(view.failures).toHaveLength(0);
    expect(view.job.photos).toEqual({ added: 0, review: 1, failed: 0, skipped: 0 });
    expect(view.job.cards.review).toBe(1);
    const [review] = await getReviews(batch.id);
    expect(review).toMatchObject({ source: 'file', reason: 'unreadable', names: [] });
    expect(review!.crop?.byteLength).toBeGreaterThan(0);
    const record = await getImportFile(view.job.id, (await db.importFiles.toArray())[0]!.key);
    expect(record).toMatchObject({ status: 'review', reviewIds: [review!.id] });
    expect(record?.picture).toBeUndefined();
  });

  it('files every card of a photo of several, and lists the outlines that named none until sent to review', async () => {
    const { runner } = harness();
    await runner.start(batch, [photo('page-1.jpg', 'page')]);
    let view = await finished(runner);
    expect(view.job.photos).toEqual({ added: 0, review: 1, failed: 0, skipped: 0 });
    expect(view.job.cards).toEqual({ added: 2, review: 1, unread: 2 });
    expect(view.failures).toEqual([{ key: expect.any(String), name: 'page-1.jpg', failure: 'unread', canRetry: false, canReview: true, count: 2 }]);

    // Listed again after a reload.
    const after = harness();
    await after.runner.restore();
    expect(after.runner.getSnapshot()!.failures).toMatchObject([{ failure: 'unread', count: 2 }]);

    expect(await runner.reviewAnyway(view.failures[0]!.key)).toBe(true);
    view = runner.getSnapshot()!;
    expect(view.failures).toEqual([]);
    expect(view.job.cards).toEqual({ added: 2, review: 3, unread: 0 });
    expect(await getReviews(batch.id)).toHaveLength(2);
    const record = (await db.importFiles.toArray())[0]!;
    expect(record.unread).toBeUndefined();
    expect(record.reviewIds).toHaveLength(3);
  });

  it('skips photos already read into the batch, and the same photo picked twice, until asked to read them again', async () => {
    const first = harness();
    await first.runner.start(batch, [photo('a.jpg'), photo('b.jpg')]);
    await finished(first.runner);

    const second = harness();
    // a.jpg again, c.jpg twice.
    await second.runner.start(batch, [photo('a.jpg'), photo('c.jpg'), photo('c.jpg')]);
    let view = await finished(second.runner);
    expect(second.reads).toEqual(['c.jpg']);
    expect(view.job.photos).toEqual({ added: 1, review: 0, failed: 0, skipped: 2 });
    expect(view.skippedAtHand).toBe(2);

    second.runner.readSkippedAgain();
    view = await until(second.runner, (v) => v.job.state === 'done' && v.job.photos.skipped === 0);
    expect(second.reads).toEqual(['c.jpg', 'a.jpg', 'c.jpg']);
    expect(view.job.photos).toEqual({ added: 3, review: 0, failed: 0, skipped: 0 });
  });

  it('reads photos again into another batch', async () => {
    const first = harness();
    await first.runner.start(batch, [photo('a.jpg')]);
    await finished(first.runner);
    const other = await createBatch('Box 4');
    const second = harness();
    await second.runner.start(other, [photo('a.jpg')]);
    expect((await finished(second.runner)).job.photos.added).toBe(1);
  });

  it('counts a failed photo as not read: picking it again reads it', async () => {
    const first = harness();
    await first.runner.start(batch, [photo('odd.jpg', 'throw')]);
    await finished(first.runner);
    const second = harness({ read: async () => ({ kind: 'cards', results: [scan('accept')], unread: [], frame: { width: 1, height: 1 }, timings: {} }) });
    await second.runner.start(batch, [photo('odd.jpg', 'throw')]);
    expect((await finished(second.runner)).job.photos).toMatchObject({ added: 1, skipped: 0 });
  });

  it('pauses after the photo being read, and carries on where it left off', async () => {
    const { runner, reads, hold, awake } = harness();
    const release = hold();
    await runner.start(batch, [photo('a.jpg'), photo('b.jpg'), photo('c.jpg')]);
    runner.pause();
    expect(runner.getSnapshot()!.job.state).toBe('paused');
    release();
    await until(runner, (view) => view.job.photos.added === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toEqual(['a.jpg']);
    expect(awake.at(-1)).toBe(false);
    expect((await db.imports.toArray())[0]!.state).toBe('paused');

    runner.resume();
    const view = await finished(runner);
    expect(reads).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(view.job.state).toBe('done');
  });

  it('cancels after the photo being read, keeping the cards read so far', async () => {
    const { runner, reads, hold } = harness();
    const release = hold();
    await runner.start(batch, [photo('a.jpg'), photo('b.jpg'), photo('c.jpg')]);
    runner.cancel();
    release();
    const view = await finished(runner);
    expect(view.job.state).toBe('cancelled');
    expect(reads).toEqual(['a.jpg']);
    expect(view.job.photos.added).toBe(1);
    expect(view.job.total).toBe(3);
  });

  it('cancels a paused import', async () => {
    const { runner, hold } = harness();
    const release = hold();
    await runner.start(batch, [photo('a.jpg'), photo('b.jpg')]);
    runner.pause();
    release();
    await until(runner, (view) => view.job.photos.added === 1);
    runner.cancel();
    expect((await finished(runner)).job.state).toBe('cancelled');
  });

  it('adds photos picked while it runs to the same import, and refuses another batch meanwhile', async () => {
    const { runner, reads, hold } = harness();
    const release = hold();
    await runner.start(batch, [photo('a.jpg')]);
    await runner.start(batch, [photo('b.jpg'), photo('c.jpg')]);
    expect(runner.getSnapshot()!.job.total).toBe(3);
    const other = await createBatch('Box 4');
    await expect(runner.start(other, [photo('d.jpg')])).rejects.toThrow('Another import');
    release();
    const view = await finished(runner);
    expect(reads).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(view.job.photos.added).toBe(3);
  });

  it('stops when its batch is deleted', async () => {
    const { runner, hold } = harness();
    const release = hold();
    await runner.start(batch, [photo('a.jpg'), photo('b.jpg')]);
    await deleteBatch(batch.id);
    release();
    const view = await finished(runner);
    expect(view.job).toMatchObject({ state: 'stopped', why: 'batch-gone' });
  });

  it('pauses when saving fails, and tries the same photo again on Resume', async () => {
    const h = harness();
    h.failFiling(true);
    await h.runner.start(batch, [photo('a.jpg'), photo('b.jpg')]);
    let view = await until(h.runner, (v) => v.saveFailed);
    expect(view.job.state).toBe('paused');
    h.failFiling(false);
    h.runner.resume();
    view = await finished(h.runner);
    expect(view.saveFailed).toBe(false);
    expect(view.job.photos.added).toBe(2);
    expect(h.reads).toEqual(['a.jpg', 'a.jpg', 'b.jpg']);
  });

  it('after a reload, says what finished and lists the photos that gave no card', async () => {
    const before = harness();
    const release = before.hold();
    await before.runner.start(batch, [photo('a.jpg'), photo('table.jpg', 'empty'), photo('c.jpg'), photo('d.jpg')]);
    release();
    await until(before.runner, (view) => filesDone(view.job) === 2);
    before.runner.pause();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The page reloads: a new runner, the same database.
    const after = harness();
    await after.runner.restore();
    const view = after.runner.getSnapshot()!;
    expect(wasInterrupted(view)).toBe(true);
    expect(view.job.total).toBe(4);
    expect(filesDone(view.job)).toBe(2);
    expect(view.pending).toBe(2);
    expect(view.failures).toEqual([{ key: expect.any(String), name: 'table.jpg', failure: 'no-card', canRetry: false, canReview: true }]);
    expect(await after.runner.reviewAnyway(view.failures[0]!.key)).toBe(true);

    // Picking the same photos again reads only the rest.
    await after.runner.start(batch, [photo('a.jpg'), photo('table.jpg', 'empty'), photo('c.jpg'), photo('d.jpg')]);
    const resumed = await finished(after.runner);
    expect(after.reads).toEqual(['c.jpg', 'd.jpg']);
    expect(resumed.job.photos).toEqual({ added: 2, review: 0, failed: 0, skipped: 2 });
    // The cut-short job is closed.
    expect((await db.imports.get(view.job.id))?.dismissed).toBe(true);
  });

  it('keeps a finished summary across a reload until it is closed', async () => {
    const before = harness();
    await before.runner.start(batch, [photo('a.jpg')]);
    await finished(before.runner);
    const after = harness();
    await after.runner.restore();
    const view = after.runner.getSnapshot()!;
    expect(view.job.state).toBe('done');
    expect(wasInterrupted(view)).toBe(false);
    await after.runner.dismiss();
    expect(after.runner.getSnapshot()).toBeNull();
    const again = harness();
    await again.runner.restore();
    expect(again.runner.getSnapshot()).toBeNull();
  });

  it('works out a rate and the time left', async () => {
    const { runner, hold } = harness();
    const release = hold();
    await runner.start(batch, Array.from({ length: 6 }, (_, i) => photo(`${i}.jpg`)));
    release();
    const view = await until(runner, (v) => filesDone(v.job) === 4);
    // The fake clock ticks a second per call: a few calls per photo.
    expect(view.perMinute).toBeGreaterThan(0);
    expect(view.remainingMs).toBeGreaterThan(0);
    await finished(runner);
  });
});
