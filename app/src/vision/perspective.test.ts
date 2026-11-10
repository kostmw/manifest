import { describe, expect, it } from 'vitest';
import type { Quad } from './geometry';
import { cardPose, PHONE_FOCAL_SHARE } from './perspective';

const FRAME = { width: 1280, height: 720 };
const CARD_ASPECT = 63 / 88;

/**
 * A 63×88 card, 30 cm in front of a pinhole camera with a phone's field of
 * view, tipped `tilt` degrees about its horizontal axis (top edge away), turned
 * `turn` degrees about the vertical axis, and shifted sideways by `shift` cm.
 */
function project(tilt: number, turn = 0, shift = { x: 0, y: 0 }): Quad {
  const focal = PHONE_FOCAL_SHARE * Math.max(FRAME.width, FRAME.height);
  const t = (tilt * Math.PI) / 180;
  const u = (turn * Math.PI) / 180;
  const corners = [
    [-3.15, -4.4],
    [3.15, -4.4],
    [3.15, 4.4],
    [-3.15, 4.4],
  ].map(([x, y]) => {
    // Tip about x (top away from the camera), then turn about y.
    const y1 = y! * Math.cos(t);
    const z1 = -y! * Math.sin(t);
    const x2 = x! * Math.cos(u) + z1 * Math.sin(u);
    const z2 = -x! * Math.sin(u) + z1 * Math.cos(u);
    const X = x2 + shift.x;
    const Y = y1 + shift.y;
    const Z = z2 + 30;
    return { x: FRAME.width / 2 + (focal * X) / Z, y: FRAME.height / 2 + (focal * Y) / Z };
  });
  return corners as unknown as Quad;
}

describe('cardPose', () => {
  it('sees a card straight on as a card', () => {
    const pose = cardPose(project(0), FRAME)!;
    expect(pose.aspect).toBeCloseTo(CARD_ASPECT, 3);
    expect(pose.tilt).toBeLessThan(0.5);
  });

  it.each([20, 35, 50, 60])('recovers the shape and angle of a card tipped %i°', (tilt) => {
    const corners = project(tilt);
    const pose = cardPose(corners, FRAME)!;
    expect(pose.aspect).toBeCloseTo(CARD_ASPECT, 2);
    expect(pose.tilt).toBeCloseTo(tilt, 0);
    // The outline itself looks nothing like a card any more.
    const outline = (corners[1].x - corners[0].x + corners[2].x - corners[3].x) / (corners[3].y - corners[0].y + corners[2].y - corners[1].y);
    if (tilt >= 35) expect(outline).toBeGreaterThan(CARD_ASPECT * 1.2);
  });

  it('copes with cards turned sideways and off-centre in the frame', () => {
    const pose = cardPose(project(40, 25, { x: 6, y: -3 }), FRAME)!;
    expect(pose.aspect).toBeCloseTo(CARD_ASPECT, 2);
    expect(pose.tilt).toBeGreaterThan(40);
  });

  it('gives up on degenerate corners', () => {
    const point = { x: 10, y: 10 };
    expect(cardPose([point, point, point, point], FRAME)).toBeNull();
  });
});
