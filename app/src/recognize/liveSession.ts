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
  /** The card read last was forgotten on this frame (taken for gone), for the test log. */
  forgot?: { card: string | null; moved: boolean };
}

/** What a read said the card is, for telling the card read last from a new one. */
export interface CardIdentity {
  /**
   * The card's name, when the read was at least fairly sure of it, or when its
   * best guess has evidence of its own (the collector line read cleanly, or
   * matching artwork): two reads naming different cards are two cards,
   * however alike they look.
   */
  name: string | null;
  /** The best printing's id, when the read was sure of it. */
  printingId: string | null;
  /** The best printing's id, however unsure the read was of it. */
  guess: string | null;
  /** What lay there wasn't a card at all (an empty box's floor): whatever comes next is another card. */
  junk?: true;
}

export const NO_IDENTITY: CardIdentity = { name: null, printingId: null, guess: null };
const JUNK: CardIdentity = { ...NO_IDENTITY, junk: true };

/**
 * Fingerprints of whatever lies at the given corners of the current frame: one
 * or several looks end to end (see `signatureDistance`). Null when it can't
 * say (no fingerprints, or a picture too blown out or dark to show anything):
 * such a frame neither keeps the card read last nor counts towards it being
 * gone. Live mode uses it to check whether the card read last is still where
 * it was when detection doesn't find it there.
 */
export type SignatureProbe = (corners: Quad) => Uint32Array | null;

/**
 * Whether what lies at the given corners of the current frame is the empty
 * surface the cards are put on (an empty deck box's floor): true, false
 * (a card, a hand, anything else), or null when the picture can't say.
 */
export type EmptyProbe = (corners: Quad) => boolean | null;

/**
 * What to do after a failed read: try again, report the card as unreadable,
 * or nothing: it was the card read last (`same-card`), or no card at all
 * (`no-card`: every try found none).
 */
export type FailedRead = 'retry' | 'report' | 'same-card' | 'no-card';

/**
 * Why the card in view is being read: the first card (or the first after the
 * card read last left), a card that looks different from the one read last,
 * a check after the camera changed (the flashlight), or the user asking.
 */
export type ReadTrigger = 'fresh' | 'different' | 'camera' | 'again' | 'copy';

/** What one frame told the session, for the test log. */
export interface FrameNote {
  /** Detection found an outline. */
  outline: boolean;
  /** How far that outline is from where the card read last lay, as a share of its diagonal. */
  moved: number | null;
  /** Fingerprint distance from the card read last to what lies where it lay, when that was looked at. */
  probe: number | null;
  /** The same for an outline found far from where it lay (`moved` over SAME_SPOT_SHARE), when one was. */
  away?: number | null;
  /** Frames in a row, so far, that showed the card read last gone. */
  gone: number;
  /** After the card read last went: frames in a row that showed the empty surface where it lay (see EmptyProbe). */
  empty?: number;
  /** The camera was still settling after the flashlight changed. */
  hold: boolean;
  /** Steady frames so far: a card is read, or checked against the card read last, once it has been steady for a couple. */
  steady: number;
  /**
   * The check for a new card on top: fingerprint distance from the steady card
   * in view to the closest look of the card read last (a new card needs more
   * than `NEW_CARD_DISTANCE` on two checks in a row). Null when not checked.
   */
  far: number | null;
}

/** Live mode reads a card once it has been steady for this many frames. */
export const LIVE_STABILITY: StabilityOptions = { frames: 2, tolerance: 0.02 };
/** Reads of one card that may fail (an error, no usable reading) before live mode gives up on it. */
export const MAX_READ_ATTEMPTS = 3;
/**
 * Fingerprint distance (of 128 bits) beyond which the card in view may be
 * another card. Different cards are around 50–64 apart; the same card from
 * one frame to the next is usually well under 20, but a flashlight's hotspot
 * moving, or a foil's shimmer, can push it far past this (measured on the
 * owner's round-6 crops of one foil under the flashlight: median 36, p90 48).
 * So passing it only gets the card read again, and the read decides (see `settle`).
 */
export const NEW_CARD_DISTANCE = 24;
/**
 * A card that reads as the same name (or as nothing) is taken for the same
 * physical card when its fingerprint is at most this far from how it looked
 * before, unless both reads were sure of different printings. Two printings
 * of a name with different art (basic lands) are farther apart than this.
 *
 * Also how close what lies where the card lay must be to one of its looks for
 * the card to count as still there (`SignatureProbe`): an empty box or a hand
 * is farther (measured: 6% of empty-box frames within it).
 */
export const SAME_CARD_DISTANCE = 44;
/** Checks in a row that must show a different fingerprint before the card is read again. */
export const DIFFERENT_CHECKS = 2;
/**
 * An outline found within this share of the card's diagonal from where it was
 * read is the card still lying there: a hand-held phone moves the picture that
 * much, and a card put on top lands about there too (then its look decides).
 */
export const SAME_SPOT_SHARE = 0.25;
/**
 * Frames in a row that must show the card read last gone (no outline near its
 * spot, and nothing like it there) before it counts as gone, so that the next
 * card counts whatever it is, an identical copy included. A card taken away,
 * or covered by the hand putting the next one down, is gone for far longer.
 */
export const GONE_FRAMES = 3;
/**
 * Switching the flashlight makes the camera re-expose for about a second (and
 * the tap moves a hand-held phone): meanwhile the card read last can't go,
 * and afterwards it is read again, without counting it if it is the same card.
 */
export const CAMERA_SETTLE_MS = 1500;
/** How many looks of the card in view are kept: glare and foil make one card look several ways. */
const SIGNATURES_KEPT = 12;
/**
 * Frames among those that took the card read last for gone that must still
 * have had an outline (elsewhere in view) for it to count as moved rather than
 * taken away. Round 10's #36: a card slid partly out of frame was found 59%
 * and 110% of its diagonal off, looking too unlike itself there (48–50 bits),
 * so it was forgotten and counted again when it settled.
 */
const MOVED_OUTLINES = 2;
/** How long a moved card is remembered, and frames in a row without any outline that end that sooner (it left). */
const MOVED_MS = 4000;
const MOVED_EMPTY_FRAMES = 2;
/**
 * Frames in a row that must show the empty surface where the card read last
 * lay (`EmptyProbe`) before it has surely left. Until then, the same card read
 * afresh is that card back, not another copy: round 11's re-counts were a hand
 * reaching over a card (lit by the flashlight) or a foil that detection lost,
 * three frames that didn't look like the card, with no empty box in between.
 */
export const EMPTY_FRAMES = 2;
/** Frames in a row without the card read last, and no outline in view, before they count as a cover (copy-on-top). */
const COVER_FRAMES = 2;
/** Outlines of the card read last kept from before a cover, for telling a copy put down from the card shifting. */
const COVER_OUTLINES = 3;
/**
 * Counting an identical copy put on top (off unless switched on): after a
 * cover (frames in which the card read last isn't seen where it lay, as when
 * a hand puts the copy down) shorter than GONE_FRAMES, the card settles again
 * at least this far (a share of its diagonal) from where it lay before.
 */
export const COPY_MOVED = 0.05;

/**
 * Distance between two live signatures. A signature is one fingerprint (4
 * words) or several looks of the card end to end (with its flashlight hotspot
 * painted over, say, or a little to one side): the closest pair of looks counts.
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
 * `camera`: the camera changed in between (the flashlight), so their looks
 * can't be compared, and the same name is enough.
 */
export function sameCard(before: CardIdentity, after: CardIdentity, distance: number, camera = false): boolean {
  if (before.junk || after.junk) return false;
  if (before.name && after.name && before.name !== after.name) return false;
  // Both reads sure of the printing: the printings decide (two Forests from different sets differ).
  if (before.printingId && after.printingId) return before.printingId === after.printingId;
  // Both reads put the same printing first, however unsure: one card under shifting glare.
  if (before.guess && after.guess && before.guess === after.guess) return true;
  if (camera && before.name && after.name) return true;
  return distance <= SAME_CARD_DISTANCE;
}

/** Why `sameCard` took two reads for one card, in words for the test log. */
export function sameCardReason(before: CardIdentity, after: CardIdentity, distance: number, camera = false): string {
  const art = Number.isFinite(distance) ? `artwork ${distance} bits from how it looked before` : 'no fingerprint';
  if (before.printingId && after.printingId) return `same printing (${after.printingId}), ${art}`;
  if (before.guess && after.guess && before.guess === after.guess) return `same best printing (${after.guess}), unsure, ${art}`;
  if (camera && before.name && after.name) return `same name (${after.name}) after the flashlight changed, ${art}`;
  if (before.name && after.name) return `same name (${after.name}), printing unsure, ${art}`;
  return `${after.name ? 'card read last not named' : 'card not named'}, ${art}`;
}

/**
 * Live-mode bookkeeping for continuous scanning: the camera keeps watching
 * while cards are slid in one at a time or stacked. A card is read once it has
 * been steady for a couple of frames, and then not again until another card
 * takes its place, or the user asks for another try. A card whose reads keep
 * failing is given up on after a few tries, so live mode never sits on "Reading".
 *
 * Counting each card once, and every copy:
 * - A card that lies there is counted once, while the phone moves a little,
 *   glare, a flashlight's hotspot and foil shimmer change how it looks, and
 *   detection loses it now and then. It is still there while an outline is
 *   found near where it lay (`SAME_SPOT_SHARE`), or what lies there looks like
 *   it (`SignatureProbe`, within `SAME_CARD_DISTANCE`). A fingerprint that
 *   drifts past `NEW_CARD_DISTANCE` only gets the card read again: if the read
 *   finds the same card (`sameCard`), it isn't counted, and that look is
 *   remembered as one more look of it.
 * - A different card put on top looks different on two checks in a row and
 *   reads as a different card: counted.
 * - The card read last is gone once it isn't there for `GONE_FRAMES` frames in
 *   a row (taken away, covered by a hand, or lost by detection). A different
 *   card read next counts. The same card read next counts only once it had
 *   surely left: the empty surface showed where it lay (`EMPTY_FRAMES`,
 *   `EmptyProbe`); that is how an identical copy counts after the card was
 *   taken away. Otherwise it is that card back, not counted (an identical copy
 *   put straight in its place needs +1). When outlines kept being found while
 *   it went (`MOVED_OUTLINES`), it was moved partly out of view, and is that
 *   card for `MOVED_MS` or until nothing is in view.
 * - With copies counted (`setCountCopies`, off by default), a cover of a
 *   couple of frames (a hand) followed by the card settling `COPY_MOVED` or
 *   more from each of its last places reads it again, and it counts.
 * - The flashlight switching (`cameraChanged`) holds all this while the camera
 *   re-exposes, then reads the card again, as a check.
 */
export class LiveSession {
  private readonly tracker: StabilityTracker;
  private read = false;
  /** Frames in a row without an outline, while no card is read: a card that never got read has left. */
  private missing = 0;
  private failures = 0;
  /** How many of those failures found no card at all. */
  private noCards = 0;
  /** How the card read last has looked, newest last. Empty when there is no card read last. */
  private signatures: Uint32Array[] = [];
  private readCorners: Quad | null = null;
  private identity: CardIdentity = NO_IDENTITY;
  /** A card has been read and hasn't left: there is a card read last to compare with. */
  private known = false;
  /** Frames in a row that showed the card read last gone. */
  private goneRun = 0;
  /** Checks in a row whose fingerprint was far from every look of the card read last. */
  private differentRun = 0;
  private trigger: ReadTrigger = 'fresh';
  /** For a `different` or `camera` read: how far the card in view was from the card read last. */
  private triggerDistance = Number.POSITIVE_INFINITY;
  /** Until when the camera is settling after the flashlight changed (the clock's time). */
  private holdUntil = Number.NEGATIVE_INFINITY;
  /** The flashlight changed while a card was read: check it once the camera has settled. */
  private cameraCheck = false;
  /** During the run of frames that took the card read last for gone, how many had an outline. */
  private goneOutlines = 0;
  /**
   * Since the card in view was last read, a frame didn't show it where it lay
   * (a hand, or another card going down over it): only then can a different
   * card have taken its place without leaving view.
   */
  private disturbed = false;
  /**
   * The card read last, once it was taken for gone, until it has surely left
   * (see EMPTY_FRAMES): the same card read afresh meanwhile is that card, not
   * another copy. `moved`: outlines kept being found while it went (it was
   * moved, partly out of view): then it is remembered for MOVED_MS, or until
   * nothing is in view.
   */
  private left: { identity: CardIdentity; signatures: Uint32Array[]; corners: Quad | null; moved: boolean; until: number; emptyRun: number } | null = null;
  private movedEmpty = 0;
  /** Frames in a row, while the card read last isn't where it lay, that showed the empty surface there. */
  private spotEmpty = 0;
  /** Count an identical copy put on top (see COPY_MOVED). */
  private countCopies = false;
  /** Frames in a row so far that may be a cover (see watchCover). */
  private coverFrames = 0;
  /** The card read last's latest outlines while it lay there, newest last. */
  private recentOutlines: Quad[] = [];
  /** Where the card read last lay when a cover began (its latest outlines), while the cover lasts and until it settles again. */
  private coverFrom: Quad[] | null = null;
  /** The card settled again after a cover, moved: read it as a possible copy at the next check. */
  private copyCheck = false;
  /** Why the last read settled as the card already counted, for the test log. */
  lastSameCard: string | null = null;
  /** What the last frame told the session, for the test log. */
  lastFrame: FrameNote = { outline: false, moved: null, probe: null, gone: 0, hold: false, steady: 0, far: null };

  constructor(
    private readonly stability: StabilityOptions = LIVE_STABILITY,
    /** Frames in a row without the card before it counts as gone. */
    private readonly goneFrames = GONE_FRAMES,
    private readonly maxAttempts = MAX_READ_ATTEMPTS,
    private readonly clock: () => number = () => performance.now(),
  ) {
    this.tracker = new StabilityTracker(stability);
  }

  /** Switch counting identical copies put on top on or off (a Scan setting; off by default). */
  setCountCopies(on: boolean): void {
    this.countCopies = on;
    this.coverFrom = null;
    this.coverFrames = 0;
    this.copyCheck = false;
  }

  /** Why the read now under way was started, and how far the card in view was from the card read last. */
  get readReason(): { trigger: ReadTrigger; distance: number | null } {
    return { trigger: this.trigger, distance: Number.isFinite(this.triggerDistance) ? this.triggerDistance : null };
  }

  /**
   * The distance from what lies at `corners` to the closest look of the card
   * read last; null when there is nothing to look with, `unseen` when the
   * picture there shows nothing either way.
   */
  private probeDistance(probe: SignatureProbe | undefined, corners: Quad | null): number | 'unseen' | null {
    if (!corners || !probe || this.signatures.length === 0) return null;
    const signature = probe(corners);
    return signature === null ? 'unseen' : this.closest(signature);
  }

  next(corners: Quad | null, probe?: SignatureProbe, empty?: EmptyProbe): LiveStep {
    const hold = this.clock() < this.holdUntil;
    const { steadyFrames, stable } = this.tracker.update(corners);
    const moved = corners && this.readCorners ? movedShare(this.readCorners, corners) : null;
    let probed: number | null = null;
    let away: number | null = null;
    let unseen = false;
    if (this.known) {
      // Still there: an outline near its spot (the card, a phone that moved, a card put on top,
      // whose look then decides), or something like it where it lay (its edges lost in glare).
      // Without the spot where it was read, any outline will do.
      let there = this.readCorners ? moved !== null && moved <= SAME_SPOT_SHARE : corners !== null;
      if (!there && this.readCorners && corners) {
        // An outline farther off: the card itself if it looks like it (the phone moved a lot).
        const found = this.probeDistance(probe, corners);
        if (typeof found === 'number') away = found;
        there = away !== null && away <= SAME_CARD_DISTANCE;
      }
      // Follow the card as the phone drifts, so that "near" is measured from where it lies now.
      if (there && corners && this.readCorners) this.readCorners = corners;
      if (!there) {
        const found = this.probeDistance(probe, this.readCorners);
        unseen = found === 'unseen';
        if (typeof found === 'number') probed = found;
        there = typeof found === 'number' && found <= SAME_CARD_DISTANCE;
      } else if (away !== null) {
        probed = away;
      }
      // Whether the empty surface shows where it lay: then, once it is gone, it has surely left.
      if (there || hold) this.spotEmpty = 0;
      else if (this.readCorners && empty) {
        const seen = empty(this.readCorners);
        if (seen !== null) this.spotEmpty = seen ? this.spotEmpty + 1 : 0;
      }
      // A blown-out or black picture shows nothing: it neither keeps the card nor takes it away.
      const goneBefore = this.goneRun;
      this.goneRun = there || hold ? 0 : unseen ? this.goneRun : this.goneRun + 1;
      this.goneOutlines = this.goneRun === 0 ? 0 : this.goneOutlines + (this.goneRun > goneBefore && corners !== null ? 1 : 0);
      if (this.goneRun > goneBefore) this.disturbed = true;
      if (this.countCopies && this.read && !this.identity.junk) this.watchCover(there, corners, stable, unseen);
    }
    this.lastFrame = {
      outline: corners !== null,
      moved: moved === null ? null : Math.round(moved * 100) / 100,
      probe: probed,
      ...(away !== null ? { away } : {}),
      gone: this.goneRun,
      ...(this.known && this.spotEmpty > 0 ? { empty: this.spotEmpty } : {}),
      hold,
      steady: steadyFrames,
      far: null,
    };
    let forgot: LiveStep['forgot'];
    if (this.known && this.goneRun >= this.goneFrames) {
      const wasMoved = this.goneOutlines >= MOVED_OUTLINES && !this.identity.junk;
      forgot = { card: this.identity.name ?? this.identity.guess, moved: wasMoved };
      // Not remembered once the empty surface showed where it lay (it was taken away), unless it moved.
      const leftSurely = !wasMoved && this.spotEmpty >= EMPTY_FRAMES;
      this.left = this.identity.junk || leftSurely
        ? null
        : { identity: this.identity, signatures: this.signatures, corners: this.readCorners, moved: wasMoved, until: wasMoved ? this.clock() + MOVED_MS : Number.POSITIVE_INFINITY, emptyRun: this.spotEmpty };
      this.movedEmpty = 0;
      this.forget();
    } else if (this.left && !this.known) {
      this.watchLeft(corners, empty);
    }

    if (!corners) {
      this.missing = this.known ? 0 : this.missing + 1;
      // A card that never got read (its reads failed, or it was just passing) has left: start afresh.
      if (!this.known && this.missing >= this.goneFrames) this.failures = 0;
      const phaseNow: LivePhase = this.read && !this.identity.junk ? 'read' : this.known && !this.identity.junk ? 'reading' : 'empty';
      return { steadyFrames: 0, recognize: false, phase: phaseNow, checkCard: false, ...(forgot ? { forgot } : {}) };
    }
    this.missing = 0;
    // Something that was no card (an empty box's floor) shows as no card in view.
    const phase: LivePhase = this.read ? (this.identity.junk ? 'empty' : 'read') : steadyFrames >= this.stability.frames - 1 ? 'reading' : 'settling';
    return { steadyFrames, recognize: stable && !this.read, phase, checkCard: stable && this.read && !hold, ...(forgot ? { forgot } : {}) };
  }

  /**
   * After the card read last went: whether it has surely left. A moved card
   * has left once nothing is in view for a couple of frames (or after
   * MOVED_MS); any other once the empty surface shows where it lay for
   * EMPTY_FRAMES frames in a row. Until then the same card read afresh is
   * that card (see settle).
   */
  private watchLeft(corners: Quad | null, empty: EmptyProbe | undefined): void {
    const left = this.left!;
    if (left.moved) {
      // A moved card that then leaves view altogether has left.
      this.movedEmpty = corners ? 0 : this.movedEmpty + 1;
      if (this.movedEmpty >= MOVED_EMPTY_FRAMES || this.clock() > left.until) this.left = null;
      return;
    }
    if (!left.corners) {
      // Nowhere to look: nothing in view for a couple of frames will do.
      left.emptyRun = corners ? 0 : left.emptyRun + 1;
    } else if (corners && movedShare(left.corners, corners) <= SAME_SPOT_SHARE) {
      // Something card-shaped lies where it lay.
      left.emptyRun = 0;
    } else {
      const seen = empty?.(left.corners) ?? null;
      if (seen !== null) left.emptyRun = seen ? left.emptyRun + 1 : 0;
    }
    this.lastFrame = { ...this.lastFrame, empty: left.emptyRun };
    if (left.emptyRun >= EMPTY_FRAMES) this.left = null;
  }

  /**
   * Copy-on-top counting: a cover (COVER_FRAMES frames in a row in which the
   * card read last isn't seen where it lay, nothing else is in view, and the
   * picture shows something: a hand) that ends before the card is gone, then
   * the card settling at least COPY_MOVED from each of its last outlines
   * before the cover, is read as a possible copy. A blown-out frame, or one in
   * which only detection lost a foil, isn't a cover, and an outline flipping
   * between two places it already took isn't a copy (QA M4).
   */
  private watchCover(there: boolean, corners: Quad | null, stable: boolean, unseen: boolean): void {
    if (!there && !corners) {
      if (unseen) return;
      this.coverFrames += 1;
      if (this.coverFrames >= COVER_FRAMES && !this.coverFrom && this.recentOutlines.length > 0) this.coverFrom = this.recentOutlines;
      return;
    }
    if (!this.coverFrom) {
      this.coverFrames = 0;
      if (there && corners) this.recentOutlines = [...this.recentOutlines, corners].slice(-COVER_OUTLINES);
      return;
    }
    if (!there || !corners || !stable) return;
    if (this.coverFrom.every((before) => movedShare(before, corners) >= COPY_MOVED)) this.copyCheck = true;
    this.coverFrom = null;
    this.coverFrames = 0;
    this.recentOutlines = [corners];
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
    const far = signature !== null && this.signatures.length > 0 ? this.closest(signature) : 0;
    this.lastFrame = { ...this.lastFrame, far: signature !== null && this.signatures.length > 0 ? far : null };
    if (this.copyCheck) {
      // Settled again after a cover, moved: maybe an identical copy put on top. Read it; it counts.
      this.copyCheck = false;
      this.trigger = 'copy';
      this.triggerDistance = far;
      this.startRead();
      return true;
    }
    if (this.cameraCheck) {
      // The flashlight changed: a card that doesn't look like any look of the card read last is read again at once.
      this.cameraCheck = false;
      if (far <= NEW_CARD_DISTANCE) return false;
      this.trigger = 'camera';
      this.triggerDistance = far;
      this.startRead();
      return true;
    }
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
   * The camera changed how it sees (the flashlight was switched): for a
   * moment the card read last can't be gone, and afterwards it is checked.
   */
  cameraChanged(): void {
    this.holdUntil = this.clock() + CAMERA_SETTLE_MS;
    this.goneRun = 0;
    this.differentRun = 0;
    if (this.known) this.cameraCheck = true;
  }

  /**
   * The card in view has been read. Returns true when it counts as a new card
   * (and becomes the card read last), false when it is the card read last
   * again, only looking different (glare, shimmer, the flashlight): then this
   * look of it is remembered, so it doesn't get read again for it.
   */
  settle(signature: Uint32Array | null, corners: Quad | null, identity: CardIdentity): boolean {
    const camera = this.trigger === 'camera';
    // A card read afresh after the card read last was taken for gone, before it had surely left
    // (it was moved, or no empty box showed where it lay), that is the same card: it is that card
    // back from under a hand, or a foil detection lost, not another copy. Two reads sure of
    // different printings, or naming one card's different printings that don't look alike, are
    // two cards (QA H2).
    const left = this.left;
    if (this.trigger === 'fresh' && left && !this.known && this.clock() <= left.until) {
      const distance = signature && left.signatures.length > 0 ? Math.min(...left.signatures.map((known) => signatureDistance(signature, known))) : Number.POSITIVE_INFINITY;
      if (sameCard(left.identity, identity, distance)) {
        this.left = null;
        this.markRead(signature, corners, left.identity.name || left.identity.printingId ? left.identity : identity);
        this.signatures = [...left.signatures, ...(signature ? [signature] : [])].slice(-SIGNATURES_KEPT);
        const how = left.moved ? 'moved' : 'back after something covered it, with no empty box seen in between';
        this.lastSameCard = `the card read last, ${how}: ${sameCardReason(left.identity, identity, distance)}`;
        return false;
      }
    }
    // The card read last named nothing and this read names a card: only the same best guess (or a
    // look within NEW_CARD_DISTANCE, which isn't read again at all) makes it that card read better.
    // Otherwise it may be another card put on top, whose read must not stand in for the first
    // card's (QA M5): it counts, and the first stays (a junk read of a piece of this card is
    // taken out by LiveScanner, which knows the outlines).
    // Only after a disturbance (a frame without it where it lay): with none, it is the same card
    // read better, as when the first read of a foil fails (round 11's replay: Obsidian Order
    // Operative, unread and then read, counted twice).
    const namedOverUnnamed = !this.identity.name && !this.identity.printingId && identity.name !== null && this.identity.guess !== identity.guess;
    const tooFar = namedOverUnnamed && this.disturbed && this.triggerDistance > NEW_CARD_DISTANCE;
    if ((this.trigger === 'different' || camera) && !tooFar && sameCard(this.identity, identity, this.triggerDistance, camera)) {
      this.lastSameCard = sameCardReason(this.identity, identity, this.triggerDistance, camera);
      this.read = true;
      this.disturbed = false;
      this.failures = 0;
      if (signature) this.signatures = [...this.signatures, signature].slice(-SIGNATURES_KEPT);
      if (corners) this.readCorners = corners;
      // A surer read of the same card is the better one to compare the next card with.
      const printingId = this.identity.printingId ?? identity.printingId;
      this.identity = { name: this.identity.name ?? identity.name, printingId, guess: printingId ?? this.identity.guess ?? identity.guess };
      this.trigger = 'fresh';
      this.triggerDistance = Number.POSITIVE_INFINITY;
      return false;
    }
    this.markRead(signature, corners, identity);
    return true;
  }

  /**
   * What lies in view isn't a card (an empty box's floor): nothing counts, and
   * it isn't read again while it lies there. A card put there later looks
   * different, is read, and counts.
   */
  dismiss(signature: Uint32Array | null, corners: Quad | null): void {
    this.markRead(signature, corners, JUNK);
  }

  /** The card in view counts as a new card (accepted, sent to review, or given up on). */
  markRead(signature: Uint32Array | null = null, corners: Quad | null = null, identity: CardIdentity = NO_IDENTITY): void {
    this.read = true;
    this.known = true;
    this.left = null;
    this.disturbed = false;
    this.coverFrom = null;
    this.coverFrames = 0;
    this.recentOutlines = corners ? [corners] : [];
    this.copyCheck = false;
    this.goneOutlines = 0;
    this.failures = 0;
    this.signatures = signature ? [signature] : [];
    this.readCorners = corners;
    this.identity = identity;
    this.goneRun = 0;
    this.spotEmpty = 0;
    this.differentRun = 0;
    this.cameraCheck = false;
    this.trigger = 'fresh';
    this.triggerDistance = Number.POSITIVE_INFINITY;
  }

  /**
   * A read of the card in view failed. `retry`: try again on the next steady
   * frame. On the last try, `report`: the caller should report the card as
   * unreadable (it counts as read); or `same-card`: it was only the card read
   * last looking different, so nothing is reported.
   */
  failed(signature: Uint32Array | null = null, corners: Quad | null = null, noCard = false): FailedRead {
    this.failures += 1;
    this.noCards = (this.failures === 1 ? 0 : this.noCards) + (noCard ? 1 : 0);
    if (this.failures < this.maxAttempts) return 'retry';
    if (this.noCards === this.failures) {
      // Every try found no card at all where live mode saw one (a hand passing, part of the box):
      // nothing is reported. A card counted before stays the card read last; otherwise what lies
      // there is remembered as no card, so it isn't read again.
      if (this.known && !this.identity.junk) {
        this.read = true;
        this.failures = 0;
        this.trigger = 'fresh';
        this.triggerDistance = Number.POSITIVE_INFINITY;
      } else {
        this.dismiss(signature, corners);
      }
      return 'no-card';
    }
    return this.settle(signature, corners, NO_IDENTITY) ? 'report' : 'same-card';
  }

  /** Read the card in view again. */
  again(): void {
    this.read = false;
    this.failures = 0;
    this.goneRun = 0;
    this.differentRun = 0;
    this.cameraCheck = false;
    this.trigger = 'again';
    this.triggerDistance = Number.POSITIVE_INFINITY;
    this.tracker.reset();
  }

  /** The card read last has left: whatever comes next is new. */
  private forget(): void {
    this.read = false;
    this.known = false;
    this.failures = 0;
    this.signatures = [];
    this.readCorners = null;
    this.identity = NO_IDENTITY;
    this.goneRun = 0;
    this.spotEmpty = 0;
    this.differentRun = 0;
    this.cameraCheck = false;
    this.trigger = 'fresh';
    this.triggerDistance = Number.POSITIVE_INFINITY;
  }
}


/** The largest corner movement between two outlines, as a share of the first's diagonal. */
function movedShare(from: Quad, to: Quad): number {
  const diagonal = Math.max(distance(from[0], from[2]), distance(from[1], from[3]));
  return Math.max(...from.map((corner, i) => distance(corner, to[i]!))) / Math.max(1, diagonal);
}
