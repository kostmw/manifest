import type { Quad } from '../vision/geometry';
import { DEFAULT_STABILITY, StabilityTracker, type StabilityOptions } from '../vision/stability';

/**
 * Where the card in view is up to:
 * - `empty`: no card in view.
 * - `settling`: a card, still moving.
 * - `reading`: steady, and being read (or about to be, or tried again after a failed read).
 * - `read`: this card has been read; the next one is read once it has left the frame.
 */
export type LivePhase = 'empty' | 'settling' | 'reading' | 'read';

export interface LiveStep {
  steadyFrames: number;
  /** Recognize this frame: the card has stopped moving and hasn't been read yet. */
  recognize: boolean;
  phase: LivePhase;
}

/** Reads of one card that may fail (an error, no usable reading) before live mode gives up on it. */
export const MAX_READ_ATTEMPTS = 3;

/**
 * Live-mode bookkeeping. A card is read once it has been steady for a few
 * frames, and then not again until it has left the frame (or the user asks
 * for another try), so a card that stays in view counts once. A card whose
 * reads keep failing is given up on after a few tries, so live mode never
 * sits on "Reading" forever. Full continuous-mode dedupe comes with M4.
 */
export class LiveSession {
  private readonly tracker: StabilityTracker;
  private read = false;
  private missing = 0;
  private failures = 0;

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
      if (this.missing >= this.emptyFrames) {
        this.read = false;
        this.failures = 0;
      }
      this.tracker.update(null);
      return { steadyFrames: 0, recognize: false, phase: this.read ? 'read' : 'empty' };
    }
    this.missing = 0;
    const { steadyFrames, stable } = this.tracker.update(corners);
    const phase: LivePhase = this.read ? 'read' : steadyFrames >= this.stability.frames - 1 ? 'reading' : 'settling';
    return { steadyFrames, recognize: stable && !this.read, phase };
  }

  /** The card in view has been read (accepted or sent to review). */
  markRead(): void {
    this.read = true;
    this.failures = 0;
  }

  /**
   * A read of the card in view failed. Returns true when that was the last
   * try: the caller should report the card as unreadable (which marks it read).
   */
  failed(): boolean {
    this.failures += 1;
    if (this.failures < this.maxAttempts) return false;
    this.markRead();
    return true;
  }

  /** Read the card in view again. */
  again(): void {
    this.read = false;
    this.failures = 0;
    this.tracker.reset();
  }
}
