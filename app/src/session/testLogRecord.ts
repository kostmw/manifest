/** Turns a scan and what became of it into a test log read (see testLog.ts). */
import type { PrintingCandidate } from '../recognize/identify';
import type { IntakeOutcome } from './intake';
import { addTestLogRead, BUILD, testLogPictures, type TestLogCandidate, type TestLogOutcome, type TestLogRead, type TestLogSettings } from './testLog';

/** What a log entry needs from the worker's ScanResult. */
export interface LoggedScan {
  names: string[];
  printings: PrintingCandidate[];
  nameConfidence: number;
  confidence: number;
  titleText: string;
  collectorText: string;
  advice: string[];
  trace: string[];
  quality: {
    brightness: number;
    noise: number;
    sharpness: number;
    tilt: number;
    hotspot: number;
    cardWidth: number;
    inFrame: boolean;
    issues: string[];
  } | null;
  frame: { width: number; height: number };
  card: Blob | null;
}

export function logCandidates(printings: readonly PrintingCandidate[]): TestLogCandidate[] {
  return printings.slice(0, 5).map((candidate) => ({
    id: candidate.printing.id,
    name: candidate.printing.name,
    set: candidate.printing.set,
    number: candidate.printing.number,
    score: round(candidate.score),
    title: round(candidate.title),
    art: candidate.hashDistance,
    collector: candidate.collector ? { number: candidate.collector.number, set: candidate.collector.set, score: round(candidate.collector.score) } : null,
    sources: candidate.sources,
  }));
}

export function logOutcome(outcome: IntakeOutcome | { kind: 'same-card'; why: string }): TestLogOutcome {
  if (outcome.kind === 'added') return { kind: 'added', printingId: outcome.printing.id, finish: outcome.finish };
  if (outcome.kind === 'review') return { kind: 'review', reason: outcome.review.reason };
  return outcome;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export function buildTestLogRead(input: {
  id: string;
  at: Date;
  source: 'live' | 'photo';
  scan: LoggedScan;
  outcome: TestLogOutcome;
  settings: TestLogSettings;
  timings: Record<string, number>;
  userAgent: string;
  crop?: ArrayBuffer | null;
}): TestLogRead {
  const { scan } = input;
  return {
    id: input.id,
    kind: 'read',
    at: input.at.toISOString(),
    source: input.source,
    build: BUILD,
    userAgent: input.userAgent,
    settings: input.settings,
    frame: scan.frame,
    timings: Object.fromEntries(Object.entries(input.timings).map(([stage, ms]) => [stage, Math.round(ms)])),
    quality: scan.quality
      ? {
          brightness: Math.round(scan.quality.brightness),
          noise: round(scan.quality.noise),
          sharpness: Math.round(scan.quality.sharpness),
          tilt: Math.round(scan.quality.tilt),
          glare: round(scan.quality.hotspot),
          cardWidth: Math.round(scan.quality.cardWidth),
          inFrame: scan.quality.inFrame,
          issues: scan.quality.issues,
          advice: scan.advice,
        }
      : null,
    ocr: { title: scan.titleText, collector: scan.collectorText },
    trace: scan.trace,
    candidates: logCandidates(scan.printings),
    nameConfidence: round(scan.nameConfidence),
    confidence: round(scan.confidence),
    outcome: input.outcome,
    ...(input.crop ? { crop: input.crop } : {}),
  };
}

/** Card pictures in the log: about a quarter of the scan's pixels, enough to see what the camera saw. */
const PICTURE = { width: 244, height: 340, quality: 0.7 };

/** The card as a small JPEG, or null where the browser can't make one. */
export async function smallJpeg(card: Blob): Promise<ArrayBuffer | null> {
  try {
    const bitmap = await createImageBitmap(card);
    const canvas = document.createElement('canvas');
    canvas.width = PICTURE.width;
    canvas.height = PICTURE.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, PICTURE.width, PICTURE.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', PICTURE.quality));
    return blob ? await blob.arrayBuffer() : null;
  } catch {
    return null;
  }
}

/** Records a read in the browser; never throws, since the log must not get in the way of scanning. */
export async function recordRead(input: Omit<Parameters<typeof buildTestLogRead>[0], 'at' | 'userAgent' | 'crop'>): Promise<void> {
  try {
    const crop = testLogPictures() && input.scan.card ? await smallJpeg(input.scan.card) : null;
    await addTestLogRead(buildTestLogRead({ ...input, at: new Date(), userAgent: navigator.userAgent, crop }));
  } catch {
    // Storage full or blocked: the scan itself is already saved.
  }
}
