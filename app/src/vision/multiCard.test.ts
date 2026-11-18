import { describe, expect, it } from 'vitest';
import { MTG_REGIONS } from '../games/mtg/adapter';
import { applyHomography, homography, type Point, type Quad } from './geometry';
import { createRgba, type RgbaImage } from './image';
import { findCards } from './multiCard';
import { artCard, cardQuad, cornerError, makeCard, type Rgb } from './testScene';

const OPTIONS = { aspect: MTG_REGIONS.size.width / MTG_REGIONS.size.height, border: MTG_REGIONS.border };

/** A frame with several cards in it, over a background with optional light lines (binder seams). */
function scene(size: { width: number; height: number }, cards: { card: RgbaImage; corners: Quad }[], background: Rgb, seams: { x: number[]; y: number[] } | null = null): RgbaImage {
  const out = createRgba(size.width, size.height);
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = background[0];
    out.data[i + 1] = background[1];
    out.data[i + 2] = background[2];
    out.data[i + 3] = 255;
  }
  if (seams) {
    for (let y = 0; y < size.height; y++) {
      for (let x = 0; x < size.width; x++) {
        if (seams.x.some((sx) => Math.abs(x - sx) < 2) || seams.y.some((sy) => Math.abs(y - sy) < 2)) {
          const p = (y * size.width + x) * 4;
          out.data[p] = out.data[p + 1] = out.data[p + 2] = 110;
        }
      }
    }
  }
  for (const { card, corners } of cards) {
    const rect: Point[] = [
      { x: 0, y: 0 },
      { x: card.width, y: 0 },
      { x: card.width, y: card.height },
      { x: 0, y: card.height },
    ];
    const toCard = homography(corners, rect)!;
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y < Math.min(size.height, Math.ceil(Math.max(...ys))); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(...xs))); x < Math.min(size.width, Math.ceil(Math.max(...xs))); x++) {
        const p = applyHomography(toCard, x + 0.5, y + 0.5);
        if (p.x < 0 || p.y < 0 || p.x >= card.width || p.y >= card.height) continue;
        const s = (Math.floor(p.y) * card.width + Math.floor(p.x)) * 4;
        const o = (y * size.width + x) * 4;
        out.data[o] = card.data[s]!;
        out.data[o + 1] = card.data[s + 1]!;
        out.data[o + 2] = card.data[s + 2]!;
      }
    }
  }
  return out;
}

/** Each true card matched by one found outline, within `tolerance` of the card's height. */
function matches(found: readonly Quad[], truth: readonly Quad[], tolerance = 0.06): number {
  return truth.filter((card) => {
    const height = Math.hypot(card[3].x - card[0].x, card[3].y - card[0].y);
    return found.filter((quad) => cornerError(quad, card) < height * tolerance).length === 1;
  }).length;
}

/** A 3×3 binder page: pockets `pitch` apart, cards settled a little off centre in them. */
function binderPage(frame: { width: number; height: number }, origin: Point, pitch: { x: number; y: number }, cardHeight: number) {
  const cards: { card: RgbaImage; corners: Quad }[] = [];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      const center = {
        x: origin.x + column * pitch.x + pitch.x / 2 + ((row * 3 + column) % 3) - 1,
        y: origin.y + row * pitch.y + pitch.y / 2 + 3,
      };
      cards.push({ card: artCard(row * 3 + column + 1), corners: cardQuad(center, cardHeight, ((row + column) % 3 - 1) * 0.006) });
    }
  }
  const seams = {
    x: [0, 1, 2, 3].map((i) => origin.x + i * pitch.x),
    y: [0, 1, 2, 3].map((i) => origin.y + i * pitch.y),
  };
  return { image: scene(frame, cards, [20, 20, 22], seams), truth: cards.map((card) => card.corners) };
}

describe('findCards', () => {
  it('finds every card on a binder page, not the page or a block of pockets', () => {
    const { image, truth } = binderPage({ width: 900, height: 1200 }, { x: 60, y: 90 }, { x: 260, y: 350 }, 330);
    const found = findCards(image, OPTIONS);
    expect(found).toHaveLength(9);
    // Each card's outline or its pocket's: either reads (see the sleeve outline in fingerprint matching).
    expect(matches(found.map((card) => card.detection.corners), truth, 0.08)).toBe(9);
    expect(found.every((card) => card.visible === 1)).toBe(true);
  });

  it('finds the cards of a page that runs off the photo, the cut-off ones marked', () => {
    // A third of the page's left column is outside the frame.
    const { image, truth } = binderPage({ width: 760, height: 1200 }, { x: -80, y: 90 }, { x: 260, y: 350 }, 330);
    const found = findCards(image, OPTIONS);
    const whole = truth.filter((card) => card.every((p) => p.x >= 0));
    expect(matches(found.map((card) => card.detection.corners), whole, 0.08)).toBe(whole.length);
    expect(found.some((card) => card.visible < 1)).toBe(true);
    expect(found.filter((card) => card.visible < 1).every((card) => card.visible >= 0.6)).toBe(true);
  });

  it('finds cards spread on a table, apart and touching', () => {
    const cards = [
      { card: artCard(1), corners: cardQuad({ x: 200, y: 260 }, 300, 0.04) },
      { card: artCard(2), corners: cardQuad({ x: 560, y: 280 }, 300, -0.08) },
      // Two touching in a row.
      { card: artCard(3), corners: cardQuad({ x: 300, y: 760 }, 300, 0) },
      { card: artCard(4), corners: cardQuad({ x: 300 + 300 * (488 / 680), y: 760 }, 300, 0) },
    ];
    const found = findCards(scene({ width: 900, height: 1100 }, cards, [120, 90, 60]), OPTIONS);
    // The touching pair may come back as each card's frame line, which reads as well (see the frame-line outline in fingerprint matching).
    expect(matches(found.map((card) => card.detection.corners), cards.map((card) => card.corners), 0.08)).toBe(4);
    expect(found).toHaveLength(4);
  });

  it('finds one card in a photo of one card, never its art and text boxes', () => {
    const image = scene({ width: 720, height: 960 }, [{ card: makeCard(), corners: cardQuad({ x: 360, y: 480 }, 640, 0.05) }], [110, 130, 150]);
    const found = findCards(image, OPTIONS);
    expect(found).toHaveLength(1);
  });

  it('finds nothing in an empty photo', () => {
    expect(findCards(scene({ width: 640, height: 480 }, [], [128, 128, 128]), OPTIONS)).toEqual([]);
  });
});
