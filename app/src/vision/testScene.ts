/**
 * Procedural card-like images for unit tests: no real card art, just the
 * layout that detection and title cropping care about. Test-only; nothing in
 * the app imports it.
 */
import { applyHomography, homography, type Point, type Quad } from './geometry';
import { createRgba, type RgbaImage } from './image';
import { PHONE_FOCAL_SHARE } from './perspective';

export type Rgb = [number, number, number];

export interface CardStyle {
  border?: Rgb;
  frame?: Rgb;
  bar?: Rgb;
  ink?: Rgb;
}

function fill(image: RgbaImage, x0: number, y0: number, x1: number, y1: number, color: Rgb): void {
  for (let y = Math.max(0, y0); y < Math.min(image.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(image.width, x1); x++) {
      const p = (y * image.width + x) * 4;
      image.data[p] = color[0];
      image.data[p + 1] = color[1];
      image.data[p + 2] = color[2];
      image.data[p + 3] = 255;
    }
  }
}

/** 488×680, laid out like a modern MTG card, with blocky "letters" in the title bar. */
export function makeCard(style: CardStyle = {}): RgbaImage {
  const { border = [15, 15, 15], frame = [180, 160, 120], bar = [235, 228, 210], ink = [20, 20, 20] } = style;
  const card = createRgba(488, 680);
  fill(card, 0, 0, 488, 680, border);
  fill(card, 20, 20, 468, 640, frame);
  fill(card, 30, 36, 458, 70, bar);
  // Letters: vertical strokes of varying width, like a word or two.
  for (let x = 42, i = 0; x < 300; i++) {
    const width = 3 + (i % 3);
    fill(card, x, 42, x + width, 64, ink);
    x += width + 4 + (i % 5 === 4 ? 10 : 0);
  }
  fill(card, 38, 80, 450, 376, [60, 80, 110]);
  fill(card, 30, 384, 458, 414, bar);
  fill(card, 38, 424, 450, 622, [240, 236, 226]);
  return card;
}

/** Puts `card` into a frame of `size` so its corners land on `corners`, over a flat background. */
export function placeCard(card: RgbaImage, size: { width: number; height: number }, corners: Quad, background: Rgb): RgbaImage {
  const out = createRgba(size.width, size.height);
  fill(out, 0, 0, size.width, size.height, background);
  const rect: Point[] = [
    { x: 0, y: 0 },
    { x: card.width, y: 0 },
    { x: card.width, y: card.height },
    { x: 0, y: card.height },
  ];
  const toCard = homography(corners, rect)!;
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const p = applyHomography(toCard, x + 0.5, y + 0.5);
      if (p.x < 0 || p.y < 0 || p.x >= card.width || p.y >= card.height) continue;
      const s = (Math.floor(p.y) * card.width + Math.floor(p.x)) * 4;
      const o = (y * size.width + x) * 4;
      out.data[o] = card.data[s]!;
      out.data[o + 1] = card.data[s + 1]!;
      out.data[o + 2] = card.data[s + 2]!;
    }
  }
  return out;
}

/** A card-shaped quad: `height` pixels tall, centred at `center`, turned by `angle` radians. */
export function cardQuad(center: Point, height: number, angle = 0, aspect = 488 / 680): Quad {
  const w = (height * aspect) / 2;
  const h = height / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    [-w, -h],
    [w, -h],
    [w, h],
    [-w, h],
  ].map(([x, y]) => ({ x: center.x + x! * cos - y! * sin, y: center.y + x! * sin + y! * cos })) as Quad;
}

/**
 * A card in the middle of the frame, seen by a phone camera tipped `tilt`
 * degrees back from straight above it (the top edge farther away): `height`
 * is how tall it would look straight on.
 */
export function tiltedCardQuad(frame: { width: number; height: number }, height: number, tilt: number, aspect = 488 / 680): Quad {
  const focal = PHONE_FOCAL_SHARE * Math.max(frame.width, frame.height);
  const t = (tilt * Math.PI) / 180;
  const w = (height * aspect) / 2;
  const h = height / 2;
  return [
    [-w, -h],
    [w, -h],
    [w, h],
    [-w, h],
  ].map(([x, y]) => {
    const scale = focal / (focal - y! * Math.sin(t));
    return { x: frame.width / 2 + x! * scale, y: frame.height / 2 + y! * Math.cos(t) * scale };
  }) as Quad;
}

/** Largest corner distance between two quads, whichever corner each starts from. */
export function cornerError(found: readonly Point[], truth: readonly Point[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let shift = 0; shift < 4; shift++) {
    let worst = 0;
    for (let i = 0; i < 4; i++) {
      worst = Math.max(worst, Math.hypot(found[i]!.x - truth[(i + shift) % 4]!.x, found[i]!.y - truth[(i + shift) % 4]!.y));
    }
    best = Math.min(best, worst);
  }
  return best;
}

/** A card whose art box holds soft blobs, a different pattern for every seed, so fingerprints can tell cards apart. */
export function artCard(seed: number): RgbaImage {
  const card = makeCard();
  let state = seed;
  const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  const blobs = Array.from({ length: 6 }, () => ({ x: random() * 412, y: random() * 296, r: 30 + random() * 90, v: random() * 220 }));
  for (let y = 80; y < 376; y++) {
    for (let x = 38; x < 450; x++) {
      let value = 40;
      for (const blob of blobs) value += blob.v * Math.exp(-((x - 38 - blob.x) ** 2 + (y - 80 - blob.y) ** 2) / (blob.r * blob.r));
      const p = (y * 488 + x) * 4;
      card.data[p] = Math.min(255, value);
      card.data[p + 1] = Math.min(255, value * 0.8);
      card.data[p + 2] = Math.min(255, value * 0.6);
    }
  }
  return card;
}

/** A 488×680 card shrunk to Scryfall's `small` size (146×204), as the fingerprint index is built from. */
export function scryfallSmall(card: RgbaImage): RgbaImage {
  const out = createRgba(146, 204);
  for (let y = 0; y < 204; y++) {
    for (let x = 0; x < 146; x++) {
      const s = (Math.floor((y * card.height) / 204) * card.width + Math.floor((x * card.width) / 146)) * 4;
      const o = (y * 146 + x) * 4;
      for (let c = 0; c < 4; c++) out.data[o + c] = card.data[s + c]!;
    }
  }
  return out;
}
