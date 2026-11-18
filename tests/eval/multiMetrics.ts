/**
 * Scoring for photos with several cards (binder pages, table spreads): which
 * outline found which card, and what was read from it. Pure, so it can be
 * tested and the PR numbers trusted.
 */
import { applyHomography, homography, type Point } from '../../app/src/vision/geometry';
import { quantile } from './metrics';

/** A card read from the photo: where, and what. */
export interface MultiRead {
  corners: Point[];
  decision: 'accept' | 'review' | 'retake' | 'no-card';
  names: string[];
  printingIds: string[];
  confidence: number;
}

export interface TruthCard {
  id: string;
  name: string;
  tags: string[];
  corners: Point[];
  /** Share of the card inside the photo. */
  visible: number;
}

/** Below this share inside the photo, a card is "partial": it may be read, but must never be auto-added. */
export const PARTIAL_BELOW = 0.7;

function inside(polygon: readonly Point[], p: Point): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** Share of quad `a` (sampled on a grid in its own coordinates) that lies inside polygon `b`. */
export function coverage(a: readonly Point[], b: readonly Point[], steps = 16): number {
  const unit = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const map = homography(unit, a);
  if (!map) return 0;
  let hits = 0;
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      if (inside(b, applyHomography(map, (i + 0.5) / steps, (j + 0.5) / steps))) hits++;
    }
  }
  return hits / (steps * steps);
}

/** The same card: each outline mostly inside the other. */
const SAME = 0.6;
/** An outline counts as covering a card when it holds this much of it. */
const HOLDS = 0.5;
/** An outline counts as lying on a card when this much of it is on the card. */
const ON = 0.7;
/** An outline this little on any card lies on none: a phantom. */
const PHANTOM = 0.3;

export interface PhotoScore {
  /** For each truth card: the read matched to it, if any. */
  matched: (MultiRead | null)[];
  /** Reads over two or more cards. */
  merged: number;
  /** Cards with two or more reads on parts of them, none of which is the card. */
  split: number;
  /** Reads on no card. */
  phantom: number;
  /** Two reads matched to one card: it would be counted twice. */
  duplicate: number;
  /** Auto-accepted reads that put a wrong card in the batch: wrong printing, a phantom, merged, a duplicate. */
  wrongAccepts: number;
  /** Auto-accepted reads of partial cards (right or wrong). */
  partialAccepts: number;
}

export function scorePhoto(truth: readonly TruthCard[], reads: readonly MultiRead[]): PhotoScore {
  const cover = reads.map((read) => truth.map((card) => ({ ofRead: coverage(read.corners, card.corners), ofCard: coverage(card.corners, read.corners) })));
  const matched: (MultiRead | null)[] = truth.map(() => null);
  const matchedBy: number[] = truth.map(() => -1);
  let merged = 0;
  let phantom = 0;
  let duplicate = 0;
  let wrongAccepts = 0;
  let partialAccepts = 0;
  const readCard: (number | null)[] = reads.map(() => null);

  reads.forEach((read, r) => {
    const fits = cover[r]!;
    const holds = fits.filter((fit) => fit.ofCard >= HOLDS).length;
    const best = fits.reduce((top, fit, t) => (fit.ofRead * fit.ofCard > (fits[top]?.ofRead ?? 0) * (fits[top]?.ofCard ?? 0) ? t : top), 0);
    const bestFit = fits[best];
    if (holds >= 2) merged++;
    else if (!bestFit || Math.max(...fits.map((fit) => fit.ofRead)) < PHANTOM) phantom++;
    else if (bestFit.ofRead >= SAME && bestFit.ofCard >= SAME) {
      if (matchedBy[best]! >= 0) duplicate++;
      else {
        matched[best] = read;
        matchedBy[best] = r;
      }
      readCard[r] = best;
    }
    if (read.decision !== 'accept') return;
    const card = readCard[r] ?? null;
    if (card === null || matchedBy[card] !== r) {
      wrongAccepts++;
      return;
    }
    if (truth[card]!.visible < PARTIAL_BELOW) partialAccepts++;
    if (read.printingIds[0] !== truth[card]!.id) wrongAccepts++;
  });

  // Split: a card no read matched, with two or more reads lying mostly on it.
  let split = 0;
  truth.forEach((_, t) => {
    if (matched[t]) return;
    if (reads.filter((_, r) => cover[r]![t]!.ofRead >= ON && cover[r]![t]!.ofCard < SAME).length >= 2) split++;
  });

  return { matched, merged, split, phantom, duplicate, wrongAccepts, partialAccepts };
}

export interface CardOutcome {
  photo: string;
  card: TruthCard;
  read: MultiRead | null;
}

export interface MultiMetrics {
  photos: number;
  /** Cards at least PARTIAL_BELOW inside the photo. */
  cards: number;
  partialCards: number;
  /** Shares of `cards`. */
  found: number;
  top1Name: number;
  top1Printing: number;
  autoAccepted: number;
  wrongAccepts: number;
  partialAccepts: number;
  merged: number;
  split: number;
  phantom: number;
  duplicate: number;
  msPerPhotoP50: number;
  msPerPhotoP95: number;
}

export function multiMetrics(photos: readonly { outcomes: CardOutcome[]; score: PhotoScore; ms: number }[]): MultiMetrics {
  const whole = photos.flatMap((photo) => photo.outcomes.filter((o) => o.card.visible >= PARTIAL_BELOW));
  const share = (count: number) => (whole.length ? count / whole.length : 0);
  const sum = (key: 'merged' | 'split' | 'phantom' | 'duplicate' | 'wrongAccepts' | 'partialAccepts') => photos.reduce((total, photo) => total + photo.score[key], 0);
  return {
    photos: photos.length,
    cards: whole.length,
    partialCards: photos.reduce((total, photo) => total + photo.outcomes.filter((o) => o.card.visible < PARTIAL_BELOW).length, 0),
    found: share(whole.filter((o) => o.read).length),
    top1Name: share(whole.filter((o) => o.read?.names[0] === o.card.name).length),
    top1Printing: share(whole.filter((o) => o.read?.printingIds[0] === o.card.id).length),
    autoAccepted: share(whole.filter((o) => o.read?.decision === 'accept').length),
    wrongAccepts: sum('wrongAccepts'),
    partialAccepts: sum('partialAccepts'),
    merged: sum('merged'),
    split: sum('split'),
    phantom: sum('phantom'),
    duplicate: sum('duplicate'),
    msPerPhotoP50: quantile(
      photos.map((photo) => photo.ms),
      0.5,
    ),
    msPerPhotoP95: quantile(
      photos.map((photo) => photo.ms),
      0.95,
    ),
  };
}

/** Found, name and printing for the cards with a tag (photo-level tags included). */
export function cardsByTag(outcomes: readonly (CardOutcome & { photoTags: string[] })[]) {
  const tags = new Set(outcomes.flatMap((o) => [...o.card.tags, ...o.photoTags]));
  const rows: Record<string, { cards: number; found: number; top1Name: number; top1Printing: number; accepted: number }> = {};
  for (const tag of [...tags].sort()) {
    const subset = outcomes.filter((o) => o.card.visible >= PARTIAL_BELOW && (o.card.tags.includes(tag) || o.photoTags.includes(tag)));
    if (subset.length === 0) continue;
    const share = (count: number) => count / subset.length;
    rows[tag] = {
      cards: subset.length,
      found: share(subset.filter((o) => o.read).length),
      top1Name: share(subset.filter((o) => o.read?.names[0] === o.card.name).length),
      top1Printing: share(subset.filter((o) => o.read?.printingIds[0] === o.card.id).length),
      accepted: share(subset.filter((o) => o.read?.decision === 'accept').length),
    };
  }
  return rows;
}
