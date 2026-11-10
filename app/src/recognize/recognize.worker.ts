/**
 * The recognition worker: every bit of CV and OCR runs here, off the main
 * thread. Tesseract runs in its own worker, started from this one. Frames come
 * in as transferred ImageBitmaps; results go back as plain data plus a JPEG of
 * the rectified card for the review UI.
 */
import { expose } from 'comlink';
import { loadNameDictionary } from '../games/indexClient';
import { getGame } from '../games/registry';
import type { GameId } from '../games/types';
import { detectCards } from '../vision/detect';
import type { Quad } from '../vision/geometry';
import type { RgbaImage } from '../vision/image';
import { assessQuality, type QualityIssue } from '../vision/quality';
import { warpQuad } from '../vision/rectify';
import { LiveSession } from './liveSession';
import { NameIndex } from './nameSearch';
import type { OcrEngine } from './ocr';
import { detectOptions, recognizeFrame, type Decision, type Recognition } from './pipeline';
import { createTesseractEngine } from './tesseract';
import type { NameCandidate } from './titleMatch';

declare const __OCR_DIR__: string;

export interface ScanResult {
  decision: Decision;
  candidates: NameCandidate[];
  confidence: number;
  titleText: string;
  /** The rectified card, upright, as a JPEG. */
  card: Blob | null;
  timings: Record<string, number>;
}

export interface FrameOutcome {
  frame: { width: number; height: number };
  /** Where the card is in the frame, for the overlay. */
  corners: Quad | null;
  steadyFrames: number;
  /** What to fix, most important first. Empty when the frame is fine. */
  issues: QualityIssue[];
  /** Present when this frame was read. */
  result: ScanResult | null;
}

/** Live frames are capped by the camera constraints; photos are scaled down to this. */
const PHOTO_MAX_SIDE = 2000;
/** wasm-feature-detect's SIMD probe. */
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

let game: GameId | null = null;
let names: NameIndex | null = null;
let ocr: OcrEngine | null = null;
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

function ready() {
  if (!game || !names || !ocr) throw new Error('The recognizer is not loaded yet');
  return { regions: getGame(game).regions, names, ocr };
}

async function toResult(recognition: Recognition): Promise<ScanResult> {
  return {
    decision: recognition.decision,
    candidates: recognition.candidates,
    confidence: recognition.confidence,
    titleText: recognition.title?.text ?? '',
    card: recognition.card ? await toJpeg(recognition.card) : null,
    timings: recognition.timings,
  };
}

const api = {
  async load(gameId: GameId): Promise<void> {
    if (game === gameId && names && ocr) return;
    const base = new URL(`${import.meta.env.BASE_URL}${__OCR_DIR__}/`, self.location.origin).href;
    const core = WebAssembly.validate(SIMD_PROBE) ? 'tesseract-core-simd-lstm.js' : 'tesseract-core-lstm.js';
    const [dictionary, engine] = await Promise.all([
      loadNameDictionary(gameId),
      createTesseractEngine({ langPath: base.replace(/\/$/, ''), corePath: `${base}${core}`, workerPath: `${base}worker.min.js` }),
    ]);
    await ocr?.dispose();
    names = new NameIndex(dictionary);
    ocr = engine;
    game = gameId;
  },

  /** One live camera frame. Reads the card once it has been steady for a few frames. */
  async live(bitmap: ImageBitmap): Promise<FrameOutcome> {
    const context = ready();
    const frame = pixels(bitmap, Number.POSITIVE_INFINITY);
    const detections = detectCards(frame, detectOptions(context.regions));
    const best = detections[0] ?? null;
    const step = live.next(best?.corners ?? null);
    const outcome: FrameOutcome = {
      frame: { width: frame.width, height: frame.height },
      corners: best?.corners ?? null,
      steadyFrames: step.steadyFrames,
      issues: [],
      result: null,
    };
    if (!best) return outcome;

    const quality = assessQuality({
      frame,
      corners: best.corners,
      card: warpQuad(frame, best.corners, context.regions.size),
      titleBox: context.regions.title.search,
    });
    outcome.issues = quality.issues;
    if (!step.recognize || !quality.ok) return outcome;

    const recognition = await recognizeFrame(frame, { ...context, detections, keepImages: true });
    if (recognition.decision === 'retake') return outcome;
    live.markRead();
    outcome.result = await toResult(recognition);
    return outcome;
  },

  /** Read the card in view again, even though it hasn't left. */
  again(): void {
    live.again();
  },

  /** A still photo: always read, since it can't be retaken the way a live frame can. */
  async photo(bitmap: ImageBitmap): Promise<FrameOutcome> {
    const context = ready();
    const frame = pixels(bitmap, PHOTO_MAX_SIDE);
    const recognition = await recognizeFrame(frame, { ...context, readDespiteQuality: true, keepImages: true });
    return {
      frame: { width: frame.width, height: frame.height },
      corners: recognition.detection?.corners ?? null,
      steadyFrames: 0,
      issues: recognition.quality?.issues ?? [],
      result: recognition.decision === 'no-card' ? null : await toResult(recognition),
    };
  },
};

export type RecognizeWorker = typeof api;

expose(api);
