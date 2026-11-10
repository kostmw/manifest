import { describe, expect, it } from 'vitest';
import { MTG_REGIONS } from '../games/mtg/adapter';
import { createGray } from '../vision/image';
import { makeCard } from '../vision/testScene';
import { binarizeLine, cropTitle, findTextLine } from './titleCrop';

describe('findTextLine', () => {
  it('picks the busiest rows near where the title should be', () => {
    const profile = new Float32Array(80);
    for (let y = 30; y < 50; y++) profile[y] = 10;
    for (let y = 70; y < 80; y++) profile[y] = 12; // busy, but far from the expected place
    expect(findTextLine(profile, 20, 40, 20)).toBe(30);
  });
});

describe('binarizeLine', () => {
  function line(text: number, background: number) {
    const image = createGray(60, 20);
    image.data.fill(background);
    for (let y = 5; y < 15; y++) for (let x = 10; x < 50; x += 6) image.data[y * 60 + x] = text;
    return image;
  }

  it('makes dark text on a light bar black on white', () => {
    const { image, inverted } = binarizeLine(line(20, 230));
    expect(inverted).toBe(false);
    expect(image.data[7 * 60 + 10]).toBe(0);
    expect(image.data[0]).toBe(255);
  });

  it('makes light text on a dark bar black on white too', () => {
    const { image, inverted } = binarizeLine(line(240, 30));
    expect(inverted).toBe(true);
    expect(image.data[7 * 60 + 10]).toBe(0);
    expect(image.data[0]).toBe(255);
  });
});

describe('cropTitle', () => {
  it('finds the title bar and returns padded black-on-white strips', () => {
    const crop = cropTitle(makeCard(), MTG_REGIONS.title);
    // The test card's letters run from y = 42 to 64.
    expect(crop.box.y).toBeLessThanOrEqual(42);
    expect(crop.box.y + crop.box.height).toBeGreaterThanOrEqual(64);
    expect(crop.inverted).toBe(false);
    const white = crop.image.data.filter((v) => v === 255).length / crop.image.data.length;
    expect(white).toBeGreaterThan(0.6);
    expect(crop.alternatives).toHaveLength(2);
  });
});
