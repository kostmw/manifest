/**
 * Finds the title line inside a search band of the rectified card and makes a
 * tight, binarized, black-on-white strip of it for OCR. Searching instead of
 * cropping a fixed box absorbs the small offsets that sleeves and a missed
 * outer border cause.
 */
import { otsuThreshold, sobel } from '../vision/filters';
import { createGray, cropGray, resizeGray, toGray, type Box, type GrayImage, type RgbaImage } from '../vision/image';

export interface TitleCrop {
  /** Black text on white, padded, ready for OCR. */
  image: GrayImage;
  /**
   * Other renderings of the same line, to try when `image` reads poorly:
   * contrast-stretched grey (OCR binarizes it itself, which copes better with
   * shadowed text on textured old frames), and a strict threshold that keeps
   * only the most extreme pixels (light text with a dark outline).
   */
  alternatives: GrayImage[];
  /** Where the line was found, in card pixels. */
  box: Box;
  /** True when the title was light text on a dark bar. */
  inverted: boolean;
}

/** Text height the OCR engine reads best, in pixels. */
const TARGET_LINE_HEIGHT = 56;
const PADDING = 12;

/** Row-wise density of vertical strokes. Text has many; frame lines and flat bars have few. */
function strokeProfile(gray: GrayImage): Float32Array {
  const { gx } = sobel(gray);
  const profile = new Float32Array(gray.height);
  for (let y = 0; y < gray.height; y++) {
    let sum = 0;
    for (let x = 0; x < gray.width; x++) sum += Math.abs(gx[y * gray.width + x]!);
    profile[y] = sum / gray.width;
  }
  return profile;
}

/**
 * The window of `lineHeight` rows with the most stroke energy, favouring rows
 * near `expectedCenter`. Returns the window's top row.
 */
export function findTextLine(profile: Float32Array, lineHeight: number, expectedCenter: number, spread: number): number {
  let bestTop = 0;
  let bestScore = -1;
  const window = Math.min(lineHeight, profile.length);
  for (let top = 0; top + window <= profile.length; top++) {
    let sum = 0;
    for (let y = top; y < top + window; y++) sum += profile[y]!;
    const center = top + window / 2;
    const prior = Math.exp(-(((center - expectedCenter) / spread) ** 2) / 2);
    const score = sum * (0.4 + 0.6 * prior);
    if (score > bestScore) {
      bestScore = score;
      bestTop = top;
    }
  }
  return bestTop;
}

/**
 * Otsu, then decides which side is text: in the middle rows, where the letters
 * are, ink is the minority even for a long bold name, while the strip's edges
 * can be either colour (frame lines, shadows). Text becomes 0, background 255.
 */
export function binarizeLine(gray: GrayImage): { image: GrayImage; inverted: boolean } {
  const threshold = otsuThreshold(gray.data);
  const { width, height, data } = gray;
  let dark = 0;
  let counted = 0;
  for (let y = Math.floor(height * 0.25); y < Math.ceil(height * 0.75); y++) {
    for (let x = 0; x < width; x++) {
      counted++;
      if (data[y * width + x]! < threshold) dark++;
    }
  }
  const inverted = dark > counted / 2;
  const image = createGray(width, height);
  for (let i = 0; i < data.length; i++) {
    const isDark = data[i]! < threshold;
    image.data[i] = isDark !== inverted ? 0 : 255;
  }
  return { image, inverted };
}

function percentileOf(sorted: Float32Array, fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

/** Full-range grey with dark text: the 2nd–98th percentiles stretched to 0–255. */
export function stretched(gray: GrayImage, inverted: boolean): GrayImage {
  const sorted = Float32Array.from(gray.data).sort();
  const lo = percentileOf(sorted, 0.02);
  const hi = percentileOf(sorted, 0.98);
  const out = createGray(gray.width, gray.height);
  for (let i = 0; i < gray.data.length; i++) {
    const value = Math.max(0, Math.min(255, ((gray.data[i]! - lo) / Math.max(1, hi - lo)) * 255));
    out.data[i] = inverted ? 255 - value : value;
  }
  return out;
}

/** Text only where pixels are well past Otsu's threshold, towards the text's extreme. */
export function strictThreshold(gray: GrayImage, inverted: boolean): GrayImage {
  const sorted = Float32Array.from(gray.data).sort();
  const otsu = otsuThreshold(gray.data);
  const cut = inverted
    ? otsu + (percentileOf(sorted, 0.98) - otsu) * 0.45
    : otsu - (otsu - percentileOf(sorted, 0.02)) * 0.45;
  const out = createGray(gray.width, gray.height);
  for (let i = 0; i < gray.data.length; i++) {
    const text = inverted ? gray.data[i]! > cut : gray.data[i]! < cut;
    out.data[i] = text ? 0 : 255;
  }
  return out;
}

function pad(image: GrayImage, amount: number): GrayImage {
  const out = createGray(image.width + amount * 2, image.height + amount * 2);
  out.data.fill(255);
  for (let y = 0; y < image.height; y++) {
    out.data.set(image.data.subarray(y * image.width, (y + 1) * image.width), (y + amount) * out.width + amount);
  }
  return out;
}

export interface TitleRegion {
  /** Band to search, in card pixels. */
  search: Box;
  /** Height of a title line, in card pixels. */
  lineHeight: number;
  /** Where the title line's centre usually is, in card pixels. */
  expectedCenterY: number;
}

export function cropTitle(card: RgbaImage, region: TitleRegion): TitleCrop {
  const band = cropGray(toGray(card), region.search);
  const top = findTextLine(
    strokeProfile(band),
    region.lineHeight,
    region.expectedCenterY - region.search.y,
    region.lineHeight,
  );
  // A little room above and below, so ascenders and descenders survive.
  const margin = Math.round(region.lineHeight * 0.15);
  const y0 = Math.max(0, top - margin);
  const y1 = Math.min(band.height, top + region.lineHeight + margin);
  const line = cropGray(band, { x: 0, y: y0, width: band.width, height: y1 - y0 });

  const scale = TARGET_LINE_HEIGHT / region.lineHeight;
  const big = resizeGray(line, Math.round(line.width * scale), Math.round(line.height * scale));
  const { image, inverted } = binarizeLine(big);
  return {
    image: pad(image, PADDING),
    alternatives: [pad(stretched(big, inverted), PADDING), pad(strictThreshold(big, inverted), PADDING)],
    box: { x: region.search.x, y: region.search.y + y0, width: band.width, height: y1 - y0 },
    inverted,
  };
}
