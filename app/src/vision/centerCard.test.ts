import { describe, expect, it } from 'vitest';
import { centerCardSearch, refineBox, type Box4 } from './centerCard';
import type { Quad } from './geometry';
import { createRgba, type RgbaImage } from './image';
import { makeCard, placeCard } from './testScene';

const ASPECT = 488 / 680;
const SIZE = { width: 600, height: 1100 };

/** A borderless card: soft blobs of colour right to the edge, and a title bar across the top. */
function borderless(seed: number): RgbaImage {
  const card = createRgba(488, 680);
  let state = seed;
  const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  const blobs = Array.from({ length: 9 }, () => ({ x: random() * 488, y: random() * 680, r: 40 + random() * 120, v: random() * 200 }));
  for (let y = 0; y < 680; y++) {
    for (let x = 0; x < 488; x++) {
      let value = 60;
      for (const blob of blobs) value += blob.v * Math.exp(-((x - blob.x) ** 2 + (y - blob.y) ** 2) / (blob.r * blob.r));
      const title = y > 30 && y < 80 && x > 30 && x < 458;
      const p = (y * 488 + x) * 4;
      card.data[p] = title ? 230 : Math.min(255, value * 0.7);
      card.data[p + 1] = title ? 230 : Math.min(255, value * 0.8);
      card.data[p + 2] = title ? 235 : Math.min(255, value);
      card.data[p + 3] = 255;
    }
  }
  return card;
}

const rect = (x0: number, y0: number, x1: number, y1: number): Quad => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

/** Cards pasted one after another onto a table. */
function table(cards: { image: RgbaImage; corners: Quad }[]): RgbaImage {
  const out = placeCard(cards[0]!.image, SIZE, cards[0]!.corners, [120, 85, 60]);
  for (const { image, corners } of cards.slice(1)) {
    const layer = placeCard(image, SIZE, corners, [255, 0, 255]);
    for (let i = 0; i < out.data.length; i += 4) {
      if (layer.data[i] === 255 && layer.data[i + 1] === 0 && layer.data[i + 2] === 255) continue;
      out.data.set(layer.data.subarray(i, i + 3), i);
    }
  }
  return out;
}

const error = (box: Box4, truth: Box4) => Math.max(...box.map((v, i) => Math.abs(v - truth[i]!)));

describe('centerCardSearch', () => {
  it('offers the borderless card in the middle, though its neighbours touch it on every side', () => {
    // The card in the middle, 420 wide; other cards cut off by the frame all around it.
    const truth: Box4 = [90, 257, 510, 843];
    const frame = table([
      { image: makeCard(), corners: rect(-330, 257, 90, 843) },
      { image: makeCard(), corners: rect(510, 257, 930, 843) },
      { image: makeCard(), corners: rect(90, -329, 510, 257) },
      { image: makeCard(), corners: rect(90, 843, 510, 1429) },
      { image: borderless(7), corners: rect(...truth) },
    ]);
    const search = centerCardSearch(frame, ASPECT);
    expect(search.boxes.length).toBeGreaterThan(0);
    // Edges alone can't single it out, but it is among the boxes or one refinement away.
    const offered = [...search.boxes, ...search.boxes.flatMap((box) => refineBox(search, box))];
    const closest = Math.min(...offered.map((box) => error(box, truth)));
    expect(closest).toBeLessThan(420 * 0.03);
  });

  it('keeps refinements card-shaped', () => {
    const frame = table([{ image: borderless(3), corners: rect(120, 300, 480, 802) }]);
    const search = centerCardSearch(frame, ASPECT);
    for (const [x0, y0, x1, y1] of refineBox(search, search.boxes[0]!)) {
      const ratio = (x1 - x0) / (y1 - y0);
      expect(ratio).toBeGreaterThanOrEqual(search.aspects[0] - 1e-9);
      expect(ratio).toBeLessThanOrEqual(search.aspects[1] + 1e-9);
    }
  });

  it('finds nothing in a featureless frame', () => {
    const blank = createRgba(SIZE.width, SIZE.height);
    blank.data.fill(128);
    expect(centerCardSearch(blank, ASPECT).boxes).toEqual([]);
  });
});
