import { describe, expect, it } from 'vitest';
import {
  applyHomography,
  convexHull,
  distance,
  fitLine,
  homography,
  intersect,
  isConvex,
  lineDistance,
  maxAreaQuad,
  orderCardCorners,
  polygonArea,
  simplifyClosed,
  type Point,
} from './geometry';

const square = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

/** A rounded rectangle's outline, the shape a card's edge pixels make. */
function roundedRect(width: number, height: number, radius: number): Point[] {
  const points: Point[] = [];
  const corners = [
    { cx: width - radius, cy: radius, start: -Math.PI / 2 },
    { cx: width - radius, cy: height - radius, start: 0 },
    { cx: radius, cy: height - radius, start: Math.PI / 2 },
    { cx: radius, cy: radius, start: Math.PI },
  ];
  for (const { cx, cy, start } of corners) {
    for (let i = 0; i <= 8; i++) {
      const a = start + (i / 8) * (Math.PI / 2);
      points.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
    }
  }
  return points;
}

describe('convexHull', () => {
  it('keeps only the outside points', () => {
    const hull = convexHull([...square, { x: 5, y: 5 }, { x: 2, y: 7 }, { x: 5, y: 0 }]);
    expect(hull).toHaveLength(4);
    expect(polygonArea(hull)).toBe(100);
  });
});

describe('maxAreaQuad', () => {
  it('finds the four corners of a rounded rectangle', () => {
    const outline = roundedRect(63, 88, 3);
    const quad = maxAreaQuad(simplifyClosed(convexHull(outline), 0.5))!;
    expect(quad).toHaveLength(4);
    // Its corners sit on the rounded corners, a little inside the true ones; refineQuad fixes that.
    expect(polygonArea(quad)).toBeGreaterThan(63 * 88 * 0.95);
  });
});

describe('fitLine and intersect', () => {
  it('fits noisy points along a line', () => {
    const points = Array.from({ length: 50 }, (_, i) => ({ x: i, y: 2 * i + 1 + (i % 2 ? 0.2 : -0.2) }));
    const line = fitLine(points)!;
    for (const p of [{ x: 10, y: 21 }, { x: 40, y: 81 }]) expect(Math.abs(lineDistance(line, p))).toBeLessThan(0.3);
  });

  it('intersects two lines', () => {
    const a = fitLine([{ x: 0, y: 0 }, { x: 10, y: 10 }])!;
    const b = fitLine([{ x: 0, y: 10 }, { x: 10, y: 0 }])!;
    const p = intersect(a, b)!;
    expect(p.x).toBeCloseTo(5);
    expect(p.y).toBeCloseTo(5);
  });
});

describe('homography', () => {
  it('maps each corner onto its target', () => {
    const to = [
      { x: 12, y: 30 },
      { x: 300, y: 50 },
      { x: 280, y: 420 },
      { x: 5, y: 400 },
    ];
    const h = homography(square, to)!;
    square.forEach((p, i) => {
      const mapped = applyHomography(h, p.x, p.y);
      expect(distance(mapped, to[i]!)).toBeLessThan(1e-6);
    });
  });
});

describe('orderCardCorners', () => {
  const portrait = [
    { x: 100, y: 100 },
    { x: 163, y: 100 },
    { x: 163, y: 188 },
    { x: 100, y: 188 },
  ];

  it('starts at the top left and goes clockwise, whatever order the corners come in', () => {
    const shuffled = [portrait[2]!, portrait[0]!, portrait[3]!, portrait[1]!];
    expect(orderCardCorners(shuffled)).toEqual(portrait);
  });

  it('puts a short side on top when the card lies sideways', () => {
    const sideways = [
      { x: 0, y: 0 },
      { x: 88, y: 0 },
      { x: 88, y: 63 },
      { x: 0, y: 63 },
    ];
    const ordered = orderCardCorners(sideways);
    expect(distance(ordered[0], ordered[1])).toBeCloseTo(63);
    expect(isConvex(ordered)).toBe(true);
  });
});
