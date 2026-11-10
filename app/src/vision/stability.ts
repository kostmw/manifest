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

/** Live mode recognizes a card only once it has stopped moving. Pure apart from its own memory. */
export class StabilityTracker {
  private previous: Quad | null = null;
  private steady = 0;

  constructor(private readonly options: StabilityOptions = DEFAULT_STABILITY) {}

  update(corners: Quad | null): StabilityState {
    if (!corners) {
      this.reset();
      return { steadyFrames: 0, stable: false };
    }
    const previous = this.previous;
    this.previous = corners;
    if (!previous) {
      this.steady = 1;
    } else {
      const diagonal = Math.max(distance(corners[0], corners[2]), distance(corners[1], corners[3]));
      const moved = Math.max(...corners.map((corner, i) => distance(corner, previous[i]!)));
      this.steady = moved <= diagonal * this.options.tolerance ? this.steady + 1 : 1;
    }
    return { steadyFrames: this.steady, stable: this.steady >= this.options.frames };
  }

  reset(): void {
    this.previous = null;
    this.steady = 0;
  }
}
