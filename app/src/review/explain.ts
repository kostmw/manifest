/** Words for what the recognizer found, shared by the scanner and the review queue. */
import type { PrintingCandidate } from '../recognize/identify';
import { ADVICE_HINTS, type QualityAdvice } from '../vision/quality';

/** Why a printing was picked, in a few words. */
export function matchNote(candidate: PrintingCandidate): string {
  const parts: string[] = [];
  const collector = candidate.collector;
  if (collector?.number === 'exact' && (collector.set === 'exact' || collector.set === 'close')) parts.push('collector number and set match');
  else if (collector?.number === 'exact') parts.push('collector number matches');
  else if (collector?.set === 'exact') parts.push('set matches');
  if (candidate.hashDistance !== null && candidate.hashDistance <= 14) parts.push('artwork matches');
  if (parts.length === 0 && candidate.title >= 0.8) parts.push('name matches');
  return parts.join(', ');
}

/** What to try when a card couldn't be read, from what the quality gate noticed. */
export function unreadableHint(advice: readonly string[]): string {
  const has = (what: QualityAdvice) => advice.includes(what);
  if (has('hotspot')) return ADVICE_HINTS.hotspot;
  if (has('tilted') && has('dim')) return `${ADVICE_HINTS.tilted} ${ADVICE_HINTS.dim}`;
  if (has('tilted')) return ADVICE_HINTS.tilted;
  if (has('dim')) return `${ADVICE_HINTS.dim} Turn on a lamp or the flashlight.`;
  return 'Try more light, or hold the phone flatter, straight above the card.';
}

/** "CMM 410". */
export function printingCode(printing: { set: string; number: string }): string {
  return `${printing.set.toUpperCase()} ${printing.number}`;
}
