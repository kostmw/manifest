/**
 * A flashlight's reflection on a card: a compact, blown-out blob with a
 * bright halo, usually in the middle of the card (on the art). It shifts the
 * card's fingerprint far from the index's clean scans and from one frame to
 * the next. `findHotspot` finds it on a fingerprint canvas and `fillHotspot`
 * paints it over from its surroundings, which is close to what the card looks
 * like without it. Pure, so the worker and the eval share it.
 */
import { createGray, type GrayImage } from './image';

/** Grey at or above this is blown out. */
const BLOWN_OUT = 245;
/** The smallest blob that counts, as a share of the card's area: smaller ones are highlights in the art. */
const MIN_AREA = 0.004;
/** The largest: a card more blown out than this is a glare problem the quality gate reports. */
const MAX_AREA = 0.25;
/**
 * A reflection is a rough disc: it fills about 0.6–0.85 of its bounding box,
 * which isn't much longer one way than the other. A light text box or frame
 * is a rectangle (fills nearly all of it), a white streak in the art is long.
 */
const MIN_FILL = 0.45;
const MAX_FILL = 0.9;
const MAX_ELONGATION = 2.2;
/** The halo painted over too, as a multiple of the blob's radius beyond its edge. */
const HALO = 1.2;
/** Rounds of smoothing that spread the surroundings into the filled area. */
const FILL_ROUNDS = 40;

export interface Hotspot {
  /** 1 where the canvas is painted over: the blob and its halo. */
  mask: Uint8Array;
  /** The blob's area, as a share of the card's. */
  area: number;
  /** Its centre in canvas pixels. */
  x: number;
  y: number;
}

/**
 * The largest compact blown-out blob inside `card` (a box of canvas pixels,
 * already inset past the card's border so a white border never counts), or
 * null when there is none.
 */
export function findHotspot(gray: GrayImage, card: { x0: number; y0: number; x1: number; y1: number }): Hotspot | null {
  const { width, height, data } = gray;
  const x0 = Math.max(0, Math.round(card.x0));
  const y0 = Math.max(0, Math.round(card.y0));
  const x1 = Math.min(width, Math.round(card.x1));
  const y1 = Math.min(height, Math.round(card.y1));
  const cardArea = Math.max(1, (x1 - x0) * (y1 - y0));
  const label = new Int32Array(width * height);
  const stack: number[] = [];
  let best: { pixels: number[]; minX: number; maxX: number; minY: number; maxY: number } | null = null;
  let next = 1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const start = y * width + x;
      if (label[start] || data[start]! < BLOWN_OUT) continue;
      const pixels: number[] = [];
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      label[start] = next;
      stack.push(start);
      while (stack.length) {
        const p = stack.pop()!;
        pixels.push(p);
        const px = p % width;
        const py = (p - px) / width;
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minY = Math.min(minY, py);
        maxY = Math.max(maxY, py);
        for (const q of [p - 1, p + 1, p - width, p + width]) {
          const qx = q % width;
          const qy = (q - qx) / width;
          if (qx < x0 || qx >= x1 || qy < y0 || qy >= y1 || Math.abs(qx - px) > 1) continue;
          if (label[q] || data[q]! < BLOWN_OUT) continue;
          label[q] = next;
          stack.push(q);
        }
      }
      next += 1;
      if (!best || pixels.length > best.pixels.length) best = { pixels, minX, maxX, minY, maxY };
    }
  }
  if (!best) return null;
  const area = best.pixels.length / cardArea;
  const boxWidth = best.maxX - best.minX + 1;
  const boxHeight = best.maxY - best.minY + 1;
  const fill = best.pixels.length / (boxWidth * boxHeight);
  const elongation = Math.max(boxWidth, boxHeight) / Math.min(boxWidth, boxHeight);
  if (area < MIN_AREA || area > MAX_AREA || fill < MIN_FILL || fill > MAX_FILL || elongation > MAX_ELONGATION) return null;

  let sx = 0;
  let sy = 0;
  for (const p of best.pixels) {
    sx += p % width;
    sy += Math.floor(p / width);
  }
  const cx = sx / best.pixels.length;
  const cy = sy / best.pixels.length;
  // The blob's own radius, then the halo around it, as a disc.
  const radius = Math.sqrt(best.pixels.length / Math.PI);
  const reach = radius * (1 + HALO) + 1;
  const mask = new Uint8Array(width * height);
  for (const p of best.pixels) mask[p] = 1;
  for (let y = Math.max(0, Math.floor(cy - reach)); y <= Math.min(height - 1, Math.ceil(cy + reach)); y++) {
    for (let x = Math.max(0, Math.floor(cx - reach)); x <= Math.min(width - 1, Math.ceil(cx + reach)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= reach * reach) mask[y * width + x] = 1;
    }
  }
  return { mask, area, x: cx, y: cy };
}

/**
 * A copy of `gray` with the hotspot painted over: its pixels start at the
 * mean of the ring just outside it and are smoothed towards their unmasked
 * neighbours, so the fill follows the surroundings' gradients.
 */
export function fillHotspot(gray: GrayImage, hotspot: Hotspot): GrayImage {
  const { width, height } = gray;
  const out = createGray(width, height);
  out.data.set(gray.data);
  const { mask } = hotspot;
  const masked: number[] = [];
  let ring = 0;
  let ringCount = 0;
  for (let p = 0; p < mask.length; p++) {
    if (mask[p]) {
      masked.push(p);
      continue;
    }
    const x = p % width;
    const near = (x > 0 && mask[p - 1]) || (x < width - 1 && mask[p + 1]) || (p >= width && mask[p - width]) || (p + width < mask.length && mask[p + width]);
    if (near) {
      ring += gray.data[p]!;
      ringCount += 1;
    }
  }
  const start = ringCount ? ring / ringCount : 128;
  for (const p of masked) out.data[p] = start;
  for (let round = 0; round < FILL_ROUNDS; round++) {
    for (const p of masked) {
      const x = p % width;
      let sum = 0;
      let n = 0;
      if (x > 0) (sum += out.data[p - 1]!), n++;
      if (x < width - 1) (sum += out.data[p + 1]!), n++;
      if (p >= width) (sum += out.data[p - width]!), n++;
      if (p + width < out.data.length) (sum += out.data[p + width]!), n++;
      out.data[p] = sum / n;
    }
  }
  return out;
}
