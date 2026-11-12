/**
 * Where a scanned card goes: straight into the batch when the recognizer is
 * sure of the exact printing, else into the review queue. Never dropped.
 */
import { getGame } from '../games/registry';
import type { Printing } from '../games/types';
import type { PrintingCandidate } from '../recognize/identify';
import { addCard } from './batches';
import { queueReview } from './reviews';
import type { Batch, ReviewItem, ReviewReason } from './types';

/** What intake needs from a scan (the worker's ScanResult has all of it). */
export interface ScannedCard {
  decision: 'accept' | 'review' | 'retake' | 'no-card';
  names: string[];
  printings: PrintingCandidate[];
  nameConfidence: number;
  confidence: number;
  titleText: string;
  collectorText: string;
  advice: string[];
  gaveUp: boolean;
  guessedOutline: boolean;
  /** The best printing's name has no printing in the batch's locked sets. */
  outsideLock?: boolean;
  /** The card as scanned, upright, as a JPEG. */
  card: Blob | null;
}

/** Below this name confidence a reading is a guess: the right name is among the candidates only about one time in four. */
export const UNREADABLE_BELOW = 0.5;
/** What the recognizer's auto-accept goes by; see recognize/pipeline.ts. */
const SURE = 0.9;

export type IntakeDecision = { kind: 'add'; printing: Printing } | { kind: 'review'; reason: ReviewReason };

export function decideIntake(scan: Omit<ScannedCard, 'card' | 'titleText' | 'collectorText' | 'advice'>): IntakeDecision {
  const best = scan.printings[0];
  if (scan.decision === 'accept' && best && !scan.outsideLock) return { kind: 'add', printing: best.printing };
  if (scan.gaveUp || scan.names.length === 0) return { kind: 'review', reason: 'unreadable' };
  if (scan.outsideLock) return { kind: 'review', reason: 'outside-lock' };
  if (scan.nameConfidence < SURE) return { kind: 'review', reason: 'unsure-name' };
  if (!best || scan.confidence < SURE) return { kind: 'review', reason: 'unsure-printing' };
  return { kind: 'review', reason: 'check' };
}

export type IntakeOutcome =
  | { kind: 'added'; itemId: string; printing: Printing; finish: string }
  | { kind: 'review'; review: ReviewItem };

export async function intake(batch: Batch, scan: ScannedCard, source: ReviewItem['source']): Promise<IntakeOutcome> {
  const decision = decideIntake(scan);
  const foil = batch.settings.foil === true;
  if (decision.kind === 'add') {
    const finish = getGame(batch.game).defaultFinish(decision.printing, foil);
    const itemId = await addCard(batch, decision.printing, { finish });
    return { kind: 'added', itemId, printing: decision.printing, finish };
  }
  const review = await queueReview({
    batchId: batch.id,
    source,
    ...(scan.card ? { crop: await scan.card.arrayBuffer() } : {}),
    names: scan.names,
    candidates: scan.printings,
    nameConfidence: scan.nameConfidence,
    confidence: scan.confidence,
    titleText: scan.titleText,
    collectorText: scan.collectorText,
    advice: scan.advice,
    reason: decision.reason,
    foil,
    lang: batch.settings.defaultLang,
    condition: batch.settings.defaultCondition,
    qty: 1,
  });
  return { kind: 'review', review };
}
