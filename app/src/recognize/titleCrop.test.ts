import { describe, expect, it } from 'vitest';
import { MTG_REGIONS } from '../games/mtg/adapter';
import { createGray } from '../vision/image';
import { makeCard } from '../vision/testScene';
import { binarizeLine, cropTitle, findTextLine, cleanLine } from './titleCrop';

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

describe('cleanLine', () => {
  /** A white strip with black rectangles drawn on it: [x0, y0, x1, y1], ends exclusive. */
  function strip(width: number, height: number, boxes: [number, number, number, number][]) {
    const image = createGray(width, height);
    image.data.fill(255);
    for (const [x0, y0, x1, y1] of boxes) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) image.data[y * width + x] = 0;
    return image;
  }
  const at = (image: ReturnType<typeof strip>, x: number, y: number) => image.data[y * image.width + x];

  it("removes the title bar's outline and the card border caught at the end, and keeps the letters", () => {
    const letters: [number, number, number, number][] = [
      [40, 20, 50, 50],
      [60, 20, 70, 50],
      [80, 25, 90, 50],
    ];
    const image = strip(300, 70, [
      ...letters,
      [10, 2, 290, 6], // the bar's top edge
      [10, 60, 290, 66], // the art's top edge below the name
      [0, 0, 8, 70], // the card's border at the left end
      [80, 50, 90, 60], // a letter's foot touching the lower rule
    ]);
    const clean = cleanLine(image);
    expect(at(clean, 150, 4)).toBe(255);
    expect(at(clean, 150, 62)).toBe(255);
    expect(at(clean, 3, 35)).toBe(255);
    for (const [x0, y0] of letters) expect(at(clean, x0 + 2, y0 + 2)).toBe(0);
    // The letter joined to the rule keeps its own rows.
    expect(at(clean, 85, 55)).toBe(0);
  });

  it('leaves a long name alone', () => {
    const name = Array.from({ length: 20 }, (_, i): [number, number, number, number] => [10 + i * 14, 15, 20 + i * 14, 45]);
    const image = strip(300, 60, name);
    expect(Array.from(cleanLine(image).data)).toEqual(Array.from(image.data));
  });
});

describe('cleanLine on a blurred title', () => {
  it('keeps letters that blur has run together into one band through the middle', () => {
    const image = createGray(300, 60);
    image.data.fill(255);
    for (let y = 18; y < 44; y++) for (let x = 20; x < 220; x++) image.data[y * 300 + x] = 0;
    const clean = cleanLine(image);
    expect(clean.data[30 * 300 + 100]).toBe(0);
  });
});
