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
import { distance } from '../vision/geometry';
import type { GrayImage, RgbaImage } from '../vision/image';
import { rotateRgba180 } from '../vision/image';
import { assessQuality, DEFAULT_QUALITY, type QualityReport, type QualityThresholds } from '../vision/quality';
import { warpQuad } from '../vision/rectify';
import { cornersMapping, boxCorners, type CardMapping } from './fingerprint';
import { identifyPrinting, type PrintingCandidate } from './identify';
import type { NameIndex } from './nameSearch';
import type { OcrEngine, OcrLine } from './ocr';
import { cropTitle, cropTitleFromFrame, MAX_TITLE_DETAIL } from './titleCrop';
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
async function readTitle(card: RgbaImage, options: RecognizeOptions, rotated: boolean, enough: number, source: TitleSource | null) {
  const crop = source
    ? cropTitleFromFrame(source.frame, rotated ? source.turned : source.upright, options.regions.title, source.scale)
    : cropTitle(card, options.regions.title);
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
 * Below this name confidence, the other outline that was read is identified
 * too: when neither title reads, the first outline may be a card-shaped patch
 * of background around the card, and only the artwork can tell.
 */
const OUTLINE_FALLBACK_BELOW = 0.5;
/** Read the title from the frame itself once it holds this much more detail than the rectified card. */
const FRAME_TITLE_MIN_DETAIL = 1.25;

/** Where to read the title when the photo has more detail than the rectified card. */
interface TitleSource {
  frame: RgbaImage;
  upright: CardMapping;
  turned: CardMapping;
  scale: number;
}

function titleSource(frame: RgbaImage, detection: CardDetection, regions: CardRegions): TitleSource | null {
  const upright = cornersMapping(detection.corners, regions.size);
  const [a, b, c, d] = detection.corners;
  const turned = cornersMapping([c, d, a, b], regions.size);
  if (!upright || !turned) return null;
  // Frame pixels per card pixel along the title band, at its narrower end (the far edge of a tilted card).
  const { search } = regions.title;
  const detailAt = (mapping: CardMapping) => {
    const band = boxCorners(mapping, search);
    return Math.min(distance(band[0], band[1]), distance(band[3], band[2])) / search.width;
  };
  const detail = Math.min(detailAt(upright), detailAt(turned));
  if (detail < FRAME_TITLE_MIN_DETAIL) return null;
  return { frame, upright, turned, scale: Math.min(detail, MAX_TITLE_DETAIL) };
}
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
  const source = titleSource(frame, detection, options.regions);
  let read = await readTitle(upright, options, false, decision.retryRotated, source);
  if (read.match.confidence < decision.retryRotated) {
    const turned = await readTitle(rotateRgba180(upright), options, true, decision.retryRotated, source);
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
  type Attempt = Awaited<ReturnType<typeof readCandidate>>;
  const attempts: Attempt[] = [];
  let best: Attempt | null = null;
  for (const detection of detections.slice(0, MAX_CANDIDATES)) {
    const attempt = await readCandidate(frame, detection, options, decision, lap);
    attempts.push(attempt);
    if (!best || (attempt.score >= SWITCH_FLOOR && attempt.score > best.score)) best = attempt;
    if (best.score >= decision.retryRotated || !attempt.read) break;
  }
  if (!best!.read) {
    return { decision: 'retake', detection: best!.detection, quality: best!.quality, title: null, ...EMPTY, timings };
  }

  /** Names and printings for one read outline. */
  const conclude = async (attempt: Attempt & { read: NonNullable<Attempt['read']> }) => {
    const { detection, quality } = attempt;
    const { title, match, card } = attempt.read;
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
    return { detection, quality, title, titleCandidates, names, nameConfidence, confidence, printings, collector, collectorCrops, upright };
  };

  let chosen = await conclude(best as Attempt & { read: NonNullable<Attempt['read']> });
  // Neither title read and the chosen outline's artwork matches nothing: the card may be the other outline.
  if (options.printings && chosen.nameConfidence < OUTLINE_FALLBACK_BELOW) {
    for (const other of attempts) {
      if (other === best || !other.read) continue;
      const alternative = await conclude(other as Attempt & { read: NonNullable<Attempt['read']> });
      if (alternative.confidence > chosen.confidence) chosen = alternative;
    }
  }
  const { detection, quality, title, titleCandidates, names, nameConfidence, confidence, printings, collector, collectorCrops, upright } = chosen;

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
