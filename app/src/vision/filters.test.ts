import { describe, expect, it } from 'vitest';
import { canny, gaussianBlur, laplacianVariance, otsuThreshold } from './filters';
import { createGray, type GrayImage } from './image';

function squareImage(size = 64, inner = 200, outer = 40): GrayImage {
  const image = createGray(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) image.data[y * size + x] = x >= 16 && x < 48 && y >= 16 && y < 48 ? inner : outer;
  }
  return image;
}

describe('gaussianBlur', () => {
  it('leaves a flat image flat', () => {
    const flat = createGray(20, 20);
    flat.data.fill(90);
    expect(Math.max(...gaussianBlur(flat, 1.5).data)).toBeCloseTo(90, 4);
  });
});

describe('canny', () => {
  it('finds the outline of a bright square and nothing else', () => {
    const edges = canny(gaussianBlur(squareImage(), 1));
    const onOutline = (x: number, y: number) =>
      (Math.abs(x - 16) <= 2 || Math.abs(x - 47) <= 2 || Math.abs(y - 16) <= 2 || Math.abs(y - 47) <= 2) &&
      x >= 13 && x <= 50 && y >= 13 && y <= 50;
    let inside = 0;
    let outline = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (!edges[y * 64 + x]) continue;
        if (onOutline(x, y)) outline++;
        else inside++;
      }
    }
    expect(outline).toBeGreaterThan(100);
    expect(inside).toBe(0);
  });
});

describe('laplacianVariance', () => {
  it('scores a sharp image above a blurred one', () => {
    const sharp = squareImage();
    expect(laplacianVariance(sharp)).toBeGreaterThan(laplacianVariance(gaussianBlur(sharp, 2)) * 5);
  });
});

describe('otsuThreshold', () => {
  it('splits two clusters between them', () => {
    const values = Float32Array.from([...Array(100).fill(30), ...Array(60).fill(210)]);
    const threshold = otsuThreshold(values);
    expect(threshold).toBeGreaterThan(30);
    expect(threshold).toBeLessThan(210);
  });
});
