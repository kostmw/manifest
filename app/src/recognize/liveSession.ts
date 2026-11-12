import { distance, type Quad } from '../vision/geometry';
import { DEFAULT_STABILITY, StabilityTracker, type StabilityOptions } from '../vision/stability';
import { popcount32 } from './fingerprint';

/**
 * Where the card in view is up to:
 * - `empty`: no card in view.
 * - `settling`: a card, still moving.
 * - `reading`: steady, and being read (or about to be, or tried again after a failed read).
 * - `read`: this card has been read; the next one is read once it is placed on top or this one leaves.
 */
export type LivePhase = 'empty' | 'settling' | 'reading' | 'read';

export interface LiveStep {
  steadyFrames: number;
  /** Recognize this frame: the card has stopped moving and hasn't been read yet. */
  recognize: boolean;
  phase: LivePhase;
  /**
   * The card read last may have been covered by another: the caller should
   * fingerprint the card in view and ask `changed()` whether it is new.
   */
  checkCard: boolean;
}

/** Reads of one card that may fail (an error, no usable reading) before live mode gives up on it. */
export const MAX_READ_ATTEMPTS = 3;
/**
 * Fingerprint distance (of 128 bits) beyond which the card in view is another
 * card. The same card from one frame to the next stays well under 10;
 * different cards are around 60.
 */
export const NEW_CARD_DISTANCE = 24;
/**
 * The card read last counts as disturbed (a hand placing the next card on top)
 * when it leaves view, or its outline moves this share of its diagonal from
 * where it was read. Nudging a card moves it less.
 */
export const DISTURBED_SHARE = 0.1;

export function signatureDistance(a: Uint32Array, b: Uint32Array): number {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) sum += popcount32(a[i]! ^ b[i]!);
  return sum;
}

/**
 * Live-mode bookkeeping. A card is read once it has been steady for a few
 * frames, and then not again until another card takes its place (placed on
 * top, or after this one leaves the frame), or the user asks for another try.
 * A card whose reads keep failing is given up on after a few tries, so live
 * mode never sits on "Reading" forever.
 *
 * Cards are usually stacked: the next one is put on top of the last, so the
 * frame never empties. A different card shows as a different fingerprint. An
 * identical copy looks the same, so it counts only once the user has said a
 * next card is coming (`arm`, from "Scan next card") and something has
 * disturbed the view since: two copies count as two, a card that just lies
 * there or is nudged counts once.
 */
export class LiveSession {
  private readonly tracker: StabilityTracker;
  private read = false;
  private missing = 0;
  private failures = 0;
  private readSignature: Uint32Array | null = null;
  private readCorners: Quad | null = null;
  private disturbed = false;
  private armed = false;

  constructor(
    private readonly stability: StabilityOptions = DEFAULT_STABILITY,
    /** Frames without a card before it counts as gone. */
    private readonly emptyFrames = 3,
    private readonly maxAttempts = MAX_READ_ATTEMPTS,
  ) {
    this.tracker = new StabilityTracker(stability);
  }

  next(corners: Quad | null): LiveStep {
    if (!corners) {
      this.missing += 1;
      if (this.read) this.disturbed = true;
      if (this.missing >= this.emptyFrames) this.forget();
      this.tracker.update(null);
      return { steadyFrames: 0, recognize: false, phase: this.read ? 'read' : 'empty', checkCard: false };
    }
    this.missing = 0;
    const { steadyFrames, stable } = this.tracker.update(corners);
    if (this.read && this.readCorners && moved(this.readCorners, corners) > DISTURBED_SHARE) this.disturbed = true;
    const phase: LivePhase = this.read ? 'read' : steadyFrames >= this.stability.frames - 1 ? 'reading' : 'settling';
    return { steadyFrames, recognize: stable && !this.read, phase, checkCard: stable && this.read };
  }

  /**
   * Whether the steady card in view (its fingerprint, or null when there are
   * no fingerprints) is a new one rather than the card read last. A new card
   * is read on this frame.
   */
  changed(signature: Uint32Array | null): boolean {
    if (!this.read) return true;
    const different = signature !== null && this.readSignature !== null && signatureDistance(signature, this.readSignature) > NEW_CARD_DISTANCE;
    const copy = this.armed && this.disturbed;
    if (!different && !copy) return false;
    this.read = false;
    this.failures = 0;
    return true;
  }

  /** The card in view has been read (accepted, sent to review, or given up on). */
  markRead(signature: Uint32Array | null = null, corners: Quad | null = null): void {
    this.read = true;
    this.failures = 0;
    this.readSignature = signature;
    this.readCorners = corners;
    this.disturbed = false;
    this.armed = false;
  }

  /**
   * A read of the card in view failed. Returns true when that was the last
   * try: the caller should report the card as unreadable, and it counts as read.
   */
  failed(signature: Uint32Array | null = null, corners: Quad | null = null): boolean {
    this.failures += 1;
    if (this.failures < this.maxAttempts) return false;
    this.markRead(signature, corners);
    return true;
  }

  /** "Scan next card": the next card placed counts, even an identical copy of the last. */
  arm(): void {
    this.armed = true;
  }

  /** Read the card in view again. */
  again(): void {
    this.read = false;
    this.failures = 0;
    this.armed = false;
    this.disturbed = false;
    this.tracker.reset();
  }

  /** The card has left the frame: whatever comes next is new. */
  private forget(): void {
    this.read = false;
    this.failures = 0;
    this.readSignature = null;
    this.readCorners = null;
    this.disturbed = false;
    this.armed = false;
  }
}

/** The largest corner movement between two outlines, as a share of the first's diagonal. */
function moved(from: Quad, to: Quad): number {
  const diagonal = Math.max(distance(from[0], from[2]), distance(from[1], from[3]));
  return Math.max(...from.map((corner, i) => distance(corner, to[i]!))) / Math.max(1, diagonal);
}
