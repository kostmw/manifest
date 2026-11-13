/** Eval scoring. Pure, so the numbers in a PR description can be trusted and tested. */

export interface EvalOutcome {
  file: string;
  expectedName: string;
  tags: string[];
  detected: boolean;
  /** Detected quad within 3% of the card's width of the truth, when the truth is known. */
  locatedCorrectly?: boolean;
  qualityOk: boolean;
  qualityIssues: string[];
  decision: 'accept' | 'review' | 'retake' | 'no-card';
  /** Names, best first. */
  predicted: string[];
  /** What auto-accept goes by: the printing's confidence when printings were identified, else the name's. */
  confidence: number;
  ocrText: string;
  latencyMs: number;
  /** The labelled printing, when known. */
  expectedId?: string;
  /** Printing ids, best first; absent when the run identified names only. */
  predictedIds?: string[];
  nameConfidence?: number;
  /** The collector line as OCR read it. */
  collectorText?: string;
  /** How the collector reading fitted the labelled printing. */
  collectorNumber?: 'exact' | 'conflict' | 'unread';
  collectorSet?: 'exact' | 'close' | 'conflict' | 'unread';
  /** "SET number" of the labelled printing and of the predicted ones, for reading the summary. */
  expectedLabel?: string;
  predictedLabels?: string[];
  /** The top printing isn't the labelled one, but its promo or List twin (see isPrintingTwin). */
  topIsTwin?: boolean;
  /** The quality gate's measurements of the chosen outline, for tuning its thresholds. */
  quality?: { sharpness: number; brightness: number; cardGlare: number; titleGlare: number; cardWidth: number };
}

export interface Metrics {
  cards: number;
  detected: number;
  /** Share of cards with known corners whose quad was found in the right place; null when none are known. */
  located: number | null;
  qualityPassed: number;
  top1Name: number;
  top5Name: number;
  /** Null when no outcome has printings to judge. */
  top1Printing: number | null;
  top5Printing: number | null;
  /**
   * Top-1 printing, also counting a promo or List twin of the right printing
   * (same name and printed number, same art): what nothing but a stamp or a
   * small symbol tells apart.
   */
  top1PrintingOrTwin: number | null;
  autoAccepted: number;
  /** Auto-accepts that are wrong: the wrong printing when printings were identified, else the wrong name. */
  wrongAutoAccepts: number;
  /** Auto-accepts with the wrong name, a subset of wrongAutoAccepts. */
  wrongNameAccepts: number;
  /** Correct auto-accepts ÷ auto-accepts. 1 when nothing was auto-accepted. */
  autoAcceptPrecision: number;
  /** Wrong auto-accepts ÷ cards: the number the ≤ 0.5% goal is about. */
  wrongAutoAcceptRate: number;
  /** Cards not auto-accepted ÷ cards. */
  reviewRate: number;
  latencyP50: number;
  latencyP95: number;
}

export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
}

export const isTop1 = (outcome: EvalOutcome) => outcome.predicted[0] === outcome.expectedName;
export const isTop5 = (outcome: EvalOutcome) => outcome.predicted.slice(0, 5).includes(outcome.expectedName);
export const hasPrintings = (outcome: EvalOutcome) => outcome.predictedIds !== undefined && outcome.expectedId !== undefined;
export const isTop1Printing = (outcome: EvalOutcome) => hasPrintings(outcome) && outcome.predictedIds![0] === outcome.expectedId;
export const isTop5Printing = (outcome: EvalOutcome) =>
  hasPrintings(outcome) && outcome.predictedIds!.slice(0, 5).includes(outcome.expectedId!);
/** What an auto-accept is judged by: the exact printing when there is one to judge, else the name. */
export const isCorrect = (outcome: EvalOutcome) => (hasPrintings(outcome) ? isTop1Printing(outcome) : isTop1(outcome));

export function computeMetrics(outcomes: readonly EvalOutcome[]): Metrics {
  const cards = outcomes.length;
  const share = (count: number) => (cards ? count / cards : 0);
  const accepted = outcomes.filter((outcome) => outcome.decision === 'accept');
  const wrong = accepted.filter((outcome) => !isCorrect(outcome)).length;
  const latencies = outcomes.map((outcome) => outcome.latencyMs);
  const withTruth = outcomes.filter((outcome) => outcome.locatedCorrectly !== undefined);
  const withPrintings = outcomes.filter(hasPrintings);
  const printingShare = (test: (outcome: EvalOutcome) => boolean) =>
    withPrintings.length ? withPrintings.filter(test).length / withPrintings.length : null;
  return {
    cards,
    detected: share(outcomes.filter((outcome) => outcome.detected).length),
    located: withTruth.length ? withTruth.filter((outcome) => outcome.locatedCorrectly).length / withTruth.length : null,
    qualityPassed: share(outcomes.filter((outcome) => outcome.qualityOk).length),
    top1Name: share(outcomes.filter(isTop1).length),
    top5Name: share(outcomes.filter(isTop5).length),
    top1Printing: printingShare(isTop1Printing),
    top5Printing: printingShare(isTop5Printing),
    top1PrintingOrTwin: printingShare((outcome) => isTop1Printing(outcome) || outcome.topIsTwin === true),
    autoAccepted: share(accepted.length),
    wrongAutoAccepts: wrong,
    wrongNameAccepts: accepted.filter((outcome) => !isTop1(outcome)).length,
    autoAcceptPrecision: accepted.length ? (accepted.length - wrong) / accepted.length : 1,
    wrongAutoAcceptRate: share(wrong),
    reviewRate: share(cards - accepted.length),
    latencyP50: quantile(latencies, 0.5),
    latencyP95: quantile(latencies, 0.95),
  };
}

/**
 * Two printings of a card that differ only by a stamp or symbol: a set's own
 * printing and its promo ("ltr" 166 and "pltr" 166s), or a List reprint of it
 * ("plst" "LTR-166"). Same name, same printed number, same printed set code.
 */
export function isPrintingTwin(a: { name: string; set: string; number: string }, b: { name: string; set: string; number: string }): boolean {
  if (a.name !== b.name || (a.set === b.set && a.number === b.number)) return false;
  const printed = (p: { set: string; number: string }) => {
    const list = /^([a-z0-9]+)-(\d+)/i.exec(p.number);
    if (p.set === 'plst' && list) return { set: list[1]!.toLowerCase(), number: String(Number(list[2])) };
    const set = /^p[a-z0-9]{3}$/.test(p.set) ? p.set.slice(1) : p.set;
    return { set, number: String(Number(/\d+/.exec(p.number)?.[0] ?? NaN)) };
  };
  const x = printed(a);
  const y = printed(b);
  return x.set === y.set && x.number === y.number && x.number !== 'NaN';
}

/** Metrics for every tag, and for the subset CLAUDE.md's accuracy goals are about. */
export function metricsByTag(outcomes: readonly EvalOutcome[]): Record<string, Metrics> {
  const tags = new Set(outcomes.flatMap((outcome) => outcome.tags));
  const result: Record<string, Metrics> = {};
  for (const tag of [...tags].sort()) result[tag] = computeMetrics(outcomes.filter((o) => o.tags.includes(tag)));
  return result;
}

/** Well-lit, unsleeved, English, modern: the conditions the accuracy goals are stated for. */
export const isGoalCondition = (outcome: EvalOutcome) => outcome.tags.includes('modern') && outcome.tags.includes('clean');

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const maybePercent = (value: number | null) => (value === null ? '–' : percent(value));

export function formatMetricsRow(label: string, m: Metrics): string {
  return [
    label.padEnd(18),
    String(m.cards).padStart(4),
    percent(m.detected).padStart(7),
    maybePercent(m.located).padStart(7),
    percent(m.top1Name).padStart(7),
    percent(m.top5Name).padStart(7),
    maybePercent(m.top1Printing).padStart(7),
    maybePercent(m.top1PrintingOrTwin).padStart(7),
    maybePercent(m.top5Printing).padStart(7),
    percent(m.autoAccepted).padStart(7),
    percent(m.autoAcceptPrecision).padStart(7),
    String(m.wrongAutoAccepts).padStart(5),
    `${m.latencyP50.toFixed(0)}/${m.latencyP95.toFixed(0)}`.padStart(10),
  ].join(' ');
}

export const METRICS_HEADER = [
  'subset'.padEnd(18),
  'n'.padStart(4),
  'detect'.padStart(7),
  'located'.padStart(7),
  'top1'.padStart(7),
  'top5'.padStart(7),
  'p-top1'.padStart(7),
  'p+twin'.padStart(7),
  'p-top5'.padStart(7),
  'accept'.padStart(7),
  'prec'.padStart(7),
  'wrong'.padStart(5),
  'p50/p95ms'.padStart(10),
].join(' ');

/**
 * What each auto-accept threshold would have done: the share of cards it lets
 * through and how many of those are wrong. Only cards that passed the quality
 * gate can be auto-accepted, as in the app.
 */
export function thresholdSweep(outcomes: readonly EvalOutcome[], thresholds: readonly number[]) {
  return thresholds.map((threshold) => {
    const accepted = outcomes.filter((o) => o.qualityOk && o.predicted.length > 0 && o.confidence >= threshold);
    const wrong = accepted.filter((o) => !isCorrect(o)).length;
    return {
      threshold,
      acceptRate: outcomes.length ? accepted.length / outcomes.length : 0,
      wrong,
      wrongName: accepted.filter((o) => !isTop1(o)).length,
      wrongRate: outcomes.length ? wrong / outcomes.length : 0,
    };
  });
}

/** How each signal did on its own, for the outcomes that have a labelled printing. */
export function signalStats(outcomes: readonly EvalOutcome[]) {
  const judged = outcomes.filter((o) => o.collectorNumber !== undefined);
  const share = (count: number) => (judged.length ? count / judged.length : 0);
  return {
    cards: judged.length,
    collectorAnyRead: share(judged.filter((o) => o.collectorNumber !== 'unread' || o.collectorSet !== 'unread').length),
    collectorNumberRight: share(judged.filter((o) => o.collectorNumber === 'exact').length),
    collectorSetRight: share(judged.filter((o) => o.collectorSet === 'exact').length),
    collectorSetClose: share(judged.filter((o) => o.collectorSet === 'close').length),
    collectorBothRight: share(judged.filter((o) => o.collectorNumber === 'exact' && o.collectorSet === 'exact').length),
  };
}

/** Largest corner distance between two quads, whichever corner each starts from. */
export function quadError(found: readonly { x: number; y: number }[], truth: readonly { x: number; y: number }[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const direction of [1, -1]) {
    for (let shift = 0; shift < 4; shift++) {
      let worst = 0;
      for (let i = 0; i < 4; i++) {
        const t = truth[(((shift + direction * i) % 4) + 4) % 4]!;
        worst = Math.max(worst, Math.hypot(found[i]!.x - t.x, found[i]!.y - t.y));
      }
      best = Math.min(best, worst);
    }
  }
  return best;
}
