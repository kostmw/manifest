import { distance, type Quad } from './geometry';

export interface StabilityOptions {
  /** Consecutive steady frames needed before recognizing. */
  frames: number;
  /** Largest corner movement between frames, as a share of the card's diagonal. */
  tolerance: number;
}

export const DEFAULT_STABILITY: StabilityOptions = { frames: 3, tolerance: 0.02 };

export interface StabilityState {
  /** Frames in a row in which a card was seen and barely moved. */
  steadyFrames: number;
  stable: boolean;
}

/**
 * Outlines a frame is compared with: the frame before, and the one or two
 * before that. Detection can flip between two or three outlines of one card a
 * few percent apart (the card's edge, its frame line, a sleeve), every frame:
 * in round 9's log 15% of frames moved 6–10% of the diagonal while the card
 * lay there ("0.07 0 0 0.08 0 0 0.07"), and a card that never counts as steady
 * is never read, nor checked for a new card put on top. A card sliding in is
 * far from all of them.
 */
const RECENT_OUTLINES = 3;
/**
 * Frames without an outline that don't end a steady run: an outline that
 * comes back where it was counts on from before the gap. Round 10: a foil
 * under the flashlight was found on 1 frame in 7–10, never 2 in a row, and lay
 * 10 s unread. A card that left and a new one put down elsewhere still start
 * over, and one put down in the same spot is as good as lying there.
 */
const MAX_GAP = 8;

/** Live mode recognizes a card only once it has stopped moving. Pure apart from its own memory. */
export class StabilityTracker {
  /** The latest outlines, newest last. */
  private recent: Quad[] = [];
  private steady = 0;
  /** Frames without an outline since the last one. */
  private gap = 0;

  constructor(private readonly options: StabilityOptions = DEFAULT_STABILITY) {}

  update(corners: Quad | null): StabilityState {
    if (!corners) {
      this.gap += 1;
      if (this.gap > MAX_GAP) this.reset();
      return { steadyFrames: 0, stable: false };
    }
    const diagonal = Math.max(distance(corners[0], corners[2]), distance(corners[1], corners[3]));
    const near = (other: Quad) => Math.max(...corners.map((corner, i) => distance(corner, other[i]!))) <= diagonal * this.options.tolerance;
    this.steady = this.recent.some(near) ? this.steady + 1 : 1;
    this.recent = [...this.recent, corners].slice(-RECENT_OUTLINES);
    this.gap = 0;
    return { steadyFrames: this.steady, stable: this.steady >= this.options.frames };
  }

  reset(): void {
    this.recent = [];
    this.steady = 0;
    this.gap = 0;
  }
}
