import { describe, expect, it } from 'vitest';
import { MTG_REGIONS } from '../games/mtg/adapter';
import { createGray } from '../vision/image';
import { artCard, cardQuad, placeCard, scryfallSmall as small } from '../vision/testScene';
import {
  canvasFromFrame,
  cornersMapping,
  distanceAt,
  fingerprintAt,
  fingerprintCardImage,
  phash32,
  popcount32,
  toWords,
  FINGERPRINT_BYTES,
} from './fingerprint';

const distance = (a: Uint8Array, b: Uint8Array) => {
  const d = distanceAt(toWords(a), toWords(b), 0);
  return d.art + d.card;
};

describe('phash32', () => {
  it('sets half the bits, and ignores overall brightness and contrast', () => {
    const gray = createGray(32, 32);
    for (let i = 0; i < gray.data.length; i++) gray.data[i] = (i % 32) * 4 + Math.floor(i / 32) * 3 + ((i * 7919) % 13);
    const hash = phash32(gray);
    const ones = Array.from(hash).reduce((sum, byte) => sum + popcount32(byte), 0);
    expect(ones).toBe(32);

    const brighter = createGray(32, 32);
    for (let i = 0; i < gray.data.length; i++) brighter.data[i] = gray.data[i]! * 0.7 + 40;
    expect(phash32(brighter)).toEqual(hash);
  });
});

describe('fingerprints', () => {
  it('match a photographed card to its index image, and not to other cards', () => {
    const cards = [artCard(1), artCard(2), artCard(3)];
    const index = cards.map((card) => fingerprintCardImage(small(card), MTG_REGIONS));
    expect(index[0]).toHaveLength(FINGERPRINT_BYTES);

    const corners = cardQuad({ x: 400, y: 520 }, 820, 0.08);
    const frame = placeCard(cards[0]!, { width: 800, height: 1040 }, corners, [70, 90, 60]);
    const canvas = canvasFromFrame(frame, cornersMapping(corners, MTG_REGIONS.size)!, MTG_REGIONS.size, 40);
    const query = fingerprintAt(canvas, MTG_REGIONS);

    const own = distance(query, index[0]!);
    expect(own).toBeLessThanOrEqual(12);
    for (const other of index.slice(1)) expect(distance(query, other)).toBeGreaterThan(own + 16);
  });

  it('can be taken with the card placed elsewhere in the canvas, as when detection found the frame line', () => {
    const card = artCard(7);
    const indexed = fingerprintCardImage(small(card), MTG_REGIONS);
    const corners = cardQuad({ x: 400, y: 520 }, 820, 0);
    const frame = placeCard(card, { width: 800, height: 1040 }, corners, [20, 20, 20]);
    // Pretend detection returned a quad 5% inside the card on every side.
    const inset = corners.map((p) => ({ x: 400 + (p.x - 400) * 0.9, y: 520 + (p.y - 520) * 0.9 })) as typeof corners;
    const canvas = canvasFromFrame(frame, cornersMapping(inset, MTG_REGIONS.size)!, MTG_REGIONS.size, 60);
    const naive = fingerprintAt(canvas, MTG_REGIONS);
    // In the inset quad's coordinates, the real card reaches 1/0.9 of the way out.
    const k = (1 / 0.9 - 1) / 2;
    const placed = fingerprintAt(canvas, MTG_REGIONS, [-488 * k, -680 * k, 488 * (1 + k), 680 * (1 + k)]);
    expect(distance(placed, indexed)).toBeLessThan(distance(naive, indexed));
    expect(distance(placed, indexed)).toBeLessThanOrEqual(12);
  });
});
