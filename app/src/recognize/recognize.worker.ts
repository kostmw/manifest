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
import { detectCards } from '../vision/detect';
import type { Quad } from '../vision/geometry';
import type { RgbaImage } from '../vision/image';
import { assessQuality, type QualityAdvice, type QualityIssue, type QualityMetrics, type QualityReport } from '../vision/quality';
import { warpQuad } from '../vision/rectify';
import { canvasFromFrame, cornersMapping, deglared, FINGERPRINT_VERSION, fingerprintAt, toWords } from './fingerprint';
import type { PrintingCandidate } from './identify';
import { LiveSession, NO_IDENTITY, type CardIdentity, type LivePhase } from './liveSession';
import { NameIndex } from './nameSearch';
import type { OcrEngine } from './ocr';
import { detectOptions, recognizeFrame, type Decision, type Recognition } from './pipeline';
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
const live = new LiveSession();

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

async function toJpeg(image: RgbaImage): Promise<Blob> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext('2d')!;
  context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}

/**
 * The card in view's fingerprint, to tell a new card put on top from the one
 * read last. With a flashlight's hotspot on it, also its look with the hotspot
 * painted over (see glare.ts), end to end: the two compare as their closest pair.
 */
function cardSignature(frame: RgbaImage, corners: Quad, regions: ReturnType<typeof getGame>['regions']): Uint32Array | null {
  const mapping = cornersMapping(corners, regions.size);
  if (!mapping) return null;
  const canvas = canvasFromFrame(frame, mapping, regions.size, 0);
  const raw = toWords(fingerprintAt(canvas, regions));
  const fixed = deglared(canvas, regions.size);
  if (!fixed) return raw;
  const both = new Uint32Array(8);
  both.set(raw, 0);
  both.set(toWords(fingerprintAt(fixed, regions)), 4);
  return both;
}

/**
 * Live frames are watched on a copy this size on its long side: about 40%
 * cheaper per frame than 640, and it finds cards at least as often. A read
 * detects the card again at 640, as the eval does: reading from the 480
 * outline cost one wrong auto-accept (a promo twin) on the standard set.
 */
const LIVE_DETECT_SIZE = 480;

/** Below this name confidence a read doesn't say which card it was. */
const IDENTITY_NAME_MIN = 0.5;

/** What a read says the card is, for telling it from the next one. */
function identityOf(recognition: Recognition): CardIdentity {
  const name = recognition.nameConfidence >= IDENTITY_NAME_MIN ? (recognition.names[0] ?? null) : null;
  const printingId = recognition.decision === 'accept' ? (recognition.printings[0]?.printing.id ?? null) : null;
  return name || printingId ? { name, printingId } : NO_IDENTITY;
}

function ready() {
  if (!game || !names || !ocr || !catalog) throw new Error('The recognizer is not loaded yet');
  const adapter = getGame(game);
  return { regions: adapter.regions, names, ocr, printings: { game: adapter, catalog, collectors, lockSets } };
}

async function toResult(recognition: Recognition, started: number, frame: { width: number; height: number }, gaveUp = false): Promise<ScanResult> {
  const card = recognition.card ? await toJpeg(recognition.card) : null;
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

/** What live mode reports for a card it has given up on: no names, the crop, and why it may have failed. */
function unreadable(card: RgbaImage, quality: QualityReport, timings: Record<string, number>): Recognition {
  return {
    decision: 'review',
    detection: null,
    quality,
    title: null,
    names: [],
    titleCandidates: [],
    printings: [],
    nameConfidence: 0,
    confidence: 0,
    collector: null,
    timings,
    card,
    guessedOutline: false,
    outsideLock: false,
    trace: ['gave-up'],
  };
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

  /** One live camera frame. Reads the card once it has been steady for a few frames. */
  async live(bitmap: ImageBitmap): Promise<FrameOutcome> {
    const started = performance.now();
    const context = ready();
    const frame = pixels(bitmap, Number.POSITIVE_INFINITY);
    const copied = performance.now();
    const detections = detectCards(frame, detectOptions(context.regions, LIVE_DETECT_SIZE));
    const best = detections[0] ?? null;
    // When detection loses the card read last, whether it is still lying where it was.
    const step = live.next(best?.corners ?? null, (corners) => cardSignature(frame, corners, context.regions));
    const timings: Record<string, number> = { pixels: copied - started, detect: performance.now() - copied };
    const outcome: FrameOutcome = {
      frame: { width: frame.width, height: frame.height },
      corners: best?.corners ?? null,
      steadyFrames: step.steadyFrames,
      phase: step.phase,
      issues: [],
      advice: [],
      metrics: null,
      timings,
      result: null,
    };
    const finish = () => {
      timings.total = performance.now() - started;
      return outcome;
    };
    if (!best) return finish();

    const card = warpQuad(frame, best.corners, context.regions.size);
    const quality = assessQuality({ frame, corners: best.corners, card, titleBox: context.regions.title.search });
    outcome.issues = quality.issues;
    outcome.advice = quality.advice;
    outcome.metrics = quality.metrics;
    // A card put on top of the one read last: read it like any new card.
    let recognize = step.recognize;
    let signature: Uint32Array | null = null;
    if (step.checkCard) {
      signature = cardSignature(frame, best.corners, context.regions);
      if (live.changed(signature)) {
        recognize = true;
        outcome.phase = 'reading';
      }
    }
    if (!recognize || !quality.ok) return finish();
    signature ??= cardSignature(frame, best.corners, context.regions);

    // A read that throws or finds nothing usable is tried again on the next steady frame, a few
    // times; then the card is reported as unreadable, so live mode never waits forever.
    let recognition: Recognition | null = null;
    try {
      recognition = await recognizeFrame(frame, { ...context, keepImages: true });
    } catch (error) {
      console.warn('Reading a live frame failed', error);
    }
    if (!recognition || recognition.decision === 'retake') {
      const verdict = live.failed(signature, best.corners);
      if (verdict === 'retry') {
        outcome.phase = 'reading';
        return finish();
      }
      outcome.phase = 'read';
      const result = await toResult(unreadable(card, quality, recognition?.timings ?? {}), started, outcome.frame, true);
      if (verdict === 'same-card') {
        outcome.sameCard = true;
        outcome.repeat = { result, why: live.lastSameCard ?? 'same card' };
        return finish();
      }
      outcome.result = result;
      return finish();
    }
    outcome.phase = 'read';
    // The read's own stages; its detection at full size is timed as `read-detect`.
    for (const [stage, ms] of Object.entries(recognition.timings)) timings[stage === 'detect' ? 'read-detect' : stage] = ms;
    // A card that only looked different (glare, foil shimmer) is the card already counted.
    if (!live.settle(signature, best.corners, identityOf(recognition))) {
      outcome.sameCard = true;
      outcome.repeat = { result: await toResult(recognition, started, outcome.frame), why: live.lastSameCard ?? 'same card' };
      return finish();
    }
    outcome.result = await toResult(recognition, started, outcome.frame);
    return finish();
  },

  /** Read the card in view again, even though it hasn't left. */
  again(): void {
    live.again();
  },

  /** The batch's set lock, for every read from now on. Empty for any set. */
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
