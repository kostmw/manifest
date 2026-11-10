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
  predicted: string[];
  confidence: number;
  ocrText: string;
  latencyMs: number;
}

export interface Metrics {
  cards: number;
  detected: number;
  /** Share of cards with known corners whose quad was found in the right place; null when none are known. */
  located: number | null;
  qualityPassed: number;
  top1Name: number;
  top5Name: number;
  autoAccepted: number;
  wrongAutoAccepts: number;
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

export function computeMetrics(outcomes: readonly EvalOutcome[]): Metrics {
  const cards = outcomes.length;
  const share = (count: number) => (cards ? count / cards : 0);
  const accepted = outcomes.filter((outcome) => outcome.decision === 'accept');
  const wrong = accepted.filter((outcome) => !isTop1(outcome)).length;
  const latencies = outcomes.map((outcome) => outcome.latencyMs);
  const withTruth = outcomes.filter((outcome) => outcome.locatedCorrectly !== undefined);
  return {
    cards,
    detected: share(outcomes.filter((outcome) => outcome.detected).length),
    located: withTruth.length ? withTruth.filter((outcome) => outcome.locatedCorrectly).length / withTruth.length : null,
    qualityPassed: share(outcomes.filter((outcome) => outcome.qualityOk).length),
    top1Name: share(outcomes.filter(isTop1).length),
    top5Name: share(outcomes.filter(isTop5).length),
    autoAccepted: share(accepted.length),
    wrongAutoAccepts: wrong,
    autoAcceptPrecision: accepted.length ? (accepted.length - wrong) / accepted.length : 1,
    wrongAutoAcceptRate: share(wrong),
    reviewRate: share(cards - accepted.length),
    latencyP50: quantile(latencies, 0.5),
    latencyP95: quantile(latencies, 0.95),
  };
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

export function formatMetricsRow(label: string, m: Metrics): string {
  return [
    label.padEnd(18),
    String(m.cards).padStart(4),
    percent(m.detected).padStart(7),
    (m.located === null ? '–' : percent(m.located)).padStart(7),
    percent(m.top1Name).padStart(7),
    percent(m.top5Name).padStart(7),
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
    const wrong = accepted.filter((o) => !isTop1(o)).length;
    return {
      threshold,
      acceptRate: outcomes.length ? accepted.length / outcomes.length : 0,
      wrong,
      wrongRate: outcomes.length ? wrong / outcomes.length : 0,
    };
  });
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
