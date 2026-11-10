import { describe, expect, it } from 'vitest';
import { computeMetrics, isPrintingTwin, metricsByTag, quadError, quantile, thresholdSweep, type EvalOutcome } from './metrics';
import { createRng, placedCorners, randomParams, seedFrom } from './synthesize';

function outcome(expected: string, predicted: string[], overrides: Partial<EvalOutcome> = {}): EvalOutcome {
  return {
    file: `${expected}.jpg`,
    expectedName: expected,
    tags: ['modern'],
    detected: true,
    qualityOk: true,
    qualityIssues: [],
    decision: 'review',
    predicted,
    confidence: 0.5,
    ocrText: expected,
    latencyMs: 100,
    ...overrides,
  };
}

describe('computeMetrics', () => {
  const outcomes = [
    outcome('A', ['A'], { decision: 'accept', confidence: 0.95, latencyMs: 50 }),
    outcome('B', ['C', 'B'], { decision: 'accept', confidence: 0.92, latencyMs: 150 }),
    outcome('D', ['E'], { latencyMs: 250, tags: ['old-frame'] }),
    outcome('F', [], { detected: false, decision: 'no-card', latencyMs: 20, tags: ['old-frame'] }),
  ];

  it('scores names, accepts and latency', () => {
    expect(computeMetrics(outcomes)).toMatchObject({
      cards: 4,
      detected: 0.75,
      located: null,
      top1Name: 0.25,
      top5Name: 0.5,
      autoAccepted: 0.5,
      wrongAutoAccepts: 1,
      autoAcceptPrecision: 0.5,
      wrongAutoAcceptRate: 0.25,
      reviewRate: 0.5,
      latencyP50: 100,
    });
  });

  it('breaks results down by tag', () => {
    const byTag = metricsByTag(outcomes);
    expect(byTag['old-frame']?.cards).toBe(2);
    expect(byTag['modern']?.top1Name).toBe(0.5);
  });

  it('shows what each auto-accept threshold would have let through', () => {
    const [loose, strict] = thresholdSweep(outcomes, [0.9, 0.93]);
    expect(loose).toMatchObject({ acceptRate: 0.5, wrong: 1 });
    expect(strict).toMatchObject({ acceptRate: 0.25, wrong: 0 });
  });
});

describe('printing metrics', () => {
  const outcomes = [
    outcome('A', ['A'], { expectedId: 'a1', predictedIds: ['a1', 'a2'], decision: 'accept', confidence: 0.95 }),
    outcome('B', ['B'], { expectedId: 'b1', predictedIds: ['b2', 'b1'], topIsTwin: true, decision: 'accept', confidence: 0.92 }),
    outcome('C', ['C'], { expectedId: 'c1', predictedIds: ['c2'] }),
  ];

  it('judge auto-accepts on the exact printing, and count twins separately', () => {
    expect(computeMetrics(outcomes)).toMatchObject({
      top1Name: 1,
      top1Printing: 1 / 3,
      top1PrintingOrTwin: 2 / 3,
      top5Printing: 2 / 3,
      wrongAutoAccepts: 1,
      wrongNameAccepts: 0,
    });
  });

  it('are null for a names-only run', () => {
    expect(computeMetrics([outcome('A', ['A'])]).top1Printing).toBeNull();
  });
});

describe('isPrintingTwin', () => {
  const p = (set: string, number: string, name = 'X') => ({ name, set, number });
  it('pairs a set\'s printing with its promos and List reprint', () => {
    expect(isPrintingTwin(p('ltr', '166'), p('pltr', '166s'))).toBe(true);
    expect(isPrintingTwin(p('war', '137'), p('plst', 'WAR-137'))).toBe(true);
    expect(isPrintingTwin(p('pwar', '137p'), p('pwar', '137s'))).toBe(true);
  });
  it('keeps other printings apart', () => {
    expect(isPrintingTwin(p('ltr', '166'), p('ltr', '166'))).toBe(false);
    expect(isPrintingTwin(p('ltr', '166'), p('ltr', '617'))).toBe(false);
    expect(isPrintingTwin(p('c15', '122'), p('c16', '122'))).toBe(false);
    expect(isPrintingTwin(p('ltr', '166'), p('pltr', '166s', 'Y'))).toBe(false);
  });
});

describe('quantile', () => {
  it('interpolates', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBe(0);
  });
});

describe('quadError', () => {
  it("doesn't care which corner the detection starts from", () => {
    const truth = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 14 },
      { x: 0, y: 14 },
    ];
    const turned = [truth[2]!, truth[3]!, truth[0]!, { x: 10, y: 1 }];
    expect(quadError(turned, truth)).toBeCloseTo(1);
  });
});

describe('synthetic photos', () => {
  it('are the same for the same seed, and keep the card inside the frame', () => {
    const a = randomParams(createRng(seedFrom('card-1')), 488 / 680);
    const b = randomParams(createRng(seedFrom('card-1')), 488 / 680);
    expect(a).toEqual(b);
    for (const corner of placedCorners(a, { width: 488, height: 680 })) {
      expect(corner.x).toBeGreaterThanOrEqual(0);
      expect(corner.x).toBeLessThanOrEqual(a.frame.width);
      expect(corner.y).toBeGreaterThanOrEqual(0);
      expect(corner.y).toBeLessThanOrEqual(a.frame.height);
    }
  });
});
