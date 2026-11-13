import { describe, expect, it } from 'vitest';
import { fillHotspot, findHotspot } from './glare';
import { createGray, type GrayImage } from './image';

const W = 146;
const H = 204;
const CARD = { x0: 9, y0: 10, x1: 137, y1: 194 };

/** A card-sized grey canvas with a gentle gradient, like artwork. */
function art(): GrayImage {
  const gray = createGray(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) gray.data[y * W + x] = 60 + x * 0.5 + y * 0.3;
  return gray;
}

/** A flashlight's reflection: blown out in the middle, a bright halo around it. */
function withReflection(gray: GrayImage, cx: number, cy: number, r: number): GrayImage {
  const out = createGray(W, H);
  out.data.set(gray.data);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const boost = 300 * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (r * r));
      out.data[y * W + x] = Math.min(255, out.data[y * W + x]! + boost);
    }
  }
  return out;
}

describe('findHotspot', () => {
  it('finds a reflection in the middle of the card', () => {
    const found = findHotspot(withReflection(art(), 73, 70, 14), CARD);
    expect(found).not.toBeNull();
    expect(found!.x).toBeCloseTo(73, 0);
    expect(found!.y).toBeCloseTo(70, 0);
    expect(found!.area).toBeGreaterThan(0.004);
  });

  it('ignores a card without one, a speck of white, and a light rectangle like a text box', () => {
    expect(findHotspot(art(), CARD)).toBeNull();
    const speck = art();
    speck.data[70 * W + 70] = 255;
    expect(findHotspot(speck, CARD)).toBeNull();
    const textBox = art();
    for (let y = 130; y < 185; y++) for (let x = 15; x < 131; x++) textBox.data[y * W + x] = 250;
    expect(findHotspot(textBox, CARD)).toBeNull();
  });

  it('paints a reflection over close to what lies under it', () => {
    const clean = art();
    const glared = withReflection(clean, 73, 70, 14);
    const fixed = fillHotspot(glared, findHotspot(glared, CARD)!);
    const error = (image: GrayImage) => {
      let sum = 0;
      for (let i = 0; i < clean.data.length; i++) sum += Math.abs(image.data[i]! - clean.data[i]!);
      return sum / clean.data.length;
    };
    expect(error(fixed)).toBeLessThan(error(glared) / 3);
  });
});
