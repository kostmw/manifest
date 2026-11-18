import { describe, expect, it } from 'vitest';
import { coverage, multiMetrics, scorePhoto, type MultiRead, type TruthCard } from './multiMetrics';

const box = (x: number, y: number, w = 63, h = 88) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

const card = (id: string, x: number, y: number, visible = 1): TruthCard => ({ id, name: id.toUpperCase(), tags: [], corners: box(x, y), visible });
const read = (corners: { x: number; y: number }[], id: string, decision: MultiRead['decision'] = 'accept'): MultiRead => ({
  corners,
  decision,
  names: [id.toUpperCase()],
  printingIds: [id],
  confidence: 0.95,
});

describe('coverage', () => {
  it('measures how much of one outline lies inside another', () => {
    expect(coverage(box(0, 0), box(0, 0))).toBe(1);
    expect(coverage(box(0, 0), box(200, 0))).toBe(0);
    expect(coverage(box(0, 0, 100, 100), box(0, 0, 50, 100))).toBeCloseTo(0.5, 1);
  });
});

describe('scorePhoto', () => {
  const truth = [card('a', 0, 0), card('b', 66, 0), card('c', 132, 0)];

  it('matches each read to its card and judges what was accepted', () => {
    const score = scorePhoto(truth, [read(box(1, 1), 'a'), read(box(66, 0), 'x'), read(box(133, 0), 'c', 'review')]);
    expect(score.matched.map((m) => m?.printingIds[0] ?? null)).toEqual(['a', 'x', 'c']);
    expect(score.wrongAccepts).toBe(1);
    expect([score.merged, score.split, score.phantom, score.duplicate]).toEqual([0, 0, 0, 0]);
  });

  it('counts an outline over two cards as merged, and accepting it as wrong', () => {
    const score = scorePhoto(truth, [read(box(0, 0, 129, 88), 'a'), read(box(132, 0), 'c')]);
    expect(score.merged).toBe(1);
    expect(score.matched[0]).toBeNull();
    expect(score.wrongAccepts).toBe(1);
  });

  it('counts two outlines on parts of one card as split, and one on nothing as a phantom', () => {
    const score = scorePhoto(truth, [read(box(0, 0, 63, 40), 'a', 'review'), read(box(0, 46, 63, 40), 'a', 'review'), read(box(400, 400), 'z')]);
    expect(score.split).toBe(1);
    expect(score.phantom).toBe(1);
    expect(score.wrongAccepts).toBe(1);
  });

  it('counts a second read of the same card as a duplicate', () => {
    const score = scorePhoto(truth, [read(box(0, 0), 'a'), read(box(1, 1), 'a')]);
    expect(score.duplicate).toBe(1);
    expect(score.wrongAccepts).toBe(1);
  });

  it('notes an accepted partial card', () => {
    const score = scorePhoto([card('a', 0, 0, 0.5)], [read(box(0, 0), 'a')]);
    expect(score.partialAccepts).toBe(1);
    expect(score.wrongAccepts).toBe(0);
  });
});

describe('multiMetrics', () => {
  it('reports shares of the whole cards, partial ones apart', () => {
    const truth = [card('a', 0, 0), card('b', 66, 0), card('c', 132, 0, 0.4)];
    const reads = [read(box(0, 0), 'a'), read(box(66, 0), 'q', 'review')];
    const score = scorePhoto(truth, reads);
    const metrics = multiMetrics([{ outcomes: truth.map((c, i) => ({ photo: 'p', card: c, read: score.matched[i]! })), score, ms: 100 }]);
    expect(metrics).toMatchObject({ photos: 1, cards: 2, partialCards: 1, found: 1, top1Printing: 0.5, autoAccepted: 0.5, wrongAccepts: 0 });
  });
});
