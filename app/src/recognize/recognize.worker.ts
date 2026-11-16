/**
 * The recognition worker: every bit of CV and OCR runs here, off the main
 * thread. Tesseract runs in its own worker, started from this one. Frames come
 * in as transferred ImageBitmaps; results go back as plain data plus a JPEG of
 * the rectified card for the review UI.
 */
import { expose } from 'comlink';
import { Catalog } from '../games/catalog';
import type { CollectorIndex } from '../games/collectorIndex';
import { browserIndexSource, loadNameDictionary } from '../games/indexClient';
import { getGame } from '../games/registry';
import type { GameId } from '../games/types';
import type { Quad } from '../vision/geometry';
import type { RgbaImage } from '../vision/image';
import type { QualityAdvice, QualityIssue, QualityMetrics } from '../vision/quality';
import { FINGERPRINT_VERSION } from './fingerprint';
import type { PrintingCandidate } from './identify';
import { LiveScanner, type LiveRead, type QuietSpell, type TrailFrame } from './liveScanner';
import type { LivePhase, ReadTrigger } from './liveSession';
import { NameIndex } from './nameSearch';
import type { OcrEngine } from './ocr';
import { recognizeFrame, type Decision, type Recognition } from './pipeline';
import { createTesseractEngine } from './tesseract';

declare const __OCR_DIR__: string;

export interface ScanResult {
  decision: Decision;
  /** Card names, best first, at most five. */
  names: string[];
  /** Exact printings, best first, at most five. */
  printings: PrintingCandidate[];
  /** 0–1, that names[0] is right. */
  nameConfidence: number;
  /** 0–1, that printings[0] is right: what auto-accept goes by. */
  confidence: number;
  titleText: string;
  /** The collector line as OCR read it. */
  collectorText: string;
  /** The rectified card, upright, as a JPEG. */
  card: Blob | null;
  /** Milliseconds per recognition stage. */
  timings: Record<string, number>;
  /** Milliseconds in the worker for the whole frame or photo, JPEG included. */
  elapsedMs: number;
  /** What might have made the card hard to read. */
  advice: QualityAdvice[];
  /** Live mode tried this card several times and none of the reads worked. */
  gaveUp: boolean;
  /** No outline was clear, so the card was found by looking at the middle of the photo. */
  guessedOutline: boolean;
  /** The batch is locked to some sets, and the best name has no printing in them. */
  outsideLock: boolean;
  /** The paths recognition took (see Recognition.trace). */
  trace: string[];
  /** The quality gate's measurements and verdict for the card that was read; null when none was. */
  quality: (QualityMetrics & { issues: QualityIssue[]; inFrame: boolean }) | null;
  /** The frame or photo's size, as read. */
  frame: { width: number; height: number };
}

export interface FrameOutcome {
  frame: { width: number; height: number };
  /** Where the card is in the frame, for the overlay. */
  corners: Quad | null;
  steadyFrames: number;
  /** Live mode's progress with the card in view (always `empty` for photos). */
  phase: LivePhase;
  /** What to fix, most important first. Empty when the frame is fine. */
  issues: QualityIssue[];
  /** Worth saying, but not a reason to skip the frame. */
  advice: QualityAdvice[];
  /** The quality gate's measurements of the card in view, for the debug readout. */
  metrics: QualityMetrics | null;
  /** Milliseconds in the worker: `detect` and `total` for every frame, plus the read when there was one. */
  timings: Record<string, number>;
  /** Present when this frame was read and it is a new card. */
  result: ScanResult | null;
  /**
   * This frame read the card already counted again, because it looked
   * different (glare, foil shimmer), and found it was the same card: nothing
   * is counted.
   */
  sameCard?: boolean;
  /** That read, and why it was taken for the same card, for the test log. */
  repeat?: { result: ScanResult; why: string };
  /** For a live read (counted or not): why live mode read the card, and the frames before it, for the test log. */
  liveRead?: { trigger: ReadTrigger; distance: number | null; frames: TrailFrame[] };
  /** Another frame was still being read, so this one was dropped: nothing to show. */
  busy?: true;
  /**
   * Live mode went a while without reading anything: what it saw meanwhile,
   * for the test log; with a small picture of the frame when detection found
   * an outline on fewer than half its frames (round 10: foils lost to it).
   */
  quiet?: QuietSpell & { picture?: Blob };
  /** The card read last was forgotten on this frame, for the test log. */
  gone?: { card: string | null; moved: boolean; frames: TrailFrame[] };
  /** With `repeat`: the re-read is much surer than the read the card was counted as, and should stand in for it. */
  upgrade?: true;
  /** A counted live read's number, and the earlier junk reads (by number) it stands in for (see LiveRead). */
  seq?: number;
  supersedes?: number[];
}

/**
 * Live frames are capped by the camera constraints; photos are scaled down to
 * this. Detection works on a small copy anyway; the full size is kept for the
 * collector line, whose text is only a few pixels tall at lower resolutions.
 */
const PHOTO_MAX_SIDE = 3000;
/** wasm-feature-detect's SIMD probe. */
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

let game: GameId | null = null;
let names: NameIndex | null = null;
let ocr: OcrEngine | null = null;
let catalog: Catalog | null = null;
let collectors: CollectorIndex | null = null;
/** The batch's set lock; empty for any set. */
let lockSets: string[] = [];
const live = new LiveScanner();

function pixels(bitmap: ImageBitmap, maxSide: number): RgbaImage {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser cannot read pixels in a worker');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return { width, height, data: context.getImageData(0, 0, width, height).data };
}

/** Width of the frame snapshot a quiet spell carries when detection kept failing. */
const SNAPSHOT_WIDTH = 180;
/** Below this share of a quiet spell's frames with an outline, it carries a snapshot. */
const SNAPSHOT_OUTLINE_SHARE = 0.5;

/** The frame, small, as a JPEG. */
async function snapshot(image: RgbaImage): Promise<Blob> {
  const full = new OffscreenCanvas(image.width, image.height);
  full.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  const height = Math.round((image.height * SNAPSHOT_WIDTH) / image.width);
  const small = new OffscreenCanvas(SNAPSHOT_WIDTH, height);
  small.getContext('2d')!.drawImage(full, 0, 0, SNAPSHOT_WIDTH, height);
  return small.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
}

async function toJpeg(image: RgbaImage): Promise<Blob> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext('2d')!;
  context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}

function ready() {
  if (!game || !names || !ocr || !catalog) throw new Error('The recognizer is not loaded yet');
  const adapter = getGame(game);
  return { regions: adapter.regions, names, ocr, printings: { game: adapter, catalog, collectors, lockSets } };
}

async function toResult(recognition: Recognition, started: number, frame: { width: number; height: number }, gaveUp = false): Promise<ScanResult> {
  // A picture that fails to encode must not lose a card live mode has already counted (QA L-h).
  const card = recognition.card ? await toJpeg(recognition.card).catch(() => null) : null;
  return {
    decision: recognition.decision,
    names: recognition.names,
    printings: recognition.printings,
    nameConfidence: recognition.nameConfidence,
    confidence: recognition.confidence,
    titleText: recognition.title?.text ?? '',
    collectorText: recognition.collector?.text ?? '',
    card,
    timings: recognition.timings,
    elapsedMs: performance.now() - started,
    advice: recognition.quality?.advice ?? [],
    gaveUp,
    guessedOutline: recognition.guessedOutline,
    outsideLock: recognition.outsideLock,
    trace: recognition.trace,
    quality: recognition.quality
      ? { ...recognition.quality.metrics, issues: recognition.quality.issues, inFrame: !recognition.quality.issues.includes('out-of-frame') }
      : null,
    frame,
  };
}

/** A live read as the main thread gets it: a new card (`result`), or the card already counted (`repeat`). */
async function liveOutcome(read: LiveRead, started: number, outcome: FrameOutcome): Promise<void> {
  const result = await toResult(read.recognition, started, outcome.frame, read.gaveUp);
  outcome.liveRead = { trigger: read.trigger, distance: read.distance, frames: read.frames };
  if (read.seq !== undefined) outcome.seq = read.seq;
  if (read.supersedes) outcome.supersedes = read.supersedes;
  if (read.counted) {
    outcome.result = result;
  } else {
    outcome.sameCard = true;
    outcome.repeat = { result, why: read.why ?? 'same card' };
    if (read.upgrade) outcome.upgrade = true;
  }
}

const api = {
  async load(gameId: GameId): Promise<void> {
    if (game === gameId && names && ocr) return;
    const base = new URL(`${import.meta.env.BASE_URL}${__OCR_DIR__}/`, self.location.origin).href;
    const core = WebAssembly.validate(SIMD_PROBE) ? 'tesseract-core-simd-lstm.js' : 'tesseract-core-lstm.js';
    const nextCatalog = new Catalog(browserIndexSource(gameId), FINGERPRINT_VERSION);
    const [dictionary, engine] = await Promise.all([
      loadNameDictionary(gameId),
      createTesseractEngine({
        langPath: base.replace(/\/$/, ''),
        corePath: `${base}${core}`,
        workerPath: `${base}worker.min.js`,
        // The versioned directory names the model, so a model change can't reuse an old cached one.
        cachePath: __OCR_DIR__,
      }),
    ]);
    // Collector lookups are a fallback; scanning works without them.
    const nextCollectors = await nextCatalog.collectors(dictionary).catch(() => null);
    await ocr?.dispose();
    names = new NameIndex(dictionary);
    ocr = engine;
    catalog = nextCatalog;
    collectors = nextCollectors;
    game = gameId;
    // Every fingerprint (about 1.8 MB, cached), for cards whose title can't be read. Not awaited:
    // the first scans don't need it, and a failure only means text-only recognition.
    void nextCatalog.fingerprintTable().catch(() => null);
  },

  /**
   * One live camera frame. Reads the card once it has been steady for a few
   * frames. A frame that comes while another is still being read is dropped
   * (`busy`): reads never overlap.
   */
  async live(bitmap: ImageBitmap): Promise<FrameOutcome> {
    if (live.busy) {
      const frame = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return { frame, corners: null, steadyFrames: 0, phase: 'empty', issues: [], advice: [], metrics: null, timings: {}, result: null, busy: true };
    }
    const started = performance.now();
    const context = ready();
    const frame = pixels(bitmap, Number.POSITIVE_INFINITY);
    const copied = performance.now();
    const seen = await live.frame(frame, context);
    const { read, busy: _busy, ...rest } = seen;
    const outcome: FrameOutcome = { ...rest, timings: { pixels: copied - started, ...seen.timings }, result: null };
    if (read) await liveOutcome(read, started, outcome);
    const quiet = outcome.quiet;
    if (quiet && quiet.frames.filter((entry) => entry.outline).length < quiet.frames.length * SNAPSHOT_OUTLINE_SHARE) {
      outcome.quiet = { ...quiet, picture: await snapshot(frame).catch(() => undefined) };
    }
    outcome.timings.total = performance.now() - started;
    return outcome;
  },

  /** The flashlight was switched: hold the card read last while the camera re-exposes, then check it. */
  cameraChanged(): void {
    live.cameraChanged();
  },

  /** Read the card in view again, even though it hasn't left. */
  again(): void {
    live.again();
  },

  /** The batch's set lock, for every read from now on. Empty for any set. */
  /** Count an identical copy put on top (a Scan setting, off by default). */
  setCountCopies(on: boolean): void {
    live.setCountCopies(on);
  },

  setLock(sets: string[]): void {
    lockSets = [...sets];
  },

  /** A still photo: always read, since it can't be retaken the way a live frame can. */
  async photo(bitmap: ImageBitmap): Promise<FrameOutcome> {
    const started = performance.now();
    const context = ready();
    const frame = pixels(bitmap, PHOTO_MAX_SIDE);
    const copied = performance.now() - started;
    const recognition = await recognizeFrame(frame, { ...context, readDespiteQuality: true, keepImages: true, centerFallback: true });
    return {
      frame: { width: frame.width, height: frame.height },
      corners: recognition.detection?.corners ?? null,
      steadyFrames: 0,
      phase: 'empty',
      issues: recognition.quality?.issues ?? [],
      advice: recognition.quality?.advice ?? [],
      metrics: recognition.quality?.metrics ?? null,
      timings: { pixels: copied, ...recognition.timings, total: performance.now() - started },
      result: recognition.decision === 'no-card' ? null : await toResult(recognition, started, { width: frame.width, height: frame.height }),
    };
  },
};

export type RecognizeWorker = typeof api;

expose(api);
