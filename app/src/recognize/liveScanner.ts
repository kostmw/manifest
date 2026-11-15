/**
 * One live camera frame at a time: detect the card, keep the LiveSession's
 * books, and read the card when the session says so. The worker runs it on
 * camera frames; the live replay (tests/eval/live-replay.ts) runs it in Node
 * on frames rebuilt from a test log. Pure apart from recognition itself.
 */
import { detectCards } from '../vision/detect';
import type { Quad } from '../vision/geometry';
import type { RgbaImage } from '../vision/image';
import { assessQuality, dominantColorShare, textureShare, type QualityAdvice, type QualityIssue, type QualityMetrics, type QualityReport } from '../vision/quality';
import { warpQuad } from '../vision/rectify';
import { canvasFromFrame, cornersMapping, deglared, fingerprintAt, toWords, type CardPlacement, type FingerprintCanvas } from './fingerprint';
import { LiveSession, NO_IDENTITY, type CardIdentity, type FrameNote, type LivePhase, type ReadTrigger } from './liveSession';
import { detectOptions, recognizeFrame, type Recognition, type RecognizeOptions } from './pipeline';

/**
 * Live frames are watched on a copy this size on its long side: about 40%
 * cheaper per frame than 640, and it finds cards at least as often. A read
 * detects the card again at 640, as the eval does: reading from the 480
 * outline cost one wrong auto-accept (a promo twin) on the standard set.
 */
export const LIVE_DETECT_SIZE = 480;

/** Below this name confidence a read doesn't say which card it was. */
const IDENTITY_NAME_MIN = 0.5;

/** What a read says the card is, for telling it from the next one. */
export function identityOf(recognition: Recognition): CardIdentity {
  const name = recognition.nameConfidence >= IDENTITY_NAME_MIN ? (recognition.names[0] ?? null) : null;
  const printingId = recognition.decision === 'accept' ? (recognition.printings[0]?.printing.id ?? null) : null;
  const guess = recognition.printings[0]?.printing.id ?? null;
  return name || printingId || guess ? { name, printingId, guess } : NO_IDENTITY;
}

type Regions = RecognizeOptions['regions'];

/** The card's fingerprints at the given placements of a canvas, and the same with a hotspot painted over, end to end. */
function looksAt(
  frame: RgbaImage,
  corners: Quad,
  regions: Regions,
  placements: readonly CardPlacement[],
  margin: number,
  blind?: (canvas: FingerprintCanvas) => boolean,
): Uint32Array | null {
  const mapping = cornersMapping(corners, regions.size);
  if (!mapping) return null;
  const canvas = canvasFromFrame(frame, mapping, regions.size, margin);
  if (blind?.(canvas)) return null;
  const fixed = deglared(canvas, regions.size);
  const canvases = fixed ? [canvas, fixed] : [canvas];
  const out = new Uint32Array(placements.length * canvases.length * 4);
  let offset = 0;
  for (const source of canvases) {
    for (const placement of placements) {
      out.set(toWords(fingerprintAt(source, regions, placement)), offset);
      offset += 4;
    }
  }
  return out;
}

/**
 * The card in view's fingerprint, to tell a new card put on top from the one
 * read last. With a flashlight's hotspot on it, also its look with the hotspot
 * painted over (see glare.ts), end to end: the two compare as their closest pair.
 */
export function cardSignature(frame: RgbaImage, corners: Quad, regions: Regions): Uint32Array | null {
  return looksAt(frame, corners, regions, [[0, 0, regions.size.width, regions.size.height]], 0);
}

/** Shifts tried when looking for the card read last where it lay, as shares of the card's size: a hand-held phone moves. */
const PRESENCE_SHIFTS = [-0.12, -0.06, 0, 0.06, 0.12];
/**
 * A spot this much blown out (grey ≥ 250), or this dark on average, shows
 * nothing either way: the camera is re-exposing (the flashlight switching).
 * An empty deck box, or a hand, is neither.
 */
const BLOWN_OUT_SHARE = 0.35;
const TOO_DARK_MEAN = 18;

/** Whether a canvas is too blown out or too dark to show what lies there. */
function unseeing(canvas: FingerprintCanvas): boolean {
  const { data } = canvas.gray;
  let clipped = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const value = data[i]!;
    sum += value;
    if (value >= 250) clipped += 1;
  }
  return clipped > data.length * BLOWN_OUT_SHARE || sum < data.length * TOO_DARK_MEAN;
}

/**
 * What lies at the given corners, as looks of a card there or a little to one
 * side (`PRESENCE_SHIFTS` each way), for asking whether the card read last is
 * still there when detection doesn't find it. All from one canvas. Null when
 * the spot is too blown out or too dark to say.
 */
export function presenceSignature(frame: RgbaImage, corners: Quad, regions: Regions): Uint32Array | null {
  const { width, height } = regions.size;
  const placements: CardPlacement[] = [];
  for (const dy of PRESENCE_SHIFTS) {
    for (const dx of PRESENCE_SHIFTS) placements.push([dx * width, dy * height, width + dx * width, height + dy * height]);
  }
  return looksAt(frame, corners, regions, placements, Math.max(...PRESENCE_SHIFTS) * width, unseeing);
}

/** What one frame told the session, and how long after the one before it came (ms), for the test log. */
export interface TrailFrame extends FrameNote {
  ms: number;
}

/** A read live mode made, and what became of it. */
export interface LiveRead {
  recognition: Recognition;
  /** The card that was read, rectified (also when the read gave up). */
  card: RgbaImage;
  /** False: it was the card already counted, looking different; `why` says how that was decided. */
  counted: boolean;
  why: string | null;
  /** Every try failed, so the card is reported as unreadable. */
  gaveUp: boolean;
  /** Why it was read (see ReadTrigger), and how far the card in view was from the card read last. */
  trigger: ReadTrigger;
  distance: number | null;
  /** The frames since the read before, oldest first, at most `TRAIL_FRAMES`. */
  frames: TrailFrame[];
}

export interface LiveFrame {
  frame: { width: number; height: number };
  corners: Quad | null;
  steadyFrames: number;
  phase: LivePhase;
  issues: QualityIssue[];
  advice: QualityAdvice[];
  metrics: QualityMetrics | null;
  /** Milliseconds: `detect` for every frame, plus the read's stages when there was one (its detection as `read-detect`). */
  timings: Record<string, number>;
  read: LiveRead | null;
  /** Another frame was still being worked on, so this one was dropped untouched. */
  busy?: true;
  /** The outline held no card (an empty box's floor), so nothing was read. */
  dismissed?: true;
}

/** Frames kept for a read's trail in the test log. */
const TRAIL_FRAMES = 24;
/**
 * An outline this untextured (textureShare) and this much one colour
 * (dominantColorShare) holds no card: an empty box's floor. No card in the
 * eval sets or the owner's logs is both.
 */
const BLANK_TEXTURE = 0.1;
const BLANK_COLOR = 0.65;

/** Whether a rectified outline holds nothing at all: no card, only a flat surface. */
export function isBlank(card: RgbaImage): boolean {
  return textureShare(card) < BLANK_TEXTURE && dominantColorShare(card) > BLANK_COLOR;
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

export class LiveScanner {
  private working = false;
  private trail: TrailFrame[] = [];
  private lastFrameAt: number | null = null;

  constructor(
    readonly session: LiveSession = new LiveSession(),
    private readonly clock: () => number = () => performance.now(),
  ) {}

  /** A frame is being worked on (read, most likely): another one now would be dropped. */
  get busy(): boolean {
    return this.working;
  }

  /**
   * One camera frame. Frames are handled one at a time: one that arrives while
   * another is still being read is dropped (`busy`), so two reads can never
   * overlap and count one card twice.
   */
  async frame(frame: RgbaImage, context: RecognizeOptions): Promise<LiveFrame> {
    if (this.working) return { ...emptyFrame(frame), busy: true };
    this.working = true;
    try {
      return await this.work(frame, context);
    } finally {
      this.working = false;
    }
  }

  private async work(frame: RgbaImage, context: RecognizeOptions): Promise<LiveFrame> {
    const started = this.clock();
    const { regions } = context;
    const detections = detectCards(frame, detectOptions(regions, LIVE_DETECT_SIZE));
    const best = detections[0] ?? null;
    // When detection doesn't find the card read last where it lay, whether it is still lying there.
    const step = this.session.next(best?.corners ?? null, (corners) => presenceSignature(frame, corners, regions));
    this.note(started);
    const outcome: LiveFrame = { ...emptyFrame(frame), corners: best?.corners ?? null, steadyFrames: step.steadyFrames, phase: step.phase };
    outcome.timings.detect = this.clock() - started;
    if (!best) return outcome;

    const card = warpQuad(frame, best.corners, regions.size);
    const quality = assessQuality({ frame, corners: best.corners, card, titleBox: regions.title.search });
    outcome.issues = quality.issues;
    outcome.advice = quality.advice;
    outcome.metrics = quality.metrics;
    // A card put on top of the one read last: read it like any new card.
    let recognize = step.recognize;
    let signature: Uint32Array | null = null;
    if (step.checkCard) {
      signature = cardSignature(frame, best.corners, regions);
      if (this.session.changed(signature)) {
        recognize = true;
        outcome.phase = 'reading';
      }
    }
    // A card-shaped patch with nothing on it (the floor of an empty deck box) is no card, sharp
    // or not: it isn't read, counted or sent to review, and a card put there later still counts.
    if (recognize && isBlank(card)) {
      this.session.dismiss(signature ?? cardSignature(frame, best.corners, regions), best.corners);
      outcome.phase = 'empty';
      outcome.dismissed = true;
      return outcome;
    }
    if (!recognize || !quality.ok) return outcome;
    signature ??= cardSignature(frame, best.corners, regions);
    const { trigger, distance } = this.session.readReason;

    // A read that throws or finds nothing usable is tried again on the next steady frame, a few
    // times; then the card is reported as unreadable, so live mode never waits forever.
    let recognition: Recognition | null = null;
    try {
      recognition = await recognizeFrame(frame, { ...context, keepImages: true });
    } catch (error) {
      console.warn('Reading a live frame failed', error);
    }
    const frames = this.trail;
    if (!recognition || recognition.decision === 'retake' || recognition.decision === 'no-card') {
      // The read's own detection (at a larger size) finding no card where live mode saw one is a
      // failed try too; when every try says so, it was no card (round 7: all four such were junk).
      const verdict = this.session.failed(signature, best.corners, recognition?.decision === 'no-card');
      if (verdict === 'retry') {
        outcome.phase = 'reading';
        return outcome;
      }
      if (verdict === 'no-card') {
        this.trail = [];
        outcome.phase = 'empty';
        outcome.dismissed = true;
        return outcome;
      }
      this.trail = [];
      outcome.phase = 'read';
      const counted = verdict === 'report';
      outcome.read = {
        recognition: unreadable(card, quality, recognition?.timings ?? {}),
        card,
        counted,
        why: counted ? null : (this.session.lastSameCard ?? 'same card'),
        gaveUp: true,
        trigger,
        distance,
        frames,
      };
      return outcome;
    }
    this.trail = [];
    outcome.phase = 'read';
    // The read's own stages; its detection at full size is timed as `read-detect`.
    for (const [stage, ms] of Object.entries(recognition.timings)) outcome.timings[stage === 'detect' ? 'read-detect' : stage] = ms;
    // A card that only looked different (glare, foil shimmer, the flashlight) is the card already counted.
    const counted = this.session.settle(signature, best.corners, identityOf(recognition));
    outcome.read = {
      recognition,
      card: recognition.card ?? card,
      counted,
      why: counted ? null : (this.session.lastSameCard ?? 'same card'),
      gaveUp: false,
      trigger,
      distance,
      frames,
    };
    return outcome;
  }

  /** Keeps what the session made of this frame for the next read's trail. */
  private note(now: number): void {
    const ms = this.lastFrameAt === null ? 0 : Math.round(now - this.lastFrameAt);
    this.lastFrameAt = now;
    this.trail = [...this.trail, { ms, ...this.session.lastFrame }].slice(-TRAIL_FRAMES);
  }

  /** The flashlight was switched: the camera re-exposes, so the card read last is held and then checked. */
  cameraChanged(): void {
    this.session.cameraChanged();
  }

  /** Read the card in view again, even though it hasn't left. */
  again(): void {
    this.session.again();
  }
}

function emptyFrame(frame: RgbaImage): LiveFrame {
  return {
    frame: { width: frame.width, height: frame.height },
    corners: null,
    steadyFrames: 0,
    phase: 'empty',
    issues: [],
    advice: [],
    metrics: null,
    timings: {},
    read: null,
  };
}
