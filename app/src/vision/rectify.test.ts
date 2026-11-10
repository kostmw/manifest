import { describe, expect, it } from 'vitest';
import { warpQuad } from './rectify';
import { cardQuad, makeCard, placeCard } from './testScene';

describe('warpQuad', () => {
  it('turns a tilted card in a photo back into the upright card', () => {
    const card = makeCard();
    const corners = cardQuad({ x: 400, y: 500 }, 700, 0.2);
    const frame = placeCard(card, { width: 800, height: 1000 }, corners, [50, 90, 60]);
    const upright = warpQuad(frame, corners, { width: 488, height: 680 });

    let difference = 0;
    for (let i = 0; i < card.data.length; i += 4) difference += Math.abs(card.data[i]! - upright.data[i]!);
    // Resampling softens edges a little; the picture is otherwise the same.
    expect(difference / (card.width * card.height)).toBeLessThan(8);
  });

  it('shrinks a much bigger card before sampling, without losing the layout', () => {
    const card = makeCard();
    const corners = cardQuad({ x: 1000, y: 1300 }, 2400, 0);
    const frame = placeCard(card, { width: 2000, height: 2600 }, corners, [0, 0, 0]);
    const upright = warpQuad(frame, corners, { width: 488, height: 680 });
    // The middle of the art box keeps its colour.
    const p = (220 * 488 + 244) * 4;
    expect([upright.data[p], upright.data[p + 1], upright.data[p + 2]]).toEqual([60, 80, 110]);
  });
});
