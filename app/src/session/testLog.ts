/**
 * The test log: one entry per live or photo read, and the user's follow-ups
 * (a review resolved, an Undo, a printing changed), so a phone test can be
 * sent as one file instead of screenshots, and its corrections become real
 * scan fixtures (tests/eval/testlog-fixtures.ts). Off unless the user turns it
 * on; it stays in this browser's IndexedDB until they share it. Format:
 * tests/eval/TESTLOG.md.
 */
import { db } from './db';

export const TESTLOG_FORMAT = 'manifest-testlog';
export const TESTLOG_VERSION = 1;
/** Reads kept: older ones, and their follow-ups, are dropped as new ones come in. */
export const TESTLOG_MAX_READS = 300;

export interface TestLogPrinting {
  id: string;
  name: string;
  set: string;
  number: string;
}

export interface TestLogCandidate extends TestLogPrinting {
  score: number;
  /** Title similarity, 0–1. */
  title: number;
  /** Art + card fingerprint distance, of 128 bits; null without one. */
  art: number | null;
  /** How the collector line fitted: score, and number and set verdicts. */
  collector: { number: string; set: string; score: number } | null;
  sources: string[];
}

export type TestLogOutcome =
  | { kind: 'added'; printingId: string; finish: string }
  | { kind: 'review'; reason: string }
  /** The card already counted, read again because it looked different: nothing counted. */
  | { kind: 'same-card'; why: string };

export interface TestLogSettings {
  camera: 720 | 1080;
  flashlight: boolean;
  lockSets: string[];
  foil: boolean;
  lang: string;
  condition: string;
  sound: string;
}

export interface TestLogRead {
  /** The read's id, which follow-up events refer to. */
  id: string;
  kind: 'read';
  /** ISO timestamp. */
  at: string;
  source: 'live' | 'photo';
  build: string;
  userAgent: string;
  settings: TestLogSettings;
  /** The camera frame's or photo's size. */
  frame: { width: number; height: number } | null;
  /** Milliseconds per stage, as the timings readout shows them. */
  timings: Record<string, number>;
  quality: {
    brightness: number;
    noise: number;
    sharpness: number;
    tilt: number;
    /** A light's reflection, as a share of the card (0 when none). */
    glare: number;
    cardWidth: number;
    inFrame: boolean;
    issues: string[];
    advice: string[];
  } | null;
  ocr: { title: string; collector: string };
  /** Which paths recognition took: renderings, fallbacks, searches skipped (see pipeline.ts). */
  trace: string[];
  candidates: TestLogCandidate[];
  nameConfidence: number;
  confidence: number;
  outcome: TestLogOutcome;
  /** The upright card as a small JPEG, when pictures are included. */
  crop?: ArrayBuffer;
}

export type TestLogEventType =
  /** A review resolved as a printing: the ground truth. `via` says how it was found. */
  | 'review-accepted'
  | 'review-discarded'
  /** A thumbnail's Undo: the card was taken back out. */
  | 'undo'
  /** A batch row's printing changed: the ground truth for every read that went into it. */
  | 'printing-changed';

export interface TestLogEvent {
  id: string;
  kind: 'event';
  at: string;
  type: TestLogEventType;
  /** The reads this is about. */
  readIds: string[];
  printing?: TestLogPrinting;
  /** For a printing change, what it was before. */
  from?: TestLogPrinting;
  finish?: string;
  qty?: number;
  /** For an accepted review: `candidate-N` (its rank), `printings` (all printings of a name) or `search`. */
  via?: string;
}

export type TestLogEntry = TestLogRead | TestLogEvent;

/** A printing as the log names it. */
export function logPrinting(printing: { id: string; name: string; set: string; number: string }): TestLogPrinting {
  return { id: printing.id, name: printing.name, set: printing.set, number: printing.number };
}

/** The scan ids that are known, for an event's `readIds`. */
export const knownIds = (...ids: (string | undefined)[]): string[] => ids.filter((id): id is string => Boolean(id));

const ENABLED_KEY = 'manifest-testlog';
const PICTURES_KEY = 'manifest-testlog-pictures';

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the switch lasts until the page closes.
  }
}

// Read on first use, not on import: the fixtures script imports this module in Node.
let enabled: boolean | null = null;
let pictures: boolean | null = null;

export function testLogEnabled(): boolean {
  enabled ??= stored(ENABLED_KEY) === '1';
  return enabled;
}

export function setTestLogEnabled(on: boolean): void {
  enabled = on;
  store(ENABLED_KEY, on ? '1' : null);
}

export function testLogPictures(): boolean {
  pictures ??= stored(PICTURES_KEY) !== '0';
  return pictures;
}

export function setTestLogPictures(on: boolean): void {
  pictures = on;
  store(PICTURES_KEY, on ? null : '0');
}

/** Adds a read and drops the oldest beyond `max`, with every follow-up older than the oldest read kept. */
export async function addTestLogRead(read: TestLogRead, max = TESTLOG_MAX_READS): Promise<void> {
  await db.transaction('rw', db.testlog, async () => {
    await db.testlog.put(read);
    const reads = await db.testlog.where('kind').equals('read').sortBy('at');
    if (reads.length <= max) return;
    const oldestKept = reads[reads.length - max]!.at;
    await db.testlog.where('at').below(oldestKept).delete();
  });
}

export async function addTestLogEvent(event: Omit<TestLogEvent, 'id' | 'kind' | 'at'>): Promise<void> {
  await db.testlog.put({ ...event, id: crypto.randomUUID(), kind: 'event', at: new Date().toISOString() });
}

/** A follow-up, recorded only while the log is on, and never in the way if storage fails. */
export function logEvent(event: Omit<TestLogEvent, 'id' | 'kind' | 'at'>): void {
  if (!testLogEnabled() || event.readIds.length === 0) return;
  void addTestLogEvent(event).catch(() => {});
}

export async function testLogCount(): Promise<number> {
  return db.testlog.where('kind').equals('read').count();
}

export async function clearTestLog(): Promise<void> {
  await db.testlog.clear();
}

/** A read as it goes into the file: its picture, if any, as base64. */
export type TestLogFileRead = Omit<TestLogRead, 'crop'> & { crop?: string };

export interface TestLogFile {
  format: typeof TESTLOG_FORMAT;
  version: typeof TESTLOG_VERSION;
  /** ISO timestamp. */
  exportedAt: string;
  app: { build: string; userAgent: string };
  /** Oldest first. */
  reads: TestLogFileRead[];
  /** Oldest first. */
  events: TestLogEvent[];
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function createTestLogFile(app: TestLogFile['app'], now: Date = new Date()): Promise<TestLogFile> {
  const entries = await db.testlog.orderBy('at').toArray();
  return {
    format: TESTLOG_FORMAT,
    version: TESTLOG_VERSION,
    exportedAt: now.toISOString(),
    app,
    reads: entries
      .filter((entry): entry is TestLogRead => entry.kind === 'read')
      .map(({ crop, ...read }) => ({ ...read, ...(crop ? { crop: toBase64(crop) } : {}) })),
    events: entries.filter((entry): entry is TestLogEvent => entry.kind === 'event'),
  };
}

export function testLogFileName(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return `manifest-testlog-${stamp}.json`;
}

/** Reads a test log file; throws when it isn't one this version understands. */
export function parseTestLog(text: string): TestLogFile {
  const data = JSON.parse(text) as Partial<TestLogFile>;
  if (data.format !== TESTLOG_FORMAT) throw new Error("This file isn't a Manifest test log.");
  if (data.version !== TESTLOG_VERSION) throw new Error(`This test log is version ${String(data.version)}; this reads version ${TESTLOG_VERSION}.`);
  if (!Array.isArray(data.reads) || !Array.isArray(data.events)) throw new Error('This test log is damaged: it has no reads or events.');
  return data as TestLogFile;
}

/** The build this app is: package version and commit, set at build time. */
declare const __BUILD__: string | undefined;
export const BUILD = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';
