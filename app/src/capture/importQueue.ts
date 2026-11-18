/**
 * Bulk import: many photos (a folder, the iPhone's photo picker, a document
 * scanner's pages) read one at a time by the recognition worker, each card
 * filed like a scanned one: added when the recognizer is sure, else queued
 * for review. A file that gives no card is listed, never dropped.
 *
 * One import runs at a time, in this module rather than a component, so that
 * leaving the Scan tab doesn't stop it. Files go to the worker one by one and
 * are opened there, so the page never holds more than one picture however
 * many were picked. What became of each file is saved as it goes (see
 * session/imports.ts): after a reload, the same photos can be picked again
 * and the ones already read are skipped.
 */
import type { FileRead, ScanResult } from '../recognize/recognize.worker';
import { printingCode, shownName } from '../review/explain';
import {
  dismissJob,
  emptyCounts,
  getImportFile,
  jobFailures,
  keysAlreadyRead,
  latestOpenJob,
  saveFile,
  saveJob,
  type ImportFailure,
  type ImportFile,
  type ImportJob,
} from '../session/imports';
import type { IntakeOutcome } from '../session/intake';
import { changeQuantity } from '../session/batches';
import { discardReview, queueReview } from '../session/reviews';
import type { Batch } from '../session/types';
import { fileKey, isImageFile } from './importFiles';

/** A read that takes longer than this has gone wrong: the file is listed as failed and the import moves on. */
export const READ_TIMEOUT_MS = 120_000;
/** Reads the rate is worked out over. */
const RATE_WINDOW = 20;

export interface ImportDeps {
  /** Reads one file in the recognition worker. */
  read(file: File, batch: Batch): Promise<FileRead>;
  /** The batch as it is now (its settings may have changed), or undefined once it's gone. */
  batch(id: string): Promise<Batch | undefined>;
  /** Files a card: into the batch or the review queue (session/intake.ts). */
  file(batch: Batch, scan: ScanResult, timings: Record<string, number>): Promise<IntakeOutcome>;
  /** Keeps the screen on while the import runs. */
  keepAwake(on: boolean): void;
  now(): number;
  key?(file: File): Promise<string>;
  /** READ_TIMEOUT_MS unless given (tests). */
  timeoutMs?: number;
}

export interface ImportFailureView {
  key: string;
  name: string;
  failure: ImportFailure;
  /** The file was picked in this page and the failure wasn't the file's fault, so reading it again may work. */
  canRetry: boolean;
  /** There's a picture of the photo to send to review. */
  canReview: boolean;
  /** For `unread`: how many outlines in the photo named no card; for `repeat`: how many cards it shares. */
  count?: number;
  /** For `repeat`: the earlier photo with the same cards. */
  other?: string;
}

/** A photo's list entry, from what was saved about it (after a reload). */
function listedFrom(file: ImportFile): ImportFailureView {
  if (file.status === 'failed') return { key: file.key, name: file.name, failure: file.failure ?? 'error', canRetry: false, canReview: Boolean(file.picture) };
  if (file.repeatOf) return { key: file.key, name: file.name, failure: 'repeat', canRetry: false, canReview: false, count: file.repeatOf.shared, other: file.repeatOf.name };
  return { key: file.key, name: file.name, failure: 'unread', canRetry: false, canReview: true, count: file.unread?.length ?? 0 };
}

/** Cards two photos share (by name, a copy counted once per photo it's in). */
export function sharedCards(a: readonly string[], b: readonly string[]): number {
  const left = new Map<string, number>();
  for (const name of a) left.set(name, (left.get(name) ?? 0) + 1);
  let shared = 0;
  for (const name of b) {
    const count = left.get(name) ?? 0;
    if (count > 0) {
      shared++;
      left.set(name, count - 1);
    }
  }
  return shared;
}

/** A photo of several sharing at least this many cards, and this share of its cards, with an earlier one is probably the same page again. */
const REPEAT_SHARED = 3;
const REPEAT_SHARE = 0.6;

export interface ImportView {
  job: ImportJob;
  /** This page is working on it; false for a job that a reload cut short, or one finished before it. */
  live: boolean;
  /** The file being read. */
  current: string | null;
  /** Files still to read, the one being read included. */
  pending: number;
  /** The card read last. */
  last: { name: string | null; code: string | null; kind: 'added' | 'review' } | null;
  /** Photos a minute, lately; null until there have been a few. */
  perMinute: number | null;
  remainingMs: number | null;
  failures: ImportFailureView[];
  /** Files skipped as read before that this page still has, for "Read them again". */
  skippedAtHand: number;
  /** Saving failed (storage full?): the import paused, and resuming tries the same file again. */
  saveFailed: boolean;
}

/** Files read so far, whatever became of them. */
export const filesDone = (job: Pick<ImportJob, 'photos'>) => job.photos.added + job.photos.review + job.photos.failed + job.photos.skipped;

/** A job that a reload (or a closed tab) cut short. */
export const wasInterrupted = (view: ImportView) => !view.live && (view.job.state === 'running' || view.job.state === 'paused');

interface Entry {
  file: File;
  /** Read even if it was read into this batch before. */
  force: boolean;
  key?: Promise<string>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

export class ImportRunner {
  private view: ImportView | null = null;
  private readonly listeners = new Set<() => void>();
  private queue: Entry[] = [];
  private looping = false;
  private paused = false;
  private cancelled = false;
  private wake: (() => void) | null = null;
  /** Failed files picked in this page, by key, for Retry. */
  private atHand = new Map<string, File>();
  private skipped: File[] = [];
  /** Keys read in this job: the same photo picked twice is read once. */
  private seen = new Set<string>();
  private readTimes: number[] = [];
  /** Photos of several cards read in this job, and the cards in them, for spotting the same page twice. */
  private pages: { name: string; cards: string[] }[] = [];
  private restored: Promise<void> | null = null;

  constructor(private readonly deps: ImportDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ImportView | null => this.view;

  private set(changes: Partial<ImportView>): void {
    if (!this.view) return;
    const job = changes.job ?? this.view.job;
    const pending = changes.pending ?? this.view.pending;
    this.view = { ...this.view, ...changes, job, pending, remainingMs: this.remaining(pending, changes.perMinute ?? this.view.perMinute) };
    for (const listener of this.listeners) listener();
  }

  private remaining(pending: number, perMinute: number | null): number | null {
    return perMinute && pending > 0 ? (pending / perMinute) * 60_000 : null;
  }

  private job(changes: Partial<ImportJob>): ImportJob {
    return { ...this.view!.job, ...changes, updatedAt: new Date(this.deps.now()).toISOString() };
  }

  private key(file: File): Promise<string> {
    return (this.deps.key ?? fileKey)(file);
  }

  /** Shows the job a reload cut short, or the last summary not yet closed. Once per page. */
  restore(): Promise<void> {
    this.restored ??= (async () => {
      const job = await latestOpenJob().catch(() => undefined);
      if (!job || this.view) return;
      const failures = await jobFailures(job.id).catch(() => [] as ImportFile[]);
      const open = job.state === 'running' || job.state === 'paused';
      this.view = {
        job,
        live: false,
        current: null,
        pending: open ? Math.max(0, job.total - filesDone(job)) : 0,
        last: null,
        perMinute: null,
        remainingMs: null,
        failures: failures.map(listedFrom),
        skippedAtHand: 0,
        saveFailed: false,
      };
      for (const listener of this.listeners) listener();
    })();
    return this.restored;
  }

  /** True while an import in this page has files left (running or paused). */
  get active(): boolean {
    const view = this.view;
    return Boolean(view?.live && (view.job.state === 'running' || view.job.state === 'paused'));
  }

  /**
   * Imports these files into the batch. Added to the import already running
   * into the same batch, if there is one; another batch's running import has
   * to finish or be cancelled first.
   */
  async start(batch: Batch, files: readonly File[]): Promise<void> {
    await this.restore();
    if (files.length === 0) return;
    const entries = files.map((file): Entry => ({ file, force: false }));
    const view = this.view;
    if (this.active && view) {
      if (view.job.batchId !== batch.id) throw new Error('Another import is still running');
      this.queue.push(...entries);
      const job = this.job({ total: view.job.total + files.length });
      this.set({ job, pending: view.pending + files.length });
      await saveJob(job);
      return;
    }
    // A summary on screen, or a job a reload cut short, gives way to the new import. Its files still count as read.
    if (view && !view.job.dismissed) await dismissJob(view.job.id).catch(() => {});
    const now = new Date(this.deps.now()).toISOString();
    const job: ImportJob = { id: crypto.randomUUID(), batchId: batch.id, createdAt: now, updatedAt: now, state: 'running', total: files.length, ...emptyCounts() };
    this.queue = entries;
    this.paused = false;
    this.cancelled = false;
    this.atHand = new Map();
    this.skipped = [];
    this.seen = new Set();
    this.readTimes = [];
    this.pages = [];
    this.view = {
      job,
      live: true,
      current: null,
      pending: files.length,
      last: null,
      perMinute: null,
      remainingMs: null,
      failures: [],
      skippedAtHand: 0,
      saveFailed: false,
    };
    for (const listener of this.listeners) listener();
    await saveJob(job);
    void this.run();
  }

  pause(): void {
    if (!this.active || this.paused) return;
    this.paused = true;
    const job = this.job({ state: 'paused' });
    this.set({ job });
    void saveJob(job).catch(() => {});
  }

  resume(): void {
    if (!this.view?.live || this.view.job.state !== 'paused') return;
    this.paused = false;
    const job = this.job({ state: 'running' });
    this.set({ job, saveFailed: false });
    void saveJob(job).catch(() => {});
    if (this.wake) this.wake();
    else void this.run();
  }

  /** Stops after the file being read. The cards read so far stay where they were filed. */
  cancel(): void {
    if (!this.active) return;
    this.cancelled = true;
    this.queue = [];
    if (this.wake) this.wake();
  }

  /** Closes a finished import's summary (or forgets one a reload cut short). */
  async dismiss(): Promise<void> {
    const view = this.view;
    if (!view || this.active) return;
    this.view = null;
    this.atHand = new Map();
    this.skipped = [];
    for (const listener of this.listeners) listener();
    await dismissJob(view.job.id).catch(() => {});
  }

  /** Reads a failed file again. */
  retry(key: string): void {
    const view = this.view;
    const file = this.atHand.get(key);
    if (!view?.live || !file) return;
    this.atHand.delete(key);
    const job = this.job({ photos: { ...view.job.photos, failed: view.job.photos.failed - 1 } });
    this.queue.unshift({ file, force: true });
    this.set({ job, failures: view.failures.filter((failure) => failure.key !== key), pending: view.pending + 1 });
    this.continue();
  }

  /** Reads the files skipped as read before, again. */
  readSkippedAgain(): void {
    const view = this.view;
    if (!view?.live || this.skipped.length === 0) return;
    const files = this.skipped;
    this.skipped = [];
    const job = this.job({ photos: { ...view.job.photos, skipped: view.job.photos.skipped - files.length } });
    this.queue.push(...files.map((file) => ({ file, force: true })));
    this.set({ job, skippedAtHand: 0, pending: view.pending + files.length });
    this.continue();
  }

  /** Starts the loop again for a file put back in the queue, if it had finished. */
  private continue(): void {
    if (this.looping || this.paused) return;
    this.cancelled = false;
    const job = this.job({ state: 'running' });
    this.set({ job });
    void saveJob(job).catch(() => {});
    void this.run();
  }

  /** An unreadable card in the review queue, with a picture of it, to be named by search. */
  private async unreadableReview(batch: Batch, crop: ArrayBuffer) {
    return queueReview({
      batchId: batch.id,
      source: 'file',
      crop,
      names: [],
      candidates: [],
      nameConfidence: 0,
      confidence: 0,
      titleText: '',
      collectorText: '',
      advice: [],
      reason: 'unreadable',
      lockSets: batch.settings.lockSets ?? [],
      foil: batch.settings.foil === true,
      lang: batch.settings.defaultLang,
      condition: batch.settings.defaultCondition,
      qty: 1,
    });
  }

  /**
   * Sends a listed photo to the review queue anyway: a photo with no card
   * found, as an unreadable card with a picture of the photo; or, from a photo
   * of several cards, each outline that named no card, with its picture.
   */
  async reviewAnyway(key: string): Promise<boolean> {
    const view = this.view;
    if (!view) return false;
    const record = await getImportFile(view.job.id, key);
    const batch = await this.deps.batch(view.job.batchId);
    if (!record || !batch) return false;
    const pictures = record.status === 'failed' ? (record.picture ? [record.picture] : []) : (record.unread ?? []);
    if (pictures.length === 0) return false;
    const reviewIds: string[] = [];
    for (const picture of pictures) reviewIds.push((await this.unreadableReview(batch, picture)).id);
    const now = this.view;
    if (!now || now.job.id !== view.job.id) return true;
    const photos = { ...now.job.photos, review: now.job.photos.review + (record.status === 'review' ? 0 : 1) };
    if (record.status === 'failed') photos.failed -= 1;
    if (record.status === 'added') photos.added -= 1;
    const cards = { ...now.job.cards, review: now.job.cards.review + reviewIds.length };
    if (record.status !== 'failed') cards.unread = Math.max(0, (cards.unread ?? 0) - reviewIds.length);
    const job = this.job({ photos, cards });
    const { picture: _picture, failure: _failure, unread: _unread, ...rest } = record;
    await saveFile(job, { ...rest, status: 'review', reviewIds: [...(record.reviewIds ?? []), ...reviewIds], at: new Date(this.deps.now()).toISOString() });
    this.atHand.delete(key);
    this.set({ job, failures: now.failures.filter((failure) => failure.key !== key) });
    return true;
  }

  /** A repeated page: takes its cards back out of the batch and the review queue. */
  async takeOut(key: string): Promise<boolean> {
    const view = this.view;
    if (!view) return false;
    const record = await getImportFile(view.job.id, key);
    if (!record || record.status === 'failed' || record.takenOut) return false;
    for (const itemId of record.itemIds ?? []) await changeQuantity(itemId, -1);
    for (const reviewId of record.reviewIds ?? []) await discardReview(reviewId);
    const now = this.view;
    if (!now || now.job.id !== view.job.id) return true;
    const status = record.status;
    const job = this.job({
      photos: { ...now.job.photos, [status]: now.job.photos[status] - 1, skipped: now.job.photos.skipped + 1 },
      cards: {
        added: now.job.cards.added - (record.itemIds?.length ?? 0),
        review: now.job.cards.review - (record.reviewIds?.length ?? 0),
        ...(now.job.cards.unread !== undefined ? { unread: Math.max(0, now.job.cards.unread - (record.unread?.length ?? 0)) } : {}),
      },
    });
    const { unread: _unread, repeatOf: _repeatOf, ...rest } = record;
    await saveFile(job, { ...rest, takenOut: true, at: new Date(this.deps.now()).toISOString() });
    this.set({ job, failures: now.failures.filter((failure) => failure.key !== key) });
    return true;
  }

  /** A repeated page whose cards really are other copies: keeps them, and lists its unread outlines if it has any. */
  async keepRepeat(key: string): Promise<boolean> {
    const view = this.view;
    if (!view) return false;
    const record = await getImportFile(view.job.id, key);
    if (!record?.repeatOf) return false;
    const { repeatOf: _repeatOf, ...rest } = record;
    await saveFile(this.view?.job ?? view.job, rest);
    const now = this.view;
    if (!now || now.job.id !== view.job.id) return true;
    const others = now.failures.filter((failure) => failure.key !== key);
    this.set({ failures: rest.unread?.length ? [...others, listedFrom(rest)] : others });
    return true;
  }

  /** "Review them anyway" for every listed photo that has a picture. */
  async reviewAllAnyway(): Promise<number> {
    let count = 0;
    for (const failure of this.view?.failures.filter((entry) => entry.canReview) ?? []) {
      if (await this.reviewAnyway(failure.key)) count++;
    }
    return count;
  }

  private async run(): Promise<void> {
    if (this.looping) return;
    this.looping = true;
    this.deps.keepAwake(true);
    let stopped = false;
    try {
      while (this.queue.length > 0 && !this.cancelled) {
        if (this.paused) {
          this.deps.keepAwake(false);
          await new Promise<void>((resolve) => (this.wake = resolve));
          this.wake = null;
          this.deps.keepAwake(true);
          continue;
        }
        const entry = this.queue.shift()!;
        // The next file's key is worked out while this one is read.
        const next = this.queue[0];
        if (next) next.key ??= this.key(next.file);
        try {
          if (await this.readOne(entry)) {
            stopped = true;
            break;
          }
        } catch {
          // Saving failed: storage full or blocked. Pause, and try the same file again on Resume
          // (forced: it was marked as seen before it was read).
          this.queue.unshift({ ...entry, force: true });
          this.paused = true;
          this.set({ job: this.job({ state: 'paused' }), current: null, saveFailed: true, pending: this.queue.length });
        }
      }
    } finally {
      this.looping = false;
      this.deps.keepAwake(false);
    }
    if (!this.view?.live || stopped) return;
    if (this.queue.length > 0 && this.paused) return;
    const job = this.job({ state: this.cancelled ? 'cancelled' : 'done' });
    this.set({ job, current: null, pending: 0 });
    await saveJob(job).catch(() => {});
  }

  /** Reads one file and saves what became of it. True when the import has to stop. */
  private async readOne(entry: Entry): Promise<boolean> {
    const view = this.view!;
    const batch = await this.deps.batch(view.job.batchId);
    if (!batch) {
      this.queue = [];
      const job = this.job({ state: 'stopped', why: 'batch-gone' });
      this.set({ job, current: null, pending: 0 });
      await saveJob(job).catch(() => {});
      return true;
    }
    const { file } = entry;
    this.set({ current: file.name, pending: this.queue.length + 1 });
    const key = await (entry.key ?? this.key(file));
    if (!isImageFile(file)) {
      await this.fail(file, key, 'not-image');
      return false;
    }
    if (!entry.force && (this.seen.has(key) || (await keysAlreadyRead(batch.id, [key])).has(key))) {
      this.skipped.push(file);
      const now = this.view!;
      const job = this.job({ photos: { ...now.job.photos, skipped: now.job.photos.skipped + 1 } });
      this.set({ job, skippedAtHand: this.skipped.length, pending: this.queue.length });
      await saveJob(job);
      return false;
    }
    this.seen.add(key);

    let read: FileRead;
    try {
      read = await withTimeout(this.deps.read(file, batch), this.deps.timeoutMs ?? READ_TIMEOUT_MS);
    } catch {
      await this.fail(file, key, 'error');
      return false;
    }
    if (read.kind === 'unopenable') {
      await this.fail(file, key, 'unopenable');
      return false;
    }
    if (read.kind === 'no-card') {
      const picture = read.picture ? await read.picture.arrayBuffer().catch(() => undefined) : undefined;
      await this.fail(file, key, 'no-card', picture);
      return false;
    }

    const itemIds: string[] = [];
    const reviewIds: string[] = [];
    let last: ImportView['last'] = null;
    for (const result of read.results) {
      const outcome = await this.deps.file(batch, result, read.timings);
      if (outcome.kind === 'added') {
        itemIds.push(outcome.itemId);
        last = { name: shownName(outcome.printing), code: printingCode(outcome.printing), kind: 'added' };
      } else {
        reviewIds.push(outcome.review.id);
        const best = result.printings[0]?.printing;
        last = { name: result.names[0] ?? null, code: best ? printingCode(best) : null, kind: 'review' };
      }
    }
    const status = reviewIds.length > 0 ? 'review' : 'added';
    // A photo of several cards with mostly the cards of an earlier one: the same page twice?
    const names = read.results.map((result) => result.names[0]).filter((name): name is string => Boolean(name));
    let repeatOf: ImportFile['repeatOf'];
    if (names.length >= 2) {
      for (const page of this.pages) {
        const shared = sharedCards(page.cards, names);
        if (shared >= REPEAT_SHARED && shared >= REPEAT_SHARE * Math.max(page.cards.length, names.length) && shared > (repeatOf?.shared ?? 0)) {
          repeatOf = { name: page.name, shared };
        }
      }
      this.pages.push({ name: file.name, cards: names });
    }
    const unread = (await Promise.all(read.unread.map((picture) => picture.arrayBuffer().catch(() => null)))).filter((bytes): bytes is ArrayBuffer => bytes !== null);
    const now = this.view!;
    const job = this.job({
      photos: { ...now.job.photos, [status]: now.job.photos[status] + 1 },
      cards: {
        added: now.job.cards.added + itemIds.length,
        review: now.job.cards.review + reviewIds.length,
        ...(unread.length || now.job.cards.unread ? { unread: (now.job.cards.unread ?? 0) + unread.length } : {}),
      },
    });
    await saveFile(job, {
      jobId: job.id,
      key,
      batchId: batch.id,
      name: file.name,
      size: file.size,
      status,
      ...(itemIds.length ? { itemIds } : {}),
      ...(reviewIds.length ? { reviewIds } : {}),
      ...(unread.length ? { unread } : {}),
      ...(repeatOf ? { repeatOf } : {}),
      at: new Date(this.deps.now()).toISOString(),
    });
    // A repeated page is listed as that (its unread outlines come back if its cards are kept).
    const listed: ImportFailureView[] = repeatOf
      ? [{ key, name: file.name, failure: 'repeat', canRetry: false, canReview: false, count: repeatOf.shared, other: repeatOf.name }]
      : unread.length
        ? [{ key, name: file.name, failure: 'unread', canRetry: false, canReview: true, count: unread.length }]
        : [];
    this.set({ job, last, pending: this.queue.length, ...(listed.length ? { failures: [...now.failures, ...listed] } : {}), ...this.timed() });
    return false;
  }

  private async fail(file: File, key: string, failure: ImportFailure, picture?: ArrayBuffer): Promise<void> {
    const now = this.view!;
    const job = this.job({ photos: { ...now.job.photos, failed: now.job.photos.failed + 1 } });
    await saveFile(job, {
      jobId: job.id,
      key,
      batchId: job.batchId,
      name: file.name,
      size: file.size,
      status: 'failed',
      failure,
      ...(picture ? { picture } : {}),
      at: new Date(this.deps.now()).toISOString(),
    });
    const canRetry = failure === 'error';
    if (canRetry) this.atHand.set(key, file);
    const entry: ImportFailureView = { key, name: file.name, failure, canRetry, canReview: Boolean(picture) };
    this.set({ job, failures: [...now.failures.filter((other) => other.key !== key), entry], pending: this.queue.length, ...(failure === 'not-image' ? {} : this.timed()) });
  }

  /** Notes a read's time and works out the rate from the last few. */
  private timed(): Pick<ImportView, 'perMinute'> {
    this.readTimes.push(this.deps.now());
    if (this.readTimes.length > RATE_WINDOW) this.readTimes.shift();
    const times = this.readTimes;
    if (times.length < 3) return { perMinute: null };
    const span = times[times.length - 1]! - times[0]!;
    return { perMinute: span > 0 ? ((times.length - 1) / span) * 60_000 : null };
  }
}
