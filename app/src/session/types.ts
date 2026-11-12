import type { GameId, Printing } from '../games/types';
import type { PrintingCandidate } from '../recognize/identify';

export interface BatchSettings {
  defaultLang: string;
  defaultCondition: string;
  /**
   * Scanning: only printings from these sets (the data source's lower-case
   * codes) are considered. Missing or empty means any set.
   */
  lockSets?: string[];
  /** Scanning: every card is foil (where its printing comes in foil). */
  foil?: boolean;
}

export interface Batch {
  id: string;
  game: GameId;
  name: string;
  location?: string;
  /** ISO timestamp. */
  createdAt: string;
  settings: BatchSettings;
}

export interface BatchItem {
  id: string;
  batchId: string;
  /** A copy, so that a batch still exports correctly after the index changes or while offline. */
  printing: Printing;
  finish: string;
  lang: string;
  condition: string;
  qty: number;
  /** ISO timestamp. */
  addedAt: string;
  /** Printing + finish + language + condition. Adding a card with the same key raises its quantity. */
  mergeKey: string;
}

/** Why a scanned card waits for review instead of going straight into the batch. */
export type ReviewReason =
  /** Nothing usable was read. */
  | 'unreadable'
  /** The name is a guess. */
  | 'unsure-name'
  /** The name is sure, the printing isn't. */
  | 'unsure-printing'
  /** The card isn't from the batch's locked sets. */
  | 'outside-lock'
  /** Confident, but the photo was poor or the card's edges were guessed. */
  | 'check';

/** A scanned card waiting for the user to confirm what it is. Never dropped without their say. */
export interface ReviewItem {
  id: string;
  batchId: string;
  /** ISO timestamp. */
  createdAt: string;
  source: 'live' | 'photo' | 'file';
  /** The card as scanned, upright, as JPEG bytes. */
  crop?: ArrayBuffer;
  /** Card names, best first. */
  names: string[];
  /** Exact printings, best first, with what each signal said. */
  candidates: PrintingCandidate[];
  nameConfidence: number;
  confidence: number;
  titleText: string;
  collectorText: string;
  /** What the quality gate said might have made the card hard to read. */
  advice: string[];
  reason: ReviewReason;
  /** What the batch's settings asked for when the card was scanned. */
  foil: boolean;
  lang: string;
  condition: string;
  qty: number;
}
