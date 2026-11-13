import { distance, type Quad } from '../vision/geometry';
import { StabilityTracker, type StabilityOptions } from '../vision/stability';
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

/** What a read said the card is, for telling the card read last from a new one. */
export interface CardIdentity {
  /** The best name, when the read was at least fairly sure of it. */
  name: string | null;
  /** The best printing's id, when the read was sure of it. */
  printingId: string | null;
}

export const NO_IDENTITY: CardIdentity = { name: null, printingId: null };

/**
 * The fingerprint of whatever lies at the given corners of the current frame,
 * or null when there are no fingerprints. Live mode uses it to check whether
 * the card read last is still where it was when detection loses it.
 */
export type SignatureProbe = (corners: Quad) => Uint32Array | null;

/** What to do after a failed read: try again, report the card as unreadable, or nothing (it was the card read last). */
export type FailedRead = 'retry' | 'report' | 'same-card';

/** Live mode reads a card once it has been steady for this many frames. */
export const LIVE_STABILITY: StabilityOptions = { frames: 2, tolerance: 0.02 };
/** Reads of one card that may fail (an error, no usable reading) before live mode gives up on it. */
export const MAX_READ_ATTEMPTS = 3;
/**
 * Fingerprint distance (of 128 bits) beyond which the card in view may be
 * another card. Different cards are around 50–64 apart; the same card from
 * one frame to the next is usually well under 20, but a flashlight's hotspot
 * moving a little, or a foil's shimmer, can push it past this (measured: a
 * hotspot shifted 15 px, p90 26; strong foil shimmer, p90 44). So passing it
 * only gets the card read again, and the read decides (see `settle`).
 */
export const NEW_CARD_DISTANCE = 24;
/**
 * A card that reads as the same name (or as nothing) is taken for the same
 * physical card when its fingerprint is at most this far from how it looked
 * before, unless both reads were sure of different printings. Two printings
 * of a name with different art (basic lands) are farther apart than this.
 */
export const SAME_CARD_DISTANCE = 44;
/** Checks in a row that must show a different fingerprint before the card is read again. */
export const DIFFERENT_CHECKS = 2;
/**
 * The card read last counts as disturbed (a hand placing the next card on top)
 * when it leaves its spot, or its outline moves this share of its diagonal from
 * where it was read. Nudging a card moves it less.
 */
export const DISTURBED_SHARE = 0.1;
/**
 * Frames in a row that must show the card gone or moved before it counts as
 * disturbed. A hand putting a card down takes far longer than that.
 */
export const DISTURBED_FRAMES = 2;
/** How many looks of the card in view are kept: glare and foil make one card look several ways. */
const SIGNATURES_KEPT = 12;

/**
 * Distance between two live signatures. A signature is one fingerprint (4
 * words) or several looks of the card end to end (with its flashlight hotspot
 * painted over, say): the closest pair of looks counts.
 */
export function signatureDistance(a: Uint32Array, b: Uint32Array): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 4 <= a.length; i += 4) {
    for (let j = 0; j + 4 <= b.length; j += 4) {
      const d = popcount32(a[i]! ^ b[j]!) + popcount32(a[i + 1]! ^ b[j + 1]!) + popcount32(a[i + 2]! ^ b[j + 2]!) + popcount32(a[i + 3]! ^ b[j + 3]!);
      if (d < best) best = d;
    }
  }
  return Number.isFinite(best) ? best : 0;
}

/**
 * Whether two reads are of the same physical card, given how far apart their
 * fingerprints are (the second's distance to the closest look of the first).
 */
export function sameCard(before: CardIdentity, after: CardIdentity, distance: number): boolean {
  if (before.name && after.name && before.name !== after.name) return false;
  // Both reads sure of the printing: the printings decide (two Forests from different sets differ).
  if (before.printingId && after.printingId) return before.printingId === after.printingId;
  return distance <= SAME_CARD_DISTANCE;
}

/**
 * Live-mode bookkeeping for continuous scanning: the camera keeps watching
 * while cards are slid in one at a time or stacked. A card is read once it has
 * been steady for a couple of frames, and then not again until another card
 * takes its place, or the user asks for another try. A card whose reads keep
 * failing is given up on after a few tries, so live mode never sits on "Reading".
 *
 * Counting each card once, and every copy:
 * - A card that lies there is counted once. Glare, a flashlight's hotspot and
 *   foil shimmer change how it looks from frame to frame, and detection can
 *   lose it for a moment. So when detection loses it, the spot where it lay is
 *   checked (`SignatureProbe`): if the card still looks the same there, it
 *   hasn't gone. And a fingerprint that drifts past `NEW_CARD_DISTANCE` only
 *   gets the card read again: if the read finds the same card (`sameCard`),
 *   it isn't counted, and that look is remembered as one more look of it.
 * - A different card put on top looks different on two checks in a row and
 *   reads as a different card: counted.
 * - An identical copy counts once the card was really disturbed (gone from
 *   its spot, or covered, for a few frames in a row) and then settles again.
 * - A card that really leaves view is forgotten: whatever comes next is new.
 */
export class LiveSession {
  private readonly tracker: StabilityTracker;
  private read = false;
  private missing = 0;
  private failures = 0;
  /** How the card read last has looked, newest last. */
  private signatures: Uint32Array[] = [];
  private readCorners: Quad | null = null;
  private identity: CardIdentity = NO_IDENTITY;
  /** Frames in a row in which the card read last was gone or moved away. */
  private disturbedRun = 0;
  private disturbed = false;
  /** Checks in a row whose fingerprint was far from every look of the card read last. */
  private differentRun = 0;
  /** Why the card in view is being read: the first card, a copy after a disturbance, or a different-looking card. */
  private trigger: 'fresh' | 'copy' | 'different' = 'fresh';
  /** For a `different` read: how far the card in view was from the card read last. */
  private triggerDistance = Number.POSITIVE_INFINITY;

  constructor(
    private readonly stability: StabilityOptions = LIVE_STABILITY,
    /** Frames without a card before it counts as gone. */
    private readonly emptyFrames = 3,
    private readonly maxAttempts = MAX_READ_ATTEMPTS,
  ) {
    this.tracker = new StabilityTracker(stability);
  }

  /**
   * The card read last is still where it was, though detection doesn't see it
   * there (or sees something else). Also while it is being read again.
   */
  private stillThere(probe: SignatureProbe | undefined): boolean {
    if (!this.readCorners || !probe || this.signatures.length === 0) return false;
    const signature = probe(this.readCorners);
    return signature !== null && this.closest(signature) <= NEW_CARD_DISTANCE;
  }

  next(corners: Quad | null, probe?: SignatureProbe): LiveStep {
    if (!corners) {
      this.tracker.update(null);
      if (this.stillThere(probe)) {
        // Glare or shimmer hid the card's edges; it hasn't gone anywhere.
        this.missing = 0;
        this.disturbedRun = 0;
        return { steadyFrames: 0, recognize: false, phase: this.read ? 'read' : 'reading', checkCard: false };
      }
      this.missing += 1;
      this.noteDisturbance(true);
      if (this.missing >= this.emptyFrames) this.forget();
      return { steadyFrames: 0, recognize: false, phase: this.read ? 'read' : 'empty', checkCard: false };
    }
    this.missing = 0;
    const { steadyFrames, stable } = this.tracker.update(corners);
    const away = this.read && this.readCorners !== null && moved(this.readCorners, corners) > DISTURBED_SHARE && !this.stillThere(probe);
    this.noteDisturbance(away);
    const phase: LivePhase = this.read ? 'read' : steadyFrames >= this.stability.frames - 1 ? 'reading' : 'settling';
    return { steadyFrames, recognize: stable && !this.read, phase, checkCard: stable && this.read };
  }

  private noteDisturbance(away: boolean): void {
    if (!this.read) return;
    this.disturbedRun = away ? this.disturbedRun + 1 : 0;
    if (this.disturbedRun >= DISTURBED_FRAMES) this.disturbed = true;
  }

  private closest(signature: Uint32Array): number {
    let best = Number.POSITIVE_INFINITY;
    for (const known of this.signatures) best = Math.min(best, signatureDistance(signature, known));
    return best;
  }

  /**
   * Whether the steady card in view (its fingerprint, or null when there are
   * no fingerprints) may be a new one rather than the card read last. When it
   * may, it is read on this frame, and `settle` decides whether it counts.
   */
  changed(signature: Uint32Array | null): boolean {
    if (!this.read) {
      this.trigger = 'fresh';
      return true;
    }
    if (this.disturbed) {
      this.trigger = 'copy';
      this.startRead();
      return true;
    }
    const far = signature !== null && this.signatures.length > 0 ? this.closest(signature) : 0;
    if (far <= NEW_CARD_DISTANCE) {
      this.differentRun = 0;
      return false;
    }
    this.differentRun += 1;
    if (this.differentRun < DIFFERENT_CHECKS) return false;
    this.trigger = 'different';
    this.triggerDistance = far;
    this.startRead();
    return true;
  }

  private startRead(): void {
    this.read = false;
    this.failures = 0;
    this.differentRun = 0;
  }

  /**
   * The card in view has been read. Returns true when it counts as a new card
   * (and becomes the card read last), false when it is the card read last
   * again, only looking different (glare, shimmer): then this look of it is
   * remembered, so it doesn't get read again for it.
   */
  settle(signature: Uint32Array | null, corners: Quad | null, identity: CardIdentity): boolean {
    if (this.trigger === 'different' && sameCard(this.identity, identity, this.triggerDistance)) {
      this.read = true;
      this.failures = 0;
      if (signature) this.signatures = [...this.signatures, signature].slice(-SIGNATURES_KEPT);
      if (corners) this.readCorners = corners;
      // A surer read of the same card is the better one to compare the next card with.
      this.identity = { name: this.identity.name ?? identity.name, printingId: this.identity.printingId ?? identity.printingId };
      return false;
    }
    this.markRead(signature, corners, identity);
    return true;
  }

  /** The card in view counts as a new card (accepted, sent to review, or given up on). */
  markRead(signature: Uint32Array | null = null, corners: Quad | null = null, identity: CardIdentity = NO_IDENTITY): void {
    this.read = true;
    this.failures = 0;
    this.signatures = signature ? [signature] : [];
    this.readCorners = corners;
    this.identity = identity;
    this.disturbedRun = 0;
    this.disturbed = false;
    this.differentRun = 0;
    this.trigger = 'fresh';
    this.triggerDistance = Number.POSITIVE_INFINITY;
  }

  /**
   * A read of the card in view failed. `retry`: try again on the next steady
   * frame. On the last try, `report`: the caller should report the card as
   * unreadable (it counts as read); or `same-card`: it was only the card read
   * last looking different, so nothing is reported.
   */
  failed(signature: Uint32Array | null = null, corners: Quad | null = null): FailedRead {
    this.failures += 1;
    if (this.failures < this.maxAttempts) return 'retry';
    return this.settle(signature, corners, NO_IDENTITY) ? 'report' : 'same-card';
  }

  /** Read the card in view again. */
  again(): void {
    this.read = false;
    this.failures = 0;
    this.disturbedRun = 0;
    this.disturbed = false;
    this.differentRun = 0;
    this.trigger = 'fresh';
    this.tracker.reset();
  }

  /** The card has left the frame: whatever comes next is new. */
  private forget(): void {
    this.read = false;
    this.failures = 0;
    this.signatures = [];
    this.readCorners = null;
    this.identity = NO_IDENTITY;
    this.disturbedRun = 0;
    this.disturbed = false;
    this.differentRun = 0;
    this.trigger = 'fresh';
  }
}

/** The largest corner movement between two outlines, as a share of the first's diagonal. */
function moved(from: Quad, to: Quad): number {
  const diagonal = Math.max(distance(from[0], from[2]), distance(from[1], from[3]));
  return Math.max(...from.map((corner, i) => distance(corner, to[i]!))) / Math.max(1, diagonal);
}
