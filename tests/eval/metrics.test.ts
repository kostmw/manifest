import { describe, expect, it } from 'vitest';
import { computeMetrics, metricsByTag, quadError, quantile, thresholdSweep, type EvalOutcome } from './metrics';
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
