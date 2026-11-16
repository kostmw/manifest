/**
 * One live camera frame at a time: detect the card, keep the LiveSession's
 * books, and read the card when the session says so. The worker runs it on
 * camera frames; the live replay (tests/eval/live-replay.ts) runs it in Node
 * on frames rebuilt from a test log. Pure apart from recognition itself.
 */
import { detectCards } from '../vision/detect';
import { polygonArea, type Quad } from '../vision/geometry';
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

/** Below this name confidence a read doesn't say which card it was by its name alone. */
const IDENTITY_NAME_MIN = 0.5;
/** A best guess whose artwork is this close (of 128 bits) names its card: as close as a title-less read needs (identify.ts). */
const IDENTITY_ART_MAX = 26;

/**
 * Whether a read's best guess names its card on evidence of its own, though
 * the read was unsure of its name: the collector line read its set and number
 * cleanly, or its artwork matches. Under a flashlight's hotspot the artwork
 * of two foils can be as alike as one foil's two looks (round 9: Gray and
 * Adira and a Plains, 34 bits), so the fingerprint alone can't tell them apart.
 */
function namesItsCard(recognition: Recognition): boolean {
  const best = recognition.printings[0];
  if (!best) return false;
  const collector = best.collector;
  // A match zeroed for contradicting the art (identify.ts) keeps its verdicts but vouches for nothing (QA M2).
  if (collector?.number === 'exact' && collector.set === 'exact' && collector.score > 0 && !recognition.collector?.looseNumbers) return true;
  return best.hashDistance !== null && best.hashDistance <= IDENTITY_ART_MAX;
}

/** What a read says the card is, for telling it from the next one. */
export function identityOf(recognition: Recognition): CardIdentity {
  const best = recognition.printings[0];
  const name = recognition.nameConfidence >= IDENTITY_NAME_MIN ? (recognition.names[0] ?? null) : namesItsCard(recognition) ? best!.printing.name : null;
  const printingId = recognition.decision === 'accept' ? (best?.printing.id ?? null) : null;
  const guess = best?.printing.id ?? null;
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
  phase: LivePhase;
  /** The frame's mean brightness (0–255): whether detection was working in the dark. */
  light: number;
  /** What the quality gate found wrong with the card in view, which keeps it from being read. */
  issues?: QualityIssue[];
}

/**
 * Live mode went `QUIET_MS` without reading anything: what it saw meanwhile,
 * for the test log, so that a card left unread (not found, never steady,
 * failing the quality gate, or too like the card read last) leaves a trace.
 */
export interface QuietSpell {
  /** Milliseconds since the last read. */
  ms: number;
  /** The frames since the last read or the spell before, oldest first, at most `TRAIL_FRAMES`. */
  frames: TrailFrame[];
  /** After `QUIET_SPELLS` spells in a row, one report every `QUIET_SUMMARY_MS`: what all its frames showed, in sum. */
  summary?: QuietSummary;
}

/** What the frames of a long quiet stretch showed, in sum. */
export interface QuietSummary {
  frames: number;
  /** Frames with an outline. */
  outline: number;
  steadyMax: number;
  phases: Partial<Record<LivePhase, number>>;
  light: [number, number];
  issues: Partial<Record<QualityIssue, number>>;
}

function summarize(frames: readonly TrailFrame[]): QuietSummary {
  const phases: QuietSummary['phases'] = {};
  const issues: QuietSummary['issues'] = {};
  let outline = 0;
  let steadyMax = 0;
  let low = 255;
  let high = 0;
  for (const frame of frames) {
    if (frame.outline) outline += 1;
    steadyMax = Math.max(steadyMax, frame.steady);
    phases[frame.phase] = (phases[frame.phase] ?? 0) + 1;
    low = Math.min(low, frame.light);
    high = Math.max(high, frame.light);
    for (const issue of frame.issues ?? []) issues[issue] = (issues[issue] ?? 0) + 1;
  }
  return { frames: frames.length, outline, steadyMax, phases, light: [low, high], issues };
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
  /** Counted reads are numbered, so that a later read can stand in for one (`supersedes`). */
  seq?: number;
  /**
   * Earlier reads (by `seq`) of pieces of this card that this read stands in
   * for: junk reads (no card named, confidence under JUNK_CONFIDENCE) of an
   * outline inside this one's (its text or art box), in the last
   * JUNK_WINDOW_MS, with no card gone in between. The caller should take
   * their reviews out once this read is filed (round 11: 49 such reviews).
   */
  supersedes?: number[];
  /**
   * The card already counted (`counted` false), read much more surely than
   * the read it was counted as (it names a card that read didn't, clears the
   * bar to be added, or is far more confident): the caller should let it stand
   * in for that read (round 10: a foil Constable Odo stayed a junk review).
   */
  upgrade?: true;
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
  /** Nothing was read for a while: what live mode saw meanwhile (see QuietSpell). */
  quiet?: QuietSpell;
  /** The card read last was forgotten on this frame: what it was, whether it seemed only moved, and the frames that led to it. */
  gone?: { card: string | null; moved: boolean; frames: TrailFrame[] };
}

/** Frames kept for a read's trail in the test log. */
const TRAIL_FRAMES = 24;
/** Time without a read after which the frames are reported as a quiet spell. */
export const QUIET_MS = 2000;
/** Quiet spells reported in a row before live mode stops reporting them until something is read (a long pause). */
const QUIET_SPELLS = 5;
/** After that, a long quiet stretch is reported this often, in sum (round 10: a card was forgotten in a stretch with no reports). */
const QUIET_SUMMARY_MS = 30_000;
/** Frames kept for a quiet stretch's summary. */
const QUIET_KEPT = 400;
/** How much more confident a re-read of the card already counted must be to stand in for the read it was counted as. */
const MUCH_SURER = 0.3;
/** A counted read below these names nothing: junk, which a good read of the card it was a piece of may stand in for. */
const JUNK_NAME = 0.5;
const JUNK_CONFIDENCE = 0.3;
/** How long a junk read may be stood in for, and how many are kept. */
const JUNK_WINDOW_MS = 20_000;
const JUNK_KEPT = 8;
/** An outline at most this share of another's area, with its middle inside it, is a piece of that card (its text or art box). */
const INNER_AREA = 0.85;

/** Whether `point` lies inside the convex quad `quad` (either winding). */
function insideQuad(quad: Quad, point: { x: number; y: number }): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i]!;
    const b = quad[(i + 1) % 4]!;
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (cross === 0) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

/** Whether `inner` is a piece of the card outlined by `outer`: its middle inside it, and clearly smaller. */
export function pieceOf(inner: Quad, outer: Quad): boolean {
  const middle = { x: inner.reduce((sum, p) => sum + p.x, 0) / 4, y: inner.reduce((sum, p) => sum + p.y, 0) / 4 };
  return insideQuad(outer, middle) && polygonArea(inner) <= polygonArea(outer) * INNER_AREA;
}

/** How sure a read was, to tell when a re-read of the same card is much surer. */
export interface Sureness {
  nameConfidence: number;
  confidence: number;
  accepted: boolean;
}

const surenessOf = (recognition: Recognition): Sureness => ({
  nameConfidence: recognition.nameConfidence,
  confidence: recognition.confidence,
  accepted: recognition.decision === 'accept',
});

/** Whether `after` should stand in for `before` (never for a read that was added). */
export function muchSurer(before: Sureness, after: Sureness): boolean {
  if (before.accepted) return false;
  if (after.accepted) return true;
  if (before.nameConfidence < IDENTITY_NAME_MIN && after.nameConfidence >= IDENTITY_NAME_MIN) return true;
  return after.confidence >= before.confidence + MUCH_SURER;
}

/** The frame's mean brightness, from a sparse sample. */
function meanLight(frame: RgbaImage): number {
  const step = 16;
  let sum = 0;
  let count = 0;
  for (let y = step >> 1; y < frame.height; y += step) {
    for (let x = step >> 1; x < frame.width; x += step) {
      const i = (y * frame.width + x) * 4;
      sum += 0.299 * frame.data[i]! + 0.587 * frame.data[i + 1]! + 0.114 * frame.data[i + 2]!;
      count += 1;
    }
  }
  return count ? Math.round(sum / count) : 0;
}
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

/**
 * Where a card lay shows the empty surface when it is untextured (as a blank
 * outline is: cards are 0.24 or more, an empty red deck box's floor 0.00–0.03
 * on round 11's pictures) and the same colour as the edges of the picture
 * (the box, or the table), told by chromaticity so that a flashlight's
 * brighter middle still matches: 0.00–0.04 apart on round 11's empty boxes.
 * A hand over the spot is untextured too, but another colour (0.2 or more
 * from the red box).
 */
const EMPTY_CHROMA = 0.08;
/** Share of the picture's width and height along each edge taken as its surroundings. */
const SURROUNDINGS = 0.08;

function chromaticity(r: number, g: number, b: number): [number, number] {
  const sum = Math.max(1, r + g + b);
  return [r / sum, g / sum];
}

function medianOf(values: number[]): number {
  values.sort((a, b) => a - b);
  return values[values.length >> 1] ?? 0;
}

/** The median colour of the frame's outer band (see SURROUNDINGS), from a sparse sample. */
function surroundings(frame: RgbaImage): [number, number, number] {
  const r: number[] = [];
  const g: number[] = [];
  const b: number[] = [];
  const bandX = frame.width * SURROUNDINGS;
  const bandY = frame.height * SURROUNDINGS;
  for (let y = 2; y < frame.height; y += 8) {
    for (let x = 2; x < frame.width; x += 8) {
      if (x > bandX && x < frame.width - bandX && y > bandY && y < frame.height - bandY) continue;
      const i = (y * frame.width + x) * 4;
      r.push(frame.data[i]!);
      g.push(frame.data[i + 1]!);
      b.push(frame.data[i + 2]!);
    }
  }
  return [medianOf(r), medianOf(g), medianOf(b)];
}

/** Whether the frame shows the empty surface at `corners` (see EmptyProbe); null when too blown out or dark to say. */
export function emptySpot(frame: RgbaImage, corners: Quad, regions: Regions): boolean | null {
  const spot = warpQuad(frame, corners, regions.size);
  const r: number[] = [];
  const g: number[] = [];
  const b: number[] = [];
  let clipped = 0;
  let light = 0;
  for (let p = 0; p < spot.data.length; p += 16) {
    const value = 0.299 * spot.data[p]! + 0.587 * spot.data[p + 1]! + 0.114 * spot.data[p + 2]!;
    light += value;
    if (value >= 250) clipped += 1;
    r.push(spot.data[p]!);
    g.push(spot.data[p + 1]!);
    b.push(spot.data[p + 2]!);
  }
  if (clipped > r.length * BLOWN_OUT_SHARE || light < r.length * TOO_DARK_MEAN) return null;
  if (textureShare(spot) >= BLANK_TEXTURE) return false;
  const [sr, sg] = chromaticity(medianOf(r), medianOf(g), medianOf(b));
  const [br, bg] = chromaticity(...surroundings(frame));
  return Math.abs(sr - br) + Math.abs(sg - bg) <= EMPTY_CHROMA;
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
  /** Frames since the last read or quiet spell, when the last read was, when the quiet spell started, and how many were reported since the read. */
  private quiet: TrailFrame[] = [];
  private lastReadAt: number | null = null;
  private quietSince: number | null = null;
  private quietSpells = 0;
  /** Every frame since the last quiet report, for a long stretch's summary. */
  private idle: TrailFrame[] = [];
  /** How sure the read was that the card read last was counted as; null without one. */
  private counted: Sureness | null = null;
  /** Counted reads so far (see LiveRead.seq), and the recent junk reads among them (see LiveRead.supersedes). */
  private reads = 0;
  private junk: { seq: number; corners: Quad; at: number }[] = [];

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
    const found = detections[0] ?? null;
    const warped = found ? warpQuad(frame, found.corners, regions.size) : null;
    // A card-shaped patch with nothing on it (the floor of an empty deck box) is no card: the
    // session sees nothing there, so it is never read, counted or reviewed, a card put there
    // later counts, and the floor where the card read last lay shows that it has left.
    const blank = warped !== null && isBlank(warped);
    const best = blank ? null : found;
    // When detection doesn't find the card read last where it lay, whether it is still lying
    // there; and once it went, whether the empty surface shows where it lay.
    const step = this.session.next(
      best?.corners ?? null,
      (corners) => presenceSignature(frame, corners, regions),
      (corners) => emptySpot(frame, corners, regions),
    );
    const outcome: LiveFrame = { ...emptyFrame(frame), corners: best?.corners ?? null, steadyFrames: step.steadyFrames, phase: step.phase };
    if (blank) outcome.dismissed = true;
    if (step.forgot) {
      outcome.gone = { ...step.forgot, frames: [] };
      // A card went: whatever comes next isn't the card the junk reads were pieces of.
      this.junk = [];
      // A card that seems only moved may be read again as itself: keep how sure it was counted as.
      if (!step.forgot.moved) this.counted = null;
    }
    outcome.timings.detect = this.clock() - started;
    if (!best) return this.note(started, frame, outcome, null, false);

    const card = warped!;
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
    if (!recognize || !quality.ok) return this.note(started, frame, outcome, quality.issues, false);
    this.note(started, frame, outcome, quality.issues, true);
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
      if (counted) this.counted = { nameConfidence: 0, confidence: 0, accepted: false };
      outcome.read = {
        recognition: unreadable(card, quality, recognition?.timings ?? {}),
        card,
        counted,
        why: counted ? null : (this.session.lastSameCard ?? 'same card'),
        gaveUp: true,
        trigger,
        distance,
        frames,
        ...(counted ? this.numbered(best.corners, true) : {}),
      };
      return outcome;
    }
    this.trail = [];
    outcome.phase = 'read';
    // The read's own stages; its detection at full size is timed as `read-detect`.
    for (const [stage, ms] of Object.entries(recognition.timings)) outcome.timings[stage === 'detect' ? 'read-detect' : stage] = ms;
    // A card that only looked different (glare, foil shimmer, the flashlight) is the card already counted.
    const counted = this.session.settle(signature, best.corners, identityOf(recognition));
    // The same card read much more surely than it was counted as: it stands in for that read.
    const sure = surenessOf(recognition);
    const upgrade = !counted && this.counted !== null && muchSurer(this.counted, sure);
    if (counted || upgrade) this.counted = sure;
    const junk = sure.nameConfidence < JUNK_NAME && sure.confidence < JUNK_CONFIDENCE && !sure.accepted;
    outcome.read = {
      recognition,
      card: recognition.card ?? card,
      counted,
      why: counted ? null : (this.session.lastSameCard ?? 'same card'),
      gaveUp: false,
      trigger,
      distance,
      frames,
      ...(upgrade ? { upgrade: true as const } : {}),
      ...(counted || upgrade ? this.numbered(best.corners, junk) : {}),
    };
    return outcome;
  }

  /**
   * Numbers a counted read (or one standing in for the read before), and
   * either remembers it as junk or finds the junk reads it stands in for.
   */
  private numbered(corners: Quad, junk: boolean): Pick<LiveRead, 'seq' | 'supersedes'> {
    const seq = (this.reads += 1);
    const now = this.clock();
    this.junk = this.junk.filter((entry) => now - entry.at <= JUNK_WINDOW_MS);
    if (junk) {
      this.junk = [...this.junk, { seq, corners, at: now }].slice(-JUNK_KEPT);
      return { seq };
    }
    const pieces = this.junk.filter((entry) => pieceOf(entry.corners, corners));
    this.junk = this.junk.filter((entry) => !pieces.includes(entry));
    return pieces.length > 0 ? { seq, supersedes: pieces.map((entry) => entry.seq) } : { seq };
  }

  /**
   * Keeps what the session made of this frame for the next read's trail, and
   * reports a quiet spell when nothing has been read for `QUIET_MS`. `decided`:
   * this frame is read (or dismissed), which ends any quiet spell.
   */
  private note(now: number, frame: RgbaImage, outcome: LiveFrame, issues: QualityIssue[] | null, decided: boolean): LiveFrame {
    const ms = this.lastFrameAt === null ? 0 : Math.round(now - this.lastFrameAt);
    this.lastFrameAt = now;
    const entry: TrailFrame = { ms, ...this.session.lastFrame, phase: outcome.phase, light: meanLight(frame), ...(issues?.length ? { issues } : {}) };
    this.trail = [...this.trail, entry].slice(-TRAIL_FRAMES);
    if (outcome.gone) outcome.gone.frames = this.trail;
    // Frames stopped for a while (the camera was off): a quiet spell starts afresh.
    if (decided || this.quietSince === null || ms > QUIET_MS) {
      this.quiet = decided ? [] : [entry];
      this.idle = decided ? [] : [entry];
      this.quietSince = now;
      if (decided) {
        this.lastReadAt = now;
        this.quietSpells = 0;
      }
      return outcome;
    }
    this.quiet = [...this.quiet, entry].slice(-TRAIL_FRAMES);
    this.idle = [...this.idle, entry].slice(-QUIET_KEPT);
    const since = now - this.quietSince;
    const spell = this.quietSpells < QUIET_SPELLS ? since >= QUIET_MS : since >= QUIET_SUMMARY_MS;
    if (spell) {
      outcome.quiet = {
        ms: Math.round(now - (this.lastReadAt ?? this.quietSince)),
        frames: this.quiet,
        ...(this.quietSpells >= QUIET_SPELLS ? { summary: summarize(this.idle) } : {}),
      };
      this.quiet = [];
      this.idle = [];
      this.quietSince = now;
      this.quietSpells += 1;
    }
    return outcome;
  }

  /** Count identical copies put on top (a Scan setting; off by default). */
  setCountCopies(on: boolean): void {
    this.session.setCountCopies(on);
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
