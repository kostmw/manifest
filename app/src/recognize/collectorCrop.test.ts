import { describe, expect, it } from 'vitest';
import { createGray } from '../vision/image';
import { cutAtGap, findTextLines } from './collectorCrop';

/** A row profile with text-like bumps of `height` rows at the given tops. */
function profile(length: number, lines: { top: number; height: number; energy: number }[]): Float32Array {
  const out = new Float32Array(length).fill(0.5);
  for (const { top, height, energy } of lines) for (let y = top; y < top + height; y++) out[y] = energy;
  return out;
}

describe('findTextLines', () => {
  it('finds both lines of a modern collector line, top to bottom', () => {
    const rows = profile(200, [
      { top: 60, height: 36, energy: 20 },
      { top: 110, height: 36, energy: 30 },
    ]);
    expect(findTextLines(rows, 36, 3)).toEqual([60, 110]);
  });

  it('ignores faint texture well below the strongest line', () => {
    const rows = profile(200, [
      { top: 20, height: 36, energy: 3 },
      { top: 110, height: 36, energy: 30 },
    ]);
    expect(findTextLines(rows, 36, 3)).toEqual([110]);
  });

  it('finds nothing in a blank band', () => {
    expect(findTextLines(new Float32Array(100), 36, 3)).toEqual([]);
  });
});

describe('cutAtGap', () => {
  it('keeps the text up to the first wide gap and whites out the rest', () => {
    const image = createGray(40, 4);
    image.data.fill(255);
    for (const x of [1, 2, 5, 6, 20, 30]) for (let y = 0; y < 4; y++) image.data[y * 40 + x] = 0;
    const cut = cutAtGap(image, 8);
    expect(cut.data[5]).toBe(0);
    expect(cut.data[20]).toBe(255);
    expect(cut.data[30]).toBe(255);
    expect(cutAtGap(image, 20)).toBe(image);
  });
});
