/**
 * Quick confirm: which waiting reviews look right (the top guess, confirmed
 * with one tap for the lot) and which need a look one by one. Most reviews
 * aren't wrong, only a little below the auto-accept bar.
 *
 * Measured on the owner's labelled logs (rounds 7–10, 67 accepted reviews):
 * at a name confidence of 0.8 or more the top guess was the exact printing 34
 * times in 34; at 0.5–0.8 8 in 13; below 0.5 8 in 20. The exceptions are
 * printings: two reviews at 0.90 and 0.95 were a foil full-art Plains TRK 307
 * guessed as Plains SLD 359, which the owner discarded. So a row whose
 * printing is in doubt looks right only when something settles it.
 */
import type { Printing } from '../games/types';
import type { PrintingCandidate } from '../recognize/identify';
import type { ReviewItem } from '../session/types';

/** Name confidence from which a review may look right. */
export const LOOKS_RIGHT_NAME = 0.8;
/** Below this share of the name's confidence, the printing (not the name) is in doubt: look-alike printings split it. */
const PRINTING_SURE = 0.9;
/** Artwork this close (of 128 bits) to the top guess: a low name confidence is worth one tap to check first. */
const ART_CLOSE = 26;

export type Group = 'looks-right' | 'needs-look';

export interface Placement {
  group: Group;
  /** The printing that would be added: the one the user set, or the top guess. */
  printing: Printing | null;
  /** The printing was in doubt (look-alike printings): show its set and number large. */
  printingInDoubt: boolean;
  /** What settled a doubted printing, when something did. */
  settledBy: 'lock-number' | 'collector' | 'only-in-lock' | 'user' | null;
  /** The top guess's name has no printing in the locked sets. */
  outsideLock: boolean;
  /** In "needs a look", but the collector line read cleanly or the artwork is close: check these first, the guess preselected. */
  quick: boolean;
}

/**
 * The collector line read set and number cleanly for this candidate. A loose
 * digit guess scores 1.1 with the set (a clean read 1.6), and a match zeroed
 * for contradicting the art keeps its verdicts at a score of 0 (QA M2).
 */
const CLEAN_COLLECTOR_SCORE = 1.5;
const cleanCollector = (candidate: PrintingCandidate | undefined) =>
  candidate?.collector?.number === 'exact' && candidate.collector.set === 'exact' && candidate.collector.score >= CLEAN_COLLECTOR_SCORE;
/**
 * The number read cleanly for this candidate, whatever the set: 1 alone, 1.35
 * with a close set; a loose guess scores half, a zeroed match 0. With the set
 * read exactly, only a clean read (1.6) counts.
 */
const cleanNumber = (candidate: PrintingCandidate | undefined) => {
  const match = candidate?.collector;
  if (match?.number !== 'exact') return false;
  return match.set === 'exact' ? match.score >= CLEAN_COLLECTOR_SCORE : match.score >= 1;
};
/** Below this name confidence a read named nothing; a printing set from a banner doesn't make it look right (QA L-f). */
const BANNER_NAME = 0.5;
const closeArt = (candidate: PrintingCandidate | undefined) => candidate?.hashDistance !== null && candidate?.hashDistance !== undefined && candidate.hashDistance <= ART_CLOSE;

/**
 * Where a review goes. `locked` are the sets the review was scanned under,
 * expanded as the game's lock expands them (MTG adds token sets).
 */
export function placeReview(review: ReviewItem, locked: ReadonlySet<string>): Placement {
  const top = review.candidates[0];
  const outsideLock = review.reason === 'outside-lock';
  const base = { outsideLock, quick: false };
  if (review.chosen) {
    // The user set the printing: confirmed, unless they also marked it wrong.
    return { ...base, group: review.markedWrong ? 'needs-look' : 'looks-right', printing: review.chosen, printingInDoubt: true, settledBy: 'user' };
  }
  if (!top || review.reason === 'unreadable') return { ...base, group: 'needs-look', printing: top?.printing ?? null, printingInDoubt: false, settledBy: null };
  const printing = top.printing;
  if (review.markedWrong) return { ...base, group: 'needs-look', printing, printingInDoubt: false, settledBy: null };
  if (review.nameConfidence < LOOKS_RIGHT_NAME) {
    return { ...base, group: 'needs-look', printing, printingInDoubt: false, settledBy: null, quick: cleanCollector(top) || closeArt(top) };
  }
  const printingConfidence = review.nameConfidence > 0 ? review.confidence / review.nameConfidence : 0;
  const printingInDoubt = review.reason === 'unsure-printing' || printingConfidence < PRINTING_SURE;
  if (!printingInDoubt) return { ...base, group: 'looks-right', printing, printingInDoubt, settledBy: null };
  // Basics and look-alike printings: only something beyond the artwork settles which one it is.
  const inLock = locked.size > 0 ? review.candidates.filter((candidate) => candidate.printing.name === printing.name && locked.has(candidate.printing.set)) : [];
  const settledBy: Placement['settledBy'] =
    // The lock's number lookup only settles the printing when the number read is this printing's (QA M1).
    review.trace?.includes('lock:number-lookup') && locked.has(printing.set) && cleanNumber(top)
      ? 'lock-number'
      : cleanCollector(top)
        ? 'collector'
        : inLock.length === 1 && inLock[0] === top
          ? 'only-in-lock'
          : null;
  return { ...base, group: settledBy ? 'looks-right' : 'needs-look', printing, printingInDoubt, settledBy };
}

export interface PlacedReview {
  review: ReviewItem;
  placement: Placement;
}

/** Copies next to each other: by name, then set, then collector number. */
function byPrinting(a: PlacedReview, b: PlacedReview): number {
  const pa = a.placement.printing;
  const pb = b.placement.printing;
  return (
    (pa?.name ?? '￿').localeCompare(pb?.name ?? '￿') ||
    (pa?.set ?? '').localeCompare(pb?.set ?? '') ||
    (pa?.number ?? '').localeCompare(pb?.number ?? '', undefined, { numeric: true }) ||
    a.review.createdAt.localeCompare(b.review.createdAt)
  );
}

/**
 * The waiting reviews in two lists. "Looks right" sorted so copies sit
 * together; "needs a look" with the quick ones (a clean collector line or
 * close artwork) first, each list then by printing.
 */
export function groupReviews(reviews: readonly ReviewItem[], lockedFor: (review: ReviewItem) => ReadonlySet<string>): { looksRight: PlacedReview[]; needsLook: PlacedReview[] } {
  const placed = reviews.map((review) => ({ review, placement: placeReview(review, lockedFor(review)) }));
  const looksRight = placed.filter((entry) => entry.placement.group === 'looks-right').sort(byPrinting);
  const needsLook = placed
    .filter((entry) => entry.placement.group === 'needs-look')
    .sort((a, b) => Number(b.placement.quick) - Number(a.placement.quick) || byPrinting(a, b));
  return { looksRight, needsLook };
}

/**
 * "Use <printing> for all N <name>" offers: for each name the user just chose
 * a printing for, the other waiting reviews whose best guess is that name and
 * whose printing isn't settled yet. Never rows the user marked wrong.
 */
export function bannerTargets(reviews: readonly ReviewItem[], name: string, printing: Printing, marked: ReadonlySet<string> = new Set()): ReviewItem[] {
  return reviews.filter(
    (review) => !review.markedWrong && !marked.has(review.id) && review.nameConfidence >= BANNER_NAME && review.names[0] === name && review.chosen?.id !== printing.id,
  );
}
