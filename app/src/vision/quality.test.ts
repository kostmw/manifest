import { describe, expect, it } from 'vitest';
import { MTG_REGIONS } from '../games/mtg/adapter';
import { gaussianBlur } from './filters';
import { createGray, type RgbaImage } from './image';
import { assessQuality } from './quality';
import { warpQuad } from './rectify';
import { cardQuad, makeCard, placeCard } from './testScene';

const FRAME = { width: 720, height: 960 };
const titleBox = MTG_REGIONS.title.search;

function blurred(image: RgbaImage, sigma: number): RgbaImage {
  const out = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  for (let c = 0; c < 3; c++) {
    const channel = createGray(image.width, image.height);
    for (let i = 0; i < channel.data.length; i++) channel.data[i] = image.data[i * 4 + c]!;
    const smooth = gaussianBlur(channel, sigma);
    for (let i = 0; i < channel.data.length; i++) out.data[i * 4 + c] = smooth.data[i]!;
  }
  return out;
}

function check(corners = cardQuad({ x: 360, y: 480 }, 600, 0.05), edit?: (card: RgbaImage) => RgbaImage) {
  const frame = placeCard(makeCard(), FRAME, corners, [120, 140, 160]);
  let card = warpQuad(frame, corners, MTG_REGIONS.size);
  if (edit) card = edit(card);
  return assessQuality({ frame: FRAME, corners, card, titleBox });
}

describe('assessQuality', () => {
  it('passes a sharp, well-lit card that fills the frame', () => {
    expect(check()).toMatchObject({ ok: true, issues: [] });
  });

  it('asks to move closer when the card is small', () => {
    expect(check(cardQuad({ x: 360, y: 480 }, 220)).issues).toContain('too-small');
  });

  it('asks to fit the whole card in when a corner is cut off', () => {
    expect(check(cardQuad({ x: 360, y: 430 }, 940)).issues[0]).toBe('out-of-frame');
  });

  it('asks to hold still when the title is blurred', () => {
    expect(check(undefined, (card) => blurred(card, 3)).issues).toContain('blurry');
  });

  it('asks to tilt the card when glare washes out the title', () => {
    const glare = (card: RgbaImage) => {
      const out = { ...card, data: new Uint8ClampedArray(card.data) };
      for (let y = 30; y < 75; y++) for (let x = 30; x < 300; x++) out.data.fill(255, (y * card.width + x) * 4, (y * card.width + x) * 4 + 3);
      return out;
    };
    expect(check(undefined, glare).issues).toContain('glare');
  });

  it('asks for light when the card is very dark', () => {
    const dim = (card: RgbaImage) => ({ ...card, data: card.data.map((v, i) => (i % 4 === 3 ? v : v * 0.15)) });
    expect(check(undefined, dim).issues).toContain('too-dark');
  });
});
