import type { Quad } from '../vision/geometry';
import { DEFAULT_STABILITY, StabilityTracker, type StabilityOptions } from '../vision/stability';

export interface LiveStep {
  steadyFrames: number;
  /** Recognize this frame: the card has stopped moving and hasn't been read yet. */
  recognize: boolean;
}

/**
 * Live-mode bookkeeping. A card is read once it has been steady for a few
 * frames, and then not again until it has left the frame (or the user asks
 * for another try), so a card that stays in view counts once. Full
 * continuous-mode dedupe comes with M4.
 */
export class LiveSession {
  private readonly tracker: StabilityTracker;
  private read = false;
  private missing = 0;

  constructor(
    stability: StabilityOptions = DEFAULT_STABILITY,
    /** Frames without a card before it counts as gone. */
    private readonly emptyFrames = 3,
  ) {
    this.tracker = new StabilityTracker(stability);
  }

  next(corners: Quad | null): LiveStep {
    if (!corners) {
      this.missing += 1;
      if (this.missing >= this.emptyFrames) this.read = false;
      this.tracker.update(null);
      return { steadyFrames: 0, recognize: false };
    }
    this.missing = 0;
    const { steadyFrames, stable } = this.tracker.update(corners);
    return { steadyFrames, recognize: stable && !this.read };
  }

  /** The card in view has been read (accepted or sent to review). */
  markRead(): void {
    this.read = true;
  }

  /** Read the card in view again. */
  again(): void {
    this.read = false;
    this.tracker.reset();
  }
}
