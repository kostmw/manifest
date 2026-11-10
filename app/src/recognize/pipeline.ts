/**
 * Single-card recognition, end to end: detect → rectify → quality gate →
 * title OCR → fuzzy name → exact printing (collector line and fingerprints,
 * see identify.ts). Pure apart from the OCR engine and card index it is
 * handed, so the recognition worker and the Node eval run exactly the same code.
 */
import type { CardRegions, CollectorReading, GameAdapter } from '../games/adapter';
import type { Catalog } from '../games/catalog';
import type { CollectorIndex } from '../games/collectorIndex';
import { detectCards, type CardDetection } from '../vision/detect';
import type { GrayImage, RgbaImage } from '../vision/image';
import { rotateRgba180 } from '../vision/image';
import { assessQuality, DEFAULT_QUALITY, type QualityReport, type QualityThresholds } from '../vision/quality';
import { warpQuad } from '../vision/rectify';
import { identifyPrinting, type PrintingCandidate } from './identify';
import type { NameIndex } from './nameSearch';
import type { OcrEngine, OcrLine } from './ocr';
import { cropTitle } from './titleCrop';
import { matchTitle, type NameCandidate, type TitleMatch } from './titleMatch';

export interface DecisionThresholds {
  /** Name confidence at or above which a card goes straight into the batch. */
  autoAccept: number;
  /** Below this, the reading is too poor to try the card upside down as well. */
  retryRotated: number;
}

/** Placeholder until the eval tunes them; see CLAUDE.md "Stage 4: Decide". */
export const DEFAULT_DECISION: DecisionThresholds = { autoAccept: 0.9, retryRotated: 0.85 };

/** What exact-printing identification needs; without it, recognition stops at the name. */
export interface PrintingSources {
  game: Pick<GameAdapter, 'regions' | 'parseCollectorLine' | 'matchCollector' | 'printingPrior'>;
  catalog: Catalog;
  collectors: CollectorIndex | null;
}

export interface RecognizeOptions {
  regions: CardRegions;
  names: NameIndex;
  ocr: OcrEngine;
  printings?: PrintingSources;
  quality?: QualityThresholds;
  decision?: DecisionThresholds;
  /**
   * Read the title even when the quality gate fails. A photo can't be retaken
   * the way a live frame can, so it is still worth a try, but such a card is
   * never auto-accepted.
   */
  readDespiteQuality?: boolean;
  /** Keep the crops for the review UI or the eval report. */
  keepImages?: boolean;
  /** Detections already made for this frame (live mode detects every frame anyway). */
  detections?: CardDetection[];
  clock?: () => number;
}

export type Decision = 'accept' | 'review' | 'retake' | 'no-card';

export interface TitleReading {
  text: string;
  ocrConfidence: number;
  /** True when the card was read upside down and turned. */
  rotated: boolean;
  inverted: boolean;
  crop?: GrayImage;
}

export interface Recognition {
  decision: Decision;
  detection: CardDetection | null;
  quality: QualityReport | null;
  title: TitleReading | null;
  /** Card names, best first, at most five: from the printings when they were identified, else from the title. */
  names: string[];
  /** The title reading's own name candidates, best first. */
  titleCandidates: NameCandidate[];
  /** Exact printings, best first, at most five. Empty without printing sources. */
  printings: PrintingCandidate[];
  /** 0–1, that names[0] is right. */
  nameConfidence: number;
  /** 0–1, that printings[0] is right (names[0] without printing sources). Auto-accept goes by this. */
  confidence: number;
  /** What the collector line said, when it was read. */
  collector: CollectorReading | null;
  /** Milliseconds per stage. */
  timings: Record<string, number>;
  /** The rectified card, upright, when keepImages is set. */
  card?: RgbaImage;
  /** The collector line crops that were read, when keepImages is set. */
  collectorCrops?: GrayImage[];
}

const EMPTY = { names: [], titleCandidates: [], printings: [], nameConfidence: 0, confidence: 0, collector: null };

/**
 * Reads the title, trying the crop's alternative renderings while the reading
 * is still poor. Upside-down attempts get fewer: they are rarely needed.
 */
async function readTitle(card: RgbaImage, options: RecognizeOptions, rotated: boolean, enough: number) {
  const crop = cropTitle(card, options.regions.title);
  const renderings = [crop.image, ...crop.alternatives.slice(0, rotated ? 1 : 2)];
  let best: { line: OcrLine; match: TitleMatch; image: GrayImage } | null = null;
  for (const image of renderings) {
    const line = await options.ocr.readLine(image);
    const match = matchTitle(options.names, line.text, 5);
    if (!best || (match.confidence >= SWITCH_FLOOR && match.confidence > best.match.confidence)) best = { line, match, image };
    if (best.match.confidence >= enough) break;
  }
  const title: TitleReading = {
    text: best!.line.text,
    ocrConfidence: best!.line.confidence,
    rotated,
    inverted: crop.inverted,
    ...(options.keepImages ? { crop: best!.image } : {}),
  };
  return { title, match: best!.match, card };
}

export const detectOptions = (regions: CardRegions) => ({
  aspect: regions.size.width / regions.size.height,
  border: regions.border,
});

const MAX_CANDIDATES = 2;
/**
 * A fallback (the card turned over, or the next quad) replaces the first try
 * only if it reads well. Two poor readings are both junk, and the first try is
 * the likelier card.
 */
const SWITCH_FLOOR = 0.5;

/** Rectifies one detected quad, checks it, and reads its title (turning it over if that reads better). */
async function readCandidate(
  frame: RgbaImage,
  detection: CardDetection,
  options: RecognizeOptions,
  decision: DecisionThresholds,
  lap: (stage: string) => void,
) {
  const upright = warpQuad(frame, detection.corners, options.regions.size);
  lap('rectify');
  const quality = assessQuality({
    frame,
    corners: detection.corners,
    card: upright,
    titleBox: options.regions.title.search,
    thresholds: options.quality ?? DEFAULT_QUALITY,
  });
  lap('quality');
  if (!quality.ok && !options.readDespiteQuality) return { detection, quality, read: null, score: -1 };

  // Corners are ordered assuming the card is the right way up; if the title
  // doesn't read well, it may be upside down.
  let read = await readTitle(upright, options, false, decision.retryRotated);
  if (read.match.confidence < decision.retryRotated) {
    const turned = await readTitle(rotateRgba180(upright), options, true, decision.retryRotated);
    if (turned.match.confidence >= SWITCH_FLOOR && turned.match.confidence > read.match.confidence) read = turned;
  }
  lap('ocr');
  return { detection, quality, read, score: read.match.confidence };
}

export async function recognizeFrame(frame: RgbaImage, options: RecognizeOptions): Promise<Recognition> {
  const clock = options.clock ?? (() => performance.now());
  const decision = options.decision ?? DEFAULT_DECISION;
  // Per stage, summed over every candidate tried.
  const timings: Record<string, number> = {};
  let mark = clock();
  const lap = (stage: string) => {
    const now = clock();
    timings[stage] = (timings[stage] ?? 0) + now - mark;
    mark = now;
  };

  const detections = options.detections ?? detectCards(frame, detectOptions(options.regions));
  lap('detect');
  if (detections.length === 0) {
    return { decision: 'no-card', detection: null, quality: null, title: null, ...EMPTY, timings };
  }

  // The first candidate is almost always the card. When its title doesn't read, the next one
  // (a card inside a card-shaped patch of background, say) gets one try.
  let best: Awaited<ReturnType<typeof readCandidate>> | null = null;
  for (const detection of detections.slice(0, MAX_CANDIDATES)) {
    const attempt = await readCandidate(frame, detection, options, decision, lap);
    if (!best || (attempt.score >= SWITCH_FLOOR && attempt.score > best.score)) best = attempt;
    if (best.score >= decision.retryRotated || !attempt.read) break;
  }
  const { detection, quality } = best!;
  if (!best!.read) {
    return { decision: 'retake', detection, quality, title: null, ...EMPTY, timings };
  }
  const { title, match, card } = best!.read;
  const titleCandidates = match.candidates;

  let names = titleCandidates.map((candidate) => candidate.name);
  let nameConfidence = match.confidence;
  let confidence = match.confidence;
  let printings: PrintingCandidate[] = [];
  let collector: CollectorReading | null = null;
  let collectorCrops: GrayImage[] | undefined;
  let upright = card;
  if (options.printings) {
    const corners = title.rotated ? ([detection.corners[2], detection.corners[3], detection.corners[0], detection.corners[1]] as const) : detection.corners;
    const found = await identifyPrinting({
      frame,
      corners: [...corners] as CardDetection['corners'],
      orientationKnown: match.confidence >= SWITCH_FLOOR,
      title: match,
      ...options.printings,
      ocr: options.ocr,
      keepImages: options.keepImages,
      lap,
    });
    printings = found.candidates;
    collector = found.collector;
    collectorCrops = found.collectorCrops;
    if (printings.length > 0) {
      names = [...new Set([...printings.map((candidate) => candidate.printing.name), ...names])].slice(0, 5);
      nameConfidence = found.nameConfidence;
      confidence = found.confidence;
      // The fingerprints found the card the other way up from the title's guess.
      if (found.turned && options.keepImages) upright = rotateRgba180(card);
    }
  }

  const verdict: Decision = names.length > 0 && confidence >= decision.autoAccept && quality.ok ? 'accept' : 'review';
  return {
    decision: verdict,
    detection,
    quality,
    title,
    names,
    titleCandidates,
    printings,
    nameConfidence,
    confidence,
    collector,
    timings,
    ...(options.keepImages ? { card: upright, ...(collectorCrops ? { collectorCrops } : {}) } : {}),
  };
}
