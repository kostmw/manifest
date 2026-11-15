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

// The read's own detection, at a larger size, finds no card; given live mode's outline, it reads one.
vi.mock('./pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pipeline')>();
  return {
    ...actual,
    recognizeFrame: vi.fn(async (_frame: unknown, options: RecognizeOptions) => {
      given.push(options.detections);
      return recognition(options.detections ? 'review' : 'no-card');
    }),
  };
});

describe('LiveScanner when the read finds no card where live mode saw one (round 7)', () => {
  it('reads the card from live mode’s outline instead of filing an empty card', async () => {
    const frame = placeCard(artCard(7), { width: 720, height: 960 }, cardQuad({ x: 360, y: 480 }, 600, 0.03), [110, 40, 45]);
    const scanner = new LiveScanner(new LiveSession({ frames: 1, tolerance: 0.02 }));
    const ocr = { async readLine() { return { text: '', confidence: 0 }; }, async dispose() {} };
    const seen = await scanner.frame(frame, { regions: MTG_REGIONS, names: new NameIndex({ names: ['Sol Ring'], faces: {} }), ocr });
    expect(given).toHaveLength(2);
    expect(given[0]).toBeUndefined();
    expect(given[1]).toHaveLength(1);
    expect(given[1]![0]!.corners).toEqual(seen.corners);
    expect(seen.read).toMatchObject({ counted: true, gaveUp: false });
    expect(seen.read!.recognition.names).toEqual(['Sol Ring']);
    expect(seen.read!.recognition.trace[0]).toBe('outline:live');
  });
});
