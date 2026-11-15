import { describe, expect, it, vi } from 'vitest';
import { MTG_REGIONS } from '../games/mtg/adapter';
import type { CardDetection } from '../vision/detect';
import { artCard, cardQuad, placeCard } from '../vision/testScene';
import { LiveScanner } from './liveScanner';
import { LiveSession } from './liveSession';
import { NameIndex } from './nameSearch';
import type { Recognition, RecognizeOptions } from './pipeline';

/** What each read was given: the detections it was told to use, if any. */
const given: (CardDetection[] | undefined)[] = [];

function recognition(decision: Recognition['decision']): Recognition {
  return {
    decision,
    detection: null,
    quality: null,
    title: null,
    names: decision === 'no-card' ? [] : ['Sol Ring'],
    titleCandidates: [],
    printings: [],
    nameConfidence: decision === 'no-card' ? 0 : 0.7,
    confidence: decision === 'no-card' ? 0 : 0.7,
    collector: null,
    timings: {},
    guessedOutline: false,
    outsideLock: false,
    trace: ['title:rendering-1'],
  };
}

// The read's own detection, at a larger size, finds no card where live mode saw one, every time.
vi.mock('./pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pipeline')>();
  return {
    ...actual,
    recognizeFrame: vi.fn(async (_frame: unknown, options: RecognizeOptions) => {
      given.push(options.detections);
      return recognition('no-card');
    }),
  };
});

describe('LiveScanner when the read finds no card where live mode saw one (round 7)', () => {
  it('tries a few times, then files nothing and leaves it be (round 7: all four such were junk)', async () => {
    const frame = placeCard(artCard(7), { width: 720, height: 960 }, cardQuad({ x: 360, y: 480 }, 600, 0.03), [110, 40, 45]);
    const scanner = new LiveScanner(new LiveSession({ frames: 1, tolerance: 0.02 }));
    const ocr = { async readLine() { return { text: '', confidence: 0 }; }, async dispose() {} };
    const context = { regions: MTG_REGIONS, names: new NameIndex({ names: ['Sol Ring'], faces: {} }), ocr };
    const seen = [];
    for (let i = 0; i < 5; i++) seen.push(await scanner.frame(frame, context));
    expect(given).toHaveLength(3);
    expect(given.every((detections) => detections === undefined)).toBe(true);
    expect(seen.every((outcome) => outcome.read === null)).toBe(true);
    expect(seen[2]).toMatchObject({ dismissed: true, phase: 'empty' });
    // Remembered as no card: not read again while it lies there.
    expect(seen[4]!.phase).toBe('empty');
  });
});
