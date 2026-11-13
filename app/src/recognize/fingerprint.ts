/**
 * Visual fingerprints: perceptual hashes of a card's artwork and of the whole
 * card, compared by Hamming distance. The index builder hashes Scryfall's
 * images with exactly this code, so a change here needs FINGERPRINT_VERSION
 * bumped and the hash index rebuilt.
 *
 * Each hash is a 64-bit pHash: the region is resampled to 32×32 grey, the
 * lowest 64 DCT frequencies (after the DC term, in zig-zag order) are taken,
 * and each bit says whether a coefficient is above their median. Low
 * frequencies survive blur, JPEG, noise, lighting and small misalignment.
 */
import { applyHomography, homography, type Homography, type Point, type Quad } from '../vision/geometry';
import { createGray, luma, type Box, type GrayImage, type RgbaImage } from '../vision/image';
import { warpQuad } from '../vision/rectify';
import { fillHotspot, findHotspot } from '../vision/glare';

export const FINGERPRINT_VERSION = 1;
/** One 64-bit hash. */
export const HASH_BYTES = 8;
/** Art hash, then card hash. */
export const FINGERPRINT_BYTES = 2 * HASH_BYTES;
export const FINGERPRINT_WORDS = FINGERPRINT_BYTES / 4;

const N = 32;
/** Coefficients with u + v ≤ MAX_DIAGONAL are computed; the first 65 of them in zig-zag order are used. */
const MAX_DIAGONAL = 10;
const BITS = 64;

const COS: Float64Array[] = Array.from({ length: MAX_DIAGONAL + 1 }, (_, k) => {
  const row = new Float64Array(N);
  for (let n = 0; n < N; n++) row[n] = Math.cos((Math.PI * (2 * n + 1) * k) / (2 * N));
  return row;
});

/** (u, v) pairs in zig-zag order, DC excluded, BITS of them. */
const ZIGZAG: [number, number][] = (() => {
  const pairs: [number, number][] = [];
  for (let d = 1; d <= MAX_DIAGONAL; d++) {
    for (let i = 0; i <= d; i++) pairs.push(d % 2 === 0 ? [d - i, i] : [i, d - i]);
  }
  return pairs.slice(0, BITS);
})();

/** pHash of a 32×32 grey image, as 8 bytes. */
export function phash32(gray: GrayImage): Uint8Array {
  if (gray.width !== N || gray.height !== N) throw new Error('phash32 needs a 32×32 image');
  // Rows first: R[y][k] = Σx g[y][x]·cos_k(x).
  const rows = new Float64Array(N * (MAX_DIAGONAL + 1));
  for (let y = 0; y < N; y++) {
    for (let k = 0; k <= MAX_DIAGONAL; k++) {
      let sum = 0;
      const c = COS[k]!;
      for (let x = 0; x < N; x++) sum += gray.data[y * N + x]! * c[x]!;
      rows[y * (MAX_DIAGONAL + 1) + k] = sum;
    }
  }
  const coefficients = ZIGZAG.map(([u, v]) => {
    let sum = 0;
    const c = COS[u]!;
    for (let y = 0; y < N; y++) sum += rows[y * (MAX_DIAGONAL + 1) + v]! * c[y]!;
    return sum;
  });
  const sorted = [...coefficients].sort((a, b) => a - b);
  const median = (sorted[BITS / 2 - 1]! + sorted[BITS / 2]!) / 2;
  const out = new Uint8Array(HASH_BYTES);
  coefficients.forEach((value, i) => {
    if (value > median) out[i >> 3]! |= 1 << (i & 7);
  });
  return out;
}

/** Maps canonical card coordinates to image coordinates (pixel edges, so a card image of size w×h is a plain scale). */
export type CardMapping = Homography;

/** The mapping that puts the canonical card rectangle on four detected corners (pixel centres, reading order). */
export function cornersMapping(corners: Quad, size: { width: number; height: number }): CardMapping | null {
  return homography(
    [
      { x: 0, y: 0 },
      { x: size.width, y: 0 },
      { x: size.width, y: size.height },
      { x: 0, y: size.height },
    ],
    corners.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 })),
  );
}

/** Where a box of card coordinates lands in the image, as corners for warpQuad (pixel centres). */
export function boxCorners(mapping: CardMapping, box: Box): Quad {
  const at = (x: number, y: number): Point => {
    const p = applyHomography(mapping, x, y);
    return { x: p.x - 0.5, y: p.y - 0.5 };
  };
  return [at(box.x, box.y), at(box.x + box.width, box.y), at(box.x + box.width, box.y + box.height), at(box.x, box.y + box.height)];
}

/**
 * The card resampled to the scale of the index's images (Scryfall `small`:
 * 146×204 for a 488×680 card), with a margin around it, ready for hashing any
 * box quickly. Boxes are averaged exactly through a summed-area table, so
 * trying many slightly different registrations costs little.
 */
export interface FingerprintCanvas {
  gray: GrayImage;
  /** Summed-area table of `gray`, (width + 1) × (height + 1). */
  sat: Float64Array;
  /** Canvas pixels per card unit, across and down. */
  scaleX: number;
  scaleY: number;
  /** Card coordinate at the canvas's left and top edge. */
  originX: number;
  originY: number;
}

/** Index images are Scryfall `small` scans: 146 px across a 488-unit card. */
export const CANVAS_SCALE = 146 / 488;

function summedArea(gray: GrayImage): Float64Array {
  const w = gray.width + 1;
  const sat = new Float64Array(w * (gray.height + 1));
  for (let y = 0; y < gray.height; y++) {
    let row = 0;
    for (let x = 0; x < gray.width; x++) {
      row += gray.data[y * gray.width + x]!;
      sat[(y + 1) * w + x + 1] = sat[y * w + x + 1]! + row;
    }
  }
  return sat;
}

function grayOf(image: RgbaImage): GrayImage {
  const out = createGray(image.width, image.height);
  for (let i = 0, p = 0; i < out.data.length; i++, p += 4) out.data[i] = luma(image.data[p]!, image.data[p + 1]!, image.data[p + 2]!);
  return out;
}

/** A card image that is exactly the card (an index image). */
export function canvasFromCardImage(image: RgbaImage, size: { width: number; height: number }): FingerprintCanvas {
  const gray = grayOf(image);
  return { gray, sat: summedArea(gray), scaleX: image.width / size.width, scaleY: image.height / size.height, originX: 0, originY: 0 };
}

/**
 * A card in a photo: `mapping` places card coordinates in the frame, and
 * `margin` card units around the card are kept, so that boxes slightly
 * outside the mapped card can be tried too.
 */
export function canvasFromFrame(
  frame: RgbaImage,
  mapping: CardMapping,
  size: { width: number; height: number },
  margin: number,
): FingerprintCanvas {
  const box = { x: -margin, y: -margin, width: size.width + 2 * margin, height: size.height + 2 * margin };
  const width = Math.round(box.width * CANVAS_SCALE);
  const height = Math.round(box.height * CANVAS_SCALE);
  const gray = grayOf(warpQuad(frame, boxCorners(mapping, box), { width, height }));
  return { gray, sat: summedArea(gray), scaleX: width / box.width, scaleY: height / box.height, originX: -margin, originY: -margin };
}

/** Card units kept clear of hotspot detection along each edge, so a white border never counts as one. */
const HOTSPOT_INSET = { x: 0.06, y: 0.05 };

/**
 * The canvas with a flashlight's reflection painted over (see glare.ts), or
 * null when the card has none: the same canvas otherwise, so fingerprints of
 * cards without a hotspot are unchanged.
 */
export function deglared(canvas: FingerprintCanvas, size: { width: number; height: number }): FingerprintCanvas | null {
  const toX = (x: number) => (x - canvas.originX) * canvas.scaleX;
  const toY = (y: number) => (y - canvas.originY) * canvas.scaleY;
  const hotspot = findHotspot(canvas.gray, {
    x0: toX(size.width * HOTSPOT_INSET.x),
    y0: toY(size.height * HOTSPOT_INSET.y),
    x1: toX(size.width * (1 - HOTSPOT_INSET.x)),
    y1: toY(size.height * (1 - HOTSPOT_INSET.y)),
  });
  if (!hotspot) return null;
  const gray = fillHotspot(canvas.gray, hotspot);
  return { ...canvas, gray, sat: summedArea(gray) };
}

/** The summed-area table at a fractional position, bilinearly. */
function satAt(canvas: FingerprintCanvas, x: number, y: number): number {
  const { gray, sat } = canvas;
  const w = gray.width + 1;
  const fx = Math.min(gray.width, Math.max(0, x));
  const fy = Math.min(gray.height, Math.max(0, y));
  const x0 = Math.min(gray.width - 1, Math.floor(fx));
  const y0 = Math.min(gray.height - 1, Math.floor(fy));
  const wx = fx - x0;
  const wy = fy - y0;
  const top = sat[y0 * w + x0]! * (1 - wx) + sat[y0 * w + x0 + 1]! * wx;
  const bottom = sat[(y0 + 1) * w + x0]! * (1 - wx) + sat[(y0 + 1) * w + x0 + 1]! * wx;
  return top * (1 - wy) + bottom * wy;
}

/**
 * A box of card coordinates, averaged down to N×N grey. `card` says where the
 * real card is in the canvas's card coordinates ([x0, y0, x1, y1]); for an
 * index image it is the canonical rectangle.
 */
export function sampleBox(canvas: FingerprintCanvas, box: Box, card: CardPlacement, size: { width: number; height: number }): GrayImage {
  const out = createGray(N, N);
  const kx = (card[2] - card[0]) / size.width;
  const ky = (card[3] - card[1]) / size.height;
  const toX = (x: number) => (card[0] + x * kx - canvas.originX) * canvas.scaleX;
  const toY = (y: number) => (card[1] + y * ky - canvas.originY) * canvas.scaleY;
  const xs = new Float64Array(N + 1);
  const ys = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) {
    xs[i] = toX(box.x + (box.width * i) / N);
    ys[i] = toY(box.y + (box.height * i) / N);
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const area = (xs[x + 1]! - xs[x]!) * (ys[y + 1]! - ys[y]!);
      const sum =
        satAt(canvas, xs[x + 1]!, ys[y + 1]!) - satAt(canvas, xs[x]!, ys[y + 1]!) - satAt(canvas, xs[x + 1]!, ys[y]!) + satAt(canvas, xs[x]!, ys[y]!);
      out.data[y * N + x] = area > 0 ? sum / area : 0;
    }
  }
  return out;
}

/** Where the real card lies in a canvas's card coordinates: [x0, y0, x1, y1]. */
export type CardPlacement = readonly [number, number, number, number];

export interface FingerprintRegions {
  size: { width: number; height: number };
  art: Box;
}

/** Art hash then card hash, FINGERPRINT_BYTES in all. */
export function fingerprintAt(canvas: FingerprintCanvas, regions: FingerprintRegions, card?: CardPlacement): Uint8Array {
  const placement = card ?? [0, 0, regions.size.width, regions.size.height];
  const out = new Uint8Array(FINGERPRINT_BYTES);
  out.set(phash32(sampleBox(canvas, regions.art, placement, regions.size)), 0);
  const whole = { x: 0, y: 0, width: regions.size.width, height: regions.size.height };
  out.set(phash32(sampleBox(canvas, whole, placement, regions.size)), HASH_BYTES);
  return out;
}

/** The fingerprint of an index image. */
export function fingerprintCardImage(image: RgbaImage, regions: FingerprintRegions): Uint8Array {
  return fingerprintAt(canvasFromCardImage(image, regions.size), regions);
}

export function popcount32(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function toWords(bytes: Uint8Array): Uint32Array {
  const words = new Uint32Array(bytes.length / 4);
  for (let i = 0; i < words.length; i++) {
    words[i] = (bytes[i * 4]! | (bytes[i * 4 + 1]! << 8) | (bytes[i * 4 + 2]! << 16) | (bytes[i * 4 + 3]! << 24)) >>> 0;
  }
  return words;
}

export interface HashDistance {
  art: number;
  card: number;
}

/** Hamming distances between a query fingerprint and row `row` of a table of fingerprints (FINGERPRINT_WORDS per row). */
export function distanceAt(query: Uint32Array, table: Uint32Array, row: number): HashDistance {
  const o = row * FINGERPRINT_WORDS;
  return {
    art: popcount32(query[0]! ^ table[o]!) + popcount32(query[1]! ^ table[o + 1]!),
    card: popcount32(query[2]! ^ table[o + 2]!) + popcount32(query[3]! ^ table[o + 3]!),
  };
}

/** A row of zeros marks a printing without an image. */
export function isEmptyRow(table: Uint32Array, row: number): boolean {
  const o = row * FINGERPRINT_WORDS;
  return (table[o]! | table[o + 1]! | table[o + 2]! | table[o + 3]!) === 0;
}
