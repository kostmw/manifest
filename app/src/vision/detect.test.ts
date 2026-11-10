import { describe, expect, it } from 'vitest';
import { detectCards } from './detect';
import { createRgba } from './image';
import { cardQuad, cornerError, makeCard, placeCard } from './testScene';

const ASPECT = 488 / 680;
const FRAME = { width: 720, height: 960 };

describe('detectCards', () => {
  it('finds a tilted card on a plain background, corners within a few pixels', () => {
    const truth = cardQuad({ x: 360, y: 480 }, 600, 0.12);
    const frame = placeCard(makeCard(), FRAME, truth, [120, 140, 160]);
    const [card] = detectCards(frame, { aspect: ASPECT });
    expect(card).toBeDefined();
    expect(cornerError(card!.corners, truth)).toBeLessThan(4);
    expect(card!.aspect).toBeCloseTo(ASPECT, 1);
  });

  it('puts the short side on top, also for a card lying sideways', () => {
    const truth = cardQuad({ x: 480, y: 360 }, 560, Math.PI / 2 + 0.05);
    const frame = placeCard(makeCard(), { width: 960, height: 720 }, truth, [200, 190, 170]);
    const [card] = detectCards(frame, { aspect: ASPECT });
    const top = Math.hypot(card!.corners[1].x - card!.corners[0].x, card!.corners[1].y - card!.corners[0].y);
    const side = Math.hypot(card!.corners[2].x - card!.corners[1].x, card!.corners[2].y - card!.corners[1].y);
    expect(top).toBeLessThan(side);
  });

  it('offers the card before the boxes printed inside it', () => {
    const truth = cardQuad({ x: 360, y: 480 }, 640, -0.05);
    const frame = placeCard(makeCard(), FRAME, truth, [90, 110, 90]);
    const found = detectCards(frame, { aspect: ASPECT });
    expect(cornerError(found[0]!.corners, truth)).toBeLessThan(4);
  });

  it('finds nothing in an empty frame', () => {
    const frame = createRgba(640, 480);
    for (let i = 0; i < frame.data.length; i += 4) {
      const noise = 100 + ((i * 7919) % 13);
      frame.data[i] = noise;
      frame.data[i + 1] = noise;
      frame.data[i + 2] = noise;
      frame.data[i + 3] = 255;
    }
    expect(detectCards(frame, { aspect: ASPECT })).toEqual([]);
  });

  it('pushes out to the card edge when a black border meets a dark mat', () => {
    const truth = cardQuad({ x: 360, y: 480 }, 640, 0.04);
    // The border is only slightly darker than the mat: Canny sees the frame's edge, not the card's.
    const frame = placeCard(makeCard({ border: [14, 14, 14] }), FRAME, truth, [22, 22, 22]);
    const withoutHelp = detectCards(frame, { aspect: ASPECT })[0]!;
    const withBorder = detectCards(frame, { aspect: ASPECT, border: 20 / 488 })[0]!;
    expect(cornerError(withoutHelp.corners, truth)).toBeGreaterThan(15);
    expect(cornerError(withBorder.corners, truth)).toBeLessThan(cornerError(withoutHelp.corners, truth) / 2);
  });
});
