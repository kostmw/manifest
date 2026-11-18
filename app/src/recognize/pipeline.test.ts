import { describe, expect, it } from 'vitest';
import { MTG_REGIONS } from '../games/mtg/adapter';
import { createRgba } from '../vision/image';
import { cardQuad, makeCard, placeCard } from '../vision/testScene';
import { NameIndex } from './nameSearch';
import type { OcrEngine } from './ocr';
import { cardsAroundPiece, recognizeFrame } from './pipeline';

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
    // Junk for the three upright renderings, the wide band and the two rescue tries (cleaned,
    // cleaned wide), then a clean read of the turned card.
    const ocr = fakeOcr('#~', '#~', '#~', '#~', '#~', '#~', 'Sol Ring');
    const result = await recognizeFrame(photo(), { regions: MTG_REGIONS, names, ocr });
    expect(result.title?.rotated).toBe(true);
    expect(result.names[0]).toBe('Sol Ring');
    // The test log's record of the path taken.
    expect(result.trace).toEqual(expect.arrayContaining(['title:rendering-1', 'title:upside-down']));
  });

  it('reads a title from the cleaned line when the usual renderings fail, but only when sure', async () => {
    // Three junk renderings and the wide band, then the cleaned line reads the name.
    const rescued = await recognizeFrame(photo(), { regions: MTG_REGIONS, names, ocr: fakeOcr('#~', '#~', '#~', '#~', 'Sol Ring') });
    expect(rescued.title?.rotated).toBe(false);
    expect(rescued.names[0]).toBe('Sol Ring');
    expect(rescued.trace).toContain('title:rendering-4');
    // A cleaned line that spells a short name by chance doesn't count.
    const chance = await recognizeFrame(photo(), { regions: MTG_REGIONS, names, ocr: fakeOcr('#~', '#~', '#~', 'Ow', 'Ow', 'Ow', '#~') });
    expect(chance.title?.text).not.toBe('Ow');
  });

  it('reads a name whose first letter the usual band cut off from the wide band (round 9: "ommand Decision")', async () => {
    // The three renderings miss the first letter; the wide band reads it.
    const ocr = fakeOcr('ol Ring', 'ol Ring', 'ol Ring', 'Sol Ring');
    const result = await recognizeFrame(photo(), { regions: MTG_REGIONS, names, ocr });
    expect(result.title?.text).toBe('Sol Ring');
    expect(result.trace).toContain('title:rendering-6');
    expect(result.decision).toBe('accept');
    // Sure already: the wide band isn't read.
    const sure = fakeOcr('Sol Ring');
    await recognizeFrame(photo(), { regions: MTG_REGIONS, names, ocr: sure });
    expect(sure.calls).toBe(1);
  });

  it("doesn't let the wide band name another card unless it reads it surely", async () => {
    // The wide band catches frame junk and spells another name, but not surely: the first reading stays.
    const result = await recognizeFrame(photo(), { regions: MTG_REGIONS, names, ocr: fakeOcr('ol Ring', 'ol Ring', 'ol Ring', 'Lightn', '#~') });
    expect(result.names[0]).toBe('Sol Ring');
    expect(result.trace).not.toContain('title:rendering-6');
    // Nor by a short face: two letters of junk spell "Far" (of Far // Away) as easily as "Ow".
    const withFaces = new NameIndex({ names: ['Sol Ring', 'Far // Away'], faces: { Far: ['Far // Away'], Away: ['Far // Away'] } });
    const junk = await recognizeFrame(photo(), { regions: MTG_REGIONS, names: withFaces, ocr: fakeOcr('#~', '#~', '#~', 'ar', '#~') });
    expect(junk.trace).not.toContain('title:rendering-6');
    expect(junk.title?.text).not.toBe('ar');
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

describe('cardsAroundPiece', () => {
  it('gives the card around an outline that is its text box, and only cards mostly in the frame', () => {
    // A text box 412×200 at a quarter scale, near the bottom of the frame: only the card above it fits.
    const s = 0.5;
    const x0 = 100;
    const y0 = 700;
    const textBox = [
      { x: x0 + 412 * s, y: y0 },
      { x: x0 + 412 * s, y: y0 + 200 * s },
      { x: x0, y: y0 + 200 * s },
      { x: x0, y: y0 },
    ] as const;
    const detection = { corners: [...textBox] as [typeof textBox[0], typeof textBox[0], typeof textBox[0], typeof textBox[0]], score: 1, edgeSupport: 1, aspect: 0.5, areaFraction: 0.05, tilt: 0 };
    const frame = { width: 600, height: 900, data: new Uint8ClampedArray(600 * 900 * 4) };
    const cards = cardsAroundPiece(frame, detection, MTG_REGIONS);
    const ids = cards.map((card) => card.id);
    expect(ids).toContain('text-box');
    const card = cards.find((entry) => entry.id === 'text-box')!.detection.corners;
    // Upright: the card's top-left is up and to the left of the text box, 424 card pixels above it.
    expect(card[0].x).toBeCloseTo(x0 - 38 * s, 0);
    expect(card[0].y).toBeCloseTo(y0 - 424 * s, 0);
    expect(card[2].y).toBeCloseTo(y0 + (680 - 424) * s, 0);
    // The card the other way up would hang far below the frame: not offered.
    expect(ids.filter((id) => id === 'text-box')).toHaveLength(1);
  });
});
