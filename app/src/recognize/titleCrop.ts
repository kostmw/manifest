/**
 * Finds the title line inside a search band of the rectified card and makes a
 * tight, binarized, black-on-white strip of it for OCR. Searching instead of
 * cropping a fixed box absorbs the small offsets that sleeves and a missed
 * outer border cause.
 */
import { otsuThreshold, sobel } from '../vision/filters';
import { createGray, cropGray, resizeGray, toGray, type Box, type GrayImage, type RgbaImage } from '../vision/image';
import { warpQuad } from '../vision/rectify';
import { boxCorners, type CardMapping } from './fingerprint';

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
  /**
   * Last tries, made on first use, for when the renderings above all read
   * poorly: the line cleaned of rules and border (see cleanLine), and the same
   * from the region's wider band. A title surrounded by its bar's outline, or
   * clipped at one end by an outline a little off to the side, reads from
   * these; an unreadable one gives junk, so their readings count only when sure.
   */
  rescue: (() => GrayImage)[];
}

/** Text height the OCR engine reads best, in pixels. */
const TARGET_LINE_HEIGHT = 56;
const PADDING = 12;

/** Row-wise density of vertical strokes. Text has many; frame lines and flat bars have few. */
export function strokeProfile(gray: GrayImage): Float32Array {
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
 * Otsu, then decides which side is text: in the middle rows (`middleRows` of
 * the height), where the letters are, ink is the minority even for a long bold
 * name, while the strip's edges can be either colour (frame lines, shadows).
 * Text becomes 0, background 255.
 */
export function binarizeLine(gray: GrayImage, middleRows = 0.5): { image: GrayImage; inverted: boolean } {
  const threshold = otsuThreshold(gray.data);
  const { width, height, data } = gray;
  let dark = 0;
  let counted = 0;
  const skip = (1 - middleRows) / 2;
  for (let y = Math.floor(height * skip); y < Math.ceil(height * (1 - skip)); y++) {
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

/** A rule (frame line, bar edge) spans at least this share of the strip's width in a row. */
const RULE_SHARE = 0.4;
/**
 * A border blob at the strip's left or right end spans nearly all of its
 * height; a letter there (a tall thin "I") spans about three quarters.
 */
const EDGE_BLOB_HEIGHT = 0.9;
/** …and no wider than this share of its width (a long name's first letter isn't). */
const EDGE_BLOB_WIDTH = 0.12;
/** Rule rows are cleared only this close to the strip's top or bottom, where frame lines lie… */
const RULE_ZONE = 0.3;
/** …unless the rule is thin (at most this share of the height), wherever it lies. */
const THIN_RULE = 0.12;
/** A piece of a rule left after its long rows are cleared is a letter only if at least this share of the strip's height. */
const RULE_REMNANT_HEIGHT = 0.35;

/**
 * Whites out what isn't letters in a binarized line (text 0, background 255):
 * rows of a blob that run across much of the strip (the title bar's outline,
 * the top of the art, a frame line the text touches) and tall blobs against
 * the strip's ends (the card's border caught when the outline is a little
 * off). Letters, even ones joined to a rule, keep their other rows.
 */
export function cleanLine(image: GrayImage): GrayImage {
  const { width, height, data } = image;
  const out = createGray(width, height);
  out.data.set(data);
  const label = new Int32Array(width * height);
  /** Pixels of a wide blob that survived its rule rows being cleared. */
  const fromRule = new Uint8Array(width * height);
  const stack: number[] = [];
  let next = 0;
  for (let start = 0; start < data.length; start++) {
    if (data[start]! >= 128 || label[start]) continue;
    next += 1;
    const pixels: number[] = [];
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    label[start] = next;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      pixels.push(p);
      const x = p % width;
      const y = (p - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && !label[p - 1] && data[p - 1]! < 128) (label[p - 1] = next), stack.push(p - 1);
      if (x < width - 1 && !label[p + 1] && data[p + 1]! < 128) (label[p + 1] = next), stack.push(p + 1);
      if (y > 0 && !label[p - width] && data[p - width]! < 128) (label[p - width] = next), stack.push(p - width);
      if (y < height - 1 && !label[p + width] && data[p + width]! < 128) (label[p + width] = next), stack.push(p + width);
    }
    const blobWidth = maxX - minX + 1;
    const blobHeight = maxY - minY + 1;
    const atEnd = minX <= 1 || maxX >= width - 2;
    if (atEnd && blobHeight >= height * EDGE_BLOB_HEIGHT && blobWidth <= width * EDGE_BLOB_WIDTH) {
      for (const p of pixels) out.data[p] = 255;
      continue;
    }
    if (blobWidth < width * RULE_SHARE) continue;
    // A wide blob: clear the rows where it runs across the strip, keep the rest (letters touching
    // it). Frame lines and bar edges lie above and below the letters; a thick band through the
    // middle is blurred letters run together, which stay.
    const perRow = new Int32Array(height);
    for (const p of pixels) perRow[Math.floor(p / width)]! += 1;
    const isRule = (y: number) => perRow[y]! >= width * RULE_SHARE;
    let ruleRows = 0;
    for (let y = 0; y < height; y++) if (isRule(y)) ruleRows += 1;
    const thin = ruleRows <= height * THIN_RULE;
    const clear = (y: number) => isRule(y) && (thin || y < height * RULE_ZONE || y >= height * (1 - RULE_ZONE));
    let cleared = false;
    for (const p of pixels) {
      if (clear(Math.floor(p / width))) {
        out.data[p] = 255;
        cleared = true;
      }
    }
    if (cleared) for (const p of pixels) if (out.data[p]! < 128) fromRule[p] = 1;
  }
  // What is left of a rule: the bar's curved ends and thin stubs go, letters that touched it stay.
  const seen = new Uint8Array(width * height);
  for (let start = 0; start < fromRule.length; start++) {
    if (!fromRule[start] || seen[start] || out.data[start]! >= 128) continue;
    const piece: number[] = [];
    let minY = height;
    let maxY = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      piece.push(p);
      const y = Math.floor(p / width);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const x = p % width;
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
        if (q < 0 || q >= fromRule.length || seen[q] || !fromRule[q] || out.data[q]! >= 128) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    if (maxY - minY + 1 < height * RULE_REMNANT_HEIGHT) for (const p of piece) out.data[p] = 255;
  }
  return out;
}

export function pad(image: GrayImage, amount: number): GrayImage {
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
  /**
   * A wider band at the same height, read when the first reading isn't sure:
   * it catches a name whose first letter the usual band clips when the
   * outline is a little off to one side.
   */
  wide?: Box;
  /** Height of a title line, in card pixels. */
  lineHeight: number;
  /** Where the title line's centre usually is, in card pixels. */
  expectedCenterY: number;
}

export function cropTitle(card: RgbaImage, region: TitleRegion): TitleCrop {
  const gray = toGray(card);
  return cropTitleFromBand(cropGray(gray, region.search), region, 1, (wide) => cropGray(gray, wide));
}

/** Pixels per card pixel worth reading the title at: beyond this, OCR gains nothing. */
export const MAX_TITLE_DETAIL = TARGET_LINE_HEIGHT / 32;

/**
 * The title from the search band warped straight out of the photo at `scale`
 * band pixels per card pixel. A photo often holds the card at two or three
 * times canonical size, and rectifying to 488×680 first would throw that
 * detail away; the title on the far edge of a tilted card needs all of it.
 */
export function cropTitleFromFrame(frame: RgbaImage, mapping: CardMapping, region: TitleRegion, scale: number): TitleCrop {
  const band = (box: Box) => {
    const size = { width: Math.round(box.width * scale), height: Math.round(box.height * scale) };
    return toGray(warpQuad(frame, boxCorners(mapping, box), size));
  };
  const first = band(region.search);
  return cropTitleFromBand(first, region, first.width / region.search.width, band);
}

/** The title line found in a band holding `scale` pixels per card pixel, binarized, without cleaning. */
function lineOf(band: GrayImage, region: TitleRegion, scale: number) {
  const lineHeight = region.lineHeight * scale;
  const top = findTextLine(strokeProfile(band), Math.round(lineHeight), (region.expectedCenterY - region.search.y) * scale, lineHeight);
  const margin = Math.round(lineHeight * 0.15);
  const y0 = Math.max(0, top - margin);
  const y1 = Math.min(band.height, top + Math.round(lineHeight) + margin);
  const line = cropGray(band, { x: 0, y: y0, width: band.width, height: y1 - y0 });
  const resize = TARGET_LINE_HEIGHT / lineHeight;
  const big = resize === 1 ? line : resizeGray(line, Math.round(line.width * resize), Math.round(line.height * resize));
  return binarizeLine(big).image;
}

/**
 * Finds the title line in a search band holding `scale` pixels per card
 * pixel. `bandAt` cuts another band (the region's wider one) at the same scale.
 */
function cropTitleFromBand(band: GrayImage, region: TitleRegion, scale: number, bandAt?: (box: Box) => GrayImage): TitleCrop {
  const lineHeight = region.lineHeight * scale;
  const top = findTextLine(strokeProfile(band), Math.round(lineHeight), (region.expectedCenterY - region.search.y) * scale, lineHeight);
  // A little room above and below, so ascenders and descenders survive.
  const margin = Math.round(lineHeight * 0.15);
  const y0 = Math.max(0, top - margin);
  const y1 = Math.min(band.height, top + Math.round(lineHeight) + margin);
  const line = cropGray(band, { x: 0, y: y0, width: band.width, height: y1 - y0 });

  const resize = TARGET_LINE_HEIGHT / lineHeight;
  const big = resize === 1 ? line : resizeGray(line, Math.round(line.width * resize), Math.round(line.height * resize));
  const { image, inverted } = binarizeLine(big);
  const { wide } = region;
  return {
    image: pad(image, PADDING),
    alternatives: [pad(stretched(big, inverted), PADDING), pad(strictThreshold(big, inverted), PADDING)],
    box: { x: region.search.x, y: region.search.y + y0 / scale, width: band.width / scale, height: (y1 - y0) / scale },
    inverted,
    rescue: [
      () => pad(cleanLine(image), PADDING),
      ...(wide && bandAt ? [() => pad(cleanLine(lineOf(bandAt(wide), region, scale)), PADDING)] : []),
    ],
  };
}
