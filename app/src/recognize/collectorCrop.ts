/**
 * Cuts the collector line out of the photo for OCR. The text is tiny (about
 * 7 card pixels tall at 488×680), so the band is warped straight from the
 * frame at several times canonical scale rather than from the rectified card,
 * keeping whatever detail the camera captured. Lines are then found inside the
 * band, like the title, which absorbs small registration errors.
 */
import type { Box, GrayImage, RgbaImage } from '../vision/image';
import { toGray } from '../vision/image';
import { warpQuad } from '../vision/rectify';
import { boxCorners, type CardMapping } from './fingerprint';
import { binarizeLine, pad, stretched, strokeProfile } from './titleCrop';

export interface CollectorRegion {
  /** Band to search, in card pixels. */
  search: Box;
  /** Height of one collector line, in card pixels. */
  lineHeight: number;
  /** At most this many lines are read: the lowest of the strong ones. */
  maxLines: number;
}

export interface CollectorLineCrop {
  /** Black text on white, padded, ready for OCR. */
  image: GrayImage;
  /** Contrast-stretched grey, to try when `image` reads poorly. */
  alternative: GrayImage;
  /** Where the line was found, in card pixels. */
  box: Box;
}

/** Band pixels per card pixel. Tesseract reads 25–40 px tall capitals best. */
const SCALE = 4;
const PADDING = 10;
/**
 * A gap this wide (card pixels) ends the useful text: what follows is the
 * holofoil stamp, the ™ line or the artist's name, never the set or number.
 * Word gaps, even "405      R", are narrower.
 */
const END_GAP = 34;

/** Whites out everything after the first gap of `gap` empty columns that follows some ink. */
export function cutAtGap(image: GrayImage, gap: number): GrayImage {
  const { width, height, data } = image;
  let seenInk = false;
  let empty = 0;
  for (let x = 0; x < width; x++) {
    let ink = false;
    for (let y = 0; y < height && !ink; y++) ink = data[y * width + x]! < 128;
    if (ink) {
      seenInk = true;
      empty = 0;
    } else if (seenInk && ++empty >= gap) {
      const out = { width, height, data: data.slice() };
      for (let y = 0; y < height; y++) out.data.fill(255, y * width + x - empty + 1, (y + 1) * width);
      return out;
    }
  }
  return image;
}

/**
 * Up to `max` non-overlapping windows of `height` rows with the most stroke
 * energy, keeping only those with at least `floor` of the strongest one's.
 * Returned top to bottom.
 */
export function findTextLines(profile: Float32Array, height: number, max: number, floor = 0.35): number[] {
  const window = Math.min(height, profile.length);
  const sums: number[] = [];
  for (let top = 0; top + window <= profile.length; top++) {
    let sum = 0;
    for (let y = top; y < top + window; y++) sum += profile[y]!;
    sums.push(sum);
  }
  const chosen: number[] = [];
  const order = sums.map((sum, top) => ({ sum, top })).sort((a, b) => b.sum - a.sum);
  const best = order[0]?.sum ?? 0;
  for (const { sum, top } of order) {
    if (chosen.length >= max || sum < best * floor || sum <= 0) break;
    // Lines may sit close together, but never overlap by more than a fifth.
    if (chosen.some((other) => Math.abs(other - top) < window * 0.8)) continue;
    chosen.push(top);
  }
  return chosen.sort((a, b) => a - b);
}

export function cropCollectorLines(frame: RgbaImage, mapping: CardMapping, region: CollectorRegion): CollectorLineCrop[] {
  const { search } = region;
  const width = Math.round(search.width * SCALE);
  const height = Math.round(search.height * SCALE);
  const band = toGray(warpQuad(frame, boxCorners(mapping, search), { width, height }));
  const lineHeight = Math.round(region.lineHeight * SCALE);
  // The collector line is the bottom of the band: anything found above its rows is the end of
  // the text box, so only the lowest lines are read.
  const tops = findTextLines(strokeProfile(band), lineHeight, region.maxLines + 1).slice(-region.maxLines);
  const margin = Math.round(lineHeight * 0.2);
  return tops.map((top) => {
    const y0 = Math.max(0, top - margin);
    const y1 = Math.min(band.height, top + lineHeight + margin);
    const line: GrayImage = { width: band.width, height: y1 - y0, data: band.data.slice(y0 * band.width, y1 * band.width) };
    // The whole line decides which colour is ink: a strip of frame edge caught at the top or
    // bottom must not outvote the dark border the text sits on.
    const { image, inverted } = binarizeLine(line, 1);
    return {
      image: pad(cutAtGap(image, END_GAP * SCALE), PADDING),
      alternative: pad(stretched(line, inverted), PADDING),
      box: { x: search.x, y: search.y + y0 / SCALE, width: search.width, height: (y1 - y0) / SCALE },
    };
  });
}
