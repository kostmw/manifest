import { describe, expect, it } from 'vitest';
import { MTG_REGIONS } from '../games/mtg/adapter';
import type { Quad } from '../vision/geometry';
import { createRgba, type RgbaImage } from '../vision/image';
import { artCard, cardQuad, placeCard } from '../vision/testScene';
import { cardSignature, LiveScanner, presenceSignature } from './liveScanner';
import { LiveSession, signatureDistance } from './liveSession';
import { NameIndex } from './nameSearch';
import type { OcrEngine } from './ocr';

const names = new NameIndex({ names: ['Sol Ring', 'Soaring', 'Lightning Bolt', 'Lightning Helix'], faces: {} });
const FRAME = { width: 720, height: 960 };
const BACKGROUND: [number, number, number] = [110, 40, 45];
const card = artCard(7);
const where = (dx = 0, dy = 0): Quad => cardQuad({ x: 360 + dx, y: 480 + dy }, 600, 0.03);
const frameWith = (corners: Quad | null): RgbaImage =>
  corners ? placeCard(card, FRAME, corners, BACKGROUND) : (() => {
    const empty = createRgba(FRAME.width, FRAME.height);
    for (let i = 0; i < empty.data.length; i += 4) empty.data.set([...BACKGROUND, 255], i);
    return empty;
  })();

/** Reads "Sol Ring" every time, and counts the calls. */
function fakeOcr(): OcrEngine & { calls: number } {
  const engine = {
    calls: 0,
    async readLine() {
      engine.calls += 1;
      return { text: 'Sol Ring', confidence: 90 };
    },
    async dispose() {},
  };
  return engine;
}

describe('presenceSignature', () => {
  it('finds a card a hand-held phone has moved off its spot, where its plain fingerprint does not', () => {
    const read = cardSignature(frameWith(where()), where(), MTG_REGIONS)!;
    // The phone moved: the card now lies 8% of its height lower and a little to the side.
    const moved = frameWith(where(25, 48));
    expect(signatureDistance(cardSignature(moved, where(), MTG_REGIONS)!, read)).toBeGreaterThan(24);
    expect(signatureDistance(presenceSignature(moved, where(), MTG_REGIONS)!, read)).toBeLessThanOrEqual(12);
    // An empty spot looks like nothing it has.
    expect(signatureDistance(presenceSignature(frameWith(null), where(), MTG_REGIONS)!, read)).toBeGreaterThan(44);
  });

  it('says nothing about a spot the camera has blown out or blacked out while it re-exposes', () => {
    const lit = (image: RgbaImage, gain: number): RgbaImage => ({ ...image, data: image.data.map((value, i) => (i % 4 === 3 ? value : value * gain)) });
    expect(presenceSignature(lit(frameWith(where()), 3), where(), MTG_REGIONS)).toBeNull();
    expect(presenceSignature(lit(frameWith(where()), 0.08), where(), MTG_REGIONS)).toBeNull();
    // A little brighter or darker is still a picture.
    expect(presenceSignature(lit(frameWith(where()), 1.3), where(), MTG_REGIONS)).not.toBeNull();
    expect(presenceSignature(lit(frameWith(null), 1.3), where(), MTG_REGIONS)).not.toBeNull();
  });
});

describe('LiveScanner', () => {
  const context = (ocr: OcrEngine) => ({ regions: MTG_REGIONS, names, ocr });

  it('reads a card once while it lies there and the phone moves, and again after it was taken away', async () => {
    const ocr = fakeOcr();
    const scanner = new LiveScanner(new LiveSession());
    const counted: boolean[] = [];
    const show = async (corners: Quad | null, frames: number) => {
      for (let i = 0; i < frames; i++) {
        const seen = await scanner.frame(frameWith(corners), context(ocr));
        if (seen.read) counted.push(seen.read.counted);
      }
    };
    await show(where(), 4);
    expect(counted).toEqual([true]);
    // The phone moves about over the card, by more than a tenth of its diagonal: never counted again.
    await show(where(60, 100), 3);
    await show(where(-90, 30), 3);
    await show(where(), 3);
    expect(counted).toEqual([true]);
    // Taken away, and the same card (or an identical copy) put back: counted.
    await show(null, 4);
    await show(where(5, 0), 3);
    expect(counted).toEqual([true, true]);
  });

  it('drops a frame that comes while another is being read, so reads never overlap', async () => {
    const ocr = fakeOcr();
    const scanner = new LiveScanner(new LiveSession({ frames: 1, tolerance: 0.02 }));
    const first = scanner.frame(frameWith(where()), context(ocr));
    expect(scanner.busy).toBe(true);
    const second = await scanner.frame(frameWith(where()), context(ocr));
    expect(second).toMatchObject({ busy: true, read: null });
    expect((await first).read).toMatchObject({ counted: true, trigger: 'fresh', gaveUp: false });
    expect(scanner.busy).toBe(false);
    expect(ocr.calls).toBe(1);
  });

  it('keeps the frames before a read, and why it was read, for the test log', async () => {
    const scanner = new LiveScanner(new LiveSession());
    const ocr = fakeOcr();
    await scanner.frame(frameWith(null), context(ocr));
    await scanner.frame(frameWith(where()), context(ocr));
    const seen = await scanner.frame(frameWith(where()), context(ocr));
    expect(seen.read?.trigger).toBe('fresh');
    expect(seen.read?.frames.map((frame) => frame.outline)).toEqual([false, true, true]);
  });
});
