import { describe, expect, it } from 'vitest';
import { MTG_REGIONS } from '../games/mtg/adapter';
import { createRgba } from '../vision/image';
import { cardQuad, makeCard, placeCard } from '../vision/testScene';
import { NameIndex } from './nameSearch';
import type { OcrEngine } from './ocr';
import { recognizeFrame } from './pipeline';

const names = new NameIndex({ names: ['Sol Ring', 'Soaring', 'Lightning Bolt', 'Lightning Helix'], faces: {} });
const FRAME = { width: 720, height: 960 };
const photo = (angle = 0.05) => placeCard(makeCard(), FRAME, cardQuad({ x: 360, y: 480 }, 640, angle), [110, 130, 150]);

/** Reads whatever it's told to, in order, and counts the calls. */
function fakeOcr(...readings: string[]): OcrEngine & { calls: number } {
  const engine = {
    calls: 0,
    async readLine() {
      const text = readings[Math.min(engine.calls, readings.length - 1)] ?? '';
      engine.calls += 1;
      return { text, confidence: 90 };
    },
    async dispose() {},
  };
  return engine;
}

describe('recognizeFrame', () => {
  it('detects, reads and accepts a clear card', async () => {
    const ocr = fakeOcr('Sol Ring');
    const result = await recognizeFrame(photo(), { regions: MTG_REGIONS, names, ocr, keepImages: true });
    expect(result.decision).toBe('accept');
    expect(result.names[0]).toBe('Sol Ring');
    expect(result.title).toMatchObject({ text: 'Sol Ring', rotated: false });
    expect(result.card).toMatchObject({ width: 488, height: 680 });
    expect(ocr.calls).toBe(1);
    expect(Object.keys(result.timings)).toEqual(expect.arrayContaining(['detect', 'rectify', 'quality', 'ocr']));
  });

  it('reports no card when there is none', async () => {
    const blank = createRgba(640, 480).data.fill(128);
    const result = await recognizeFrame({ width: 640, height: 480, data: blank }, { regions: MTG_REGIONS, names, ocr: fakeOcr('x') });
    expect(result.decision).toBe('no-card');
  });

  it('tries other renderings, then the card upside down, when the title reads poorly', async () => {
    // Junk for the three upright renderings, then a clean read of the turned card.
    const ocr = fakeOcr('#~', '#~', '#~', 'Sol Ring');
    const result = await recognizeFrame(photo(), { regions: MTG_REGIONS, names, ocr });
    expect(result.title?.rotated).toBe(true);
    expect(result.names[0]).toBe('Sol Ring');
  });

  it('sends a doubtful reading to review rather than accepting it', async () => {
    const result = await recognizeFrame(photo(), { regions: MTG_REGIONS, names, ocr: fakeOcr('Lightning Bo') });
    expect(result.decision).toBe('review');
    expect(result.names).toContain('Lightning Bolt');
  });

  it("doesn't spend OCR on a frame that fails the quality gate in live mode", async () => {
    const small = placeCard(makeCard(), FRAME, cardQuad({ x: 360, y: 480 }, 200), [110, 130, 150]);
    const ocr = fakeOcr('Sol Ring');
    const result = await recognizeFrame(small, { regions: MTG_REGIONS, names, ocr });
    expect(result.decision).toBe('retake');
    expect(result.quality?.issues).toContain('too-small');
    expect(ocr.calls).toBe(0);
  });

  it('still reads a poor photo when asked, but never auto-accepts it', async () => {
    const small = placeCard(makeCard(), FRAME, cardQuad({ x: 360, y: 480 }, 200), [110, 130, 150]);
    const result = await recognizeFrame(small, { regions: MTG_REGIONS, names, ocr: fakeOcr('Sol Ring'), readDespiteQuality: true });
    expect(result.names[0]).toBe('Sol Ring');
    expect(result.decision).toBe('review');
  });
});
