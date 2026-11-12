/**
 * A last guess at where the card is when no card-shaped outline was found:
 * the one the photo is centred on. A borderless card among other cards
 * touching it has no outline of its own (its art runs into its neighbours'
 * edges), but its sides are still long straight edges either side of the
 * middle of the frame, and its top and bottom long straight edges across it.
 * Upright cards only (as photographed, give or take a few degrees);
 * multi-card photos are M5's job.
 */
import { sobel } from './filters';
import { grayDownscaled, type RgbaImage } from './image';

/** An axis-aligned rectangle in image pixels: [x0, y0, x1, y1]. */
export type Box4 = readonly [number, number, number, number];

export interface CenterSearch {
  /** Card-sized rectangles around the middle, strongest edges first. */
  boxes: Box4[];
  /** Candidate edges, in image pixels, for refining a chosen box. */
  lefts: number[];
  rights: number[];
  rows: number[];
  /** Width ÷ height range a card may show (see SQUATTER and NARROWER). */
  aspects: readonly [number, number];
}

const WORKING_SIZE = 640;
/** Candidate edges kept on each side. */
const PEAKS = 5;
/** The card must be at least this share of the frame's width. */
const MIN_WIDTH = 0.35;
/**
 * Width ÷ height may be this much wider or narrower than a card's: a photo
 * taken a little off straight-on shortens the card (up to about 35°).
 */
const SQUATTER = 1.25;
const NARROWER = 0.85;
/** Side pairs kept for each top and bottom pair. */
const SIDES_PER_SPAN = 3;

/** Local maxima of a profile inside [from, to), strongest first. */
function peaks(profile: Float32Array, from: number, to: number, count: number): number[] {
  const found: number[] = [];
  for (let i = Math.max(1, from); i < Math.min(profile.length - 1, to); i++) {
    if (profile[i]! >= profile[i - 1]! && profile[i]! > profile[i + 1]!) found.push(i);
  }
  found.sort((a, b) => profile[b]! - profile[a]!);
  // No two within a few pixels: one edge, not several.
  const kept: number[] = [];
  for (const i of found) {
    if (kept.every((k) => Math.abs(k - i) > 4)) kept.push(i);
    if (kept.length >= count) break;
  }
  return kept;
}

/**
 * Up to `count` card-sized rectangles around the middle of the photo,
 * strongest edges first, with the edges they were made from. Edges alone can't
 * tell the card from its neighbours' borders, so the caller picks among them
 * (by artwork). `aspect` is a card's width ÷ height.
 */
export function centerCardSearch(image: RgbaImage, aspect: number, count = 48): CenterSearch {
  const { gray, scale } = grayDownscaled(image, WORKING_SIZE);
  const { width, height } = gray;
  const { gx, gy } = sobel(gray);

  // Vertical edges, summed down the middle third of the frame: long straight sides score highest.
  const rows = [Math.floor(height * 0.35), Math.ceil(height * 0.65)] as const;
  const columns = new Float32Array(width);
  for (let y = rows[0]; y < rows[1]; y++) for (let x = 0; x < width; x++) columns[x]! += Math.abs(gx[y * width + x]!);
  for (let x = 0; x < width; x++) columns[x]! /= rows[1] - rows[0];

  const lefts = peaks(columns, Math.floor(width * 0.02), Math.floor(width * 0.48), PEAKS);
  const rights = peaks(columns, Math.ceil(width * 0.52), Math.ceil(width * 0.98), PEAKS);
  const found: { box: Box4; score: number }[] = [];
  const at = (v: number) => (v + 0.5) / scale - 0.5;
  // Horizontal edges across the middle half, for refining a box's top and bottom later.
  const middleRows = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = Math.floor(width * 0.25); x < Math.ceil(width * 0.75); x++) sum += Math.abs(gy[y * width + x]!);
    middleRows[y] = sum;
  }
  for (const left of lefts) {
    for (const right of rights) {
      const cardWidth = right - left;
      if (cardWidth < width * MIN_WIDTH) continue;
      // Horizontal edges across the card's width (away from the corners).
      const x0 = Math.round(left + cardWidth * 0.1);
      const x1 = Math.round(right - cardWidth * 0.1);
      const across = new Float32Array(height);
      for (let y = 0; y < height; y++) {
        let sum = 0;
        for (let x = x0; x < x1; x++) sum += Math.abs(gy[y * width + x]!);
        across[y] = sum / Math.max(1, x1 - x0);
      }
      const tops = peaks(across, 1, height - 1, PEAKS * 3);
      const shortest = cardWidth / (aspect * SQUATTER);
      const tallest = cardWidth / (aspect * NARROWER);
      for (const top of tops) {
        for (const bottom of tops) {
          const cardHeight = bottom - top;
          if (cardHeight < shortest || cardHeight > tallest) continue;
          const middle = (top + bottom) / 2;
          if (middle < height * 0.25 || middle > height * 0.75) continue;
          // The photo is centred on the card it is of: rectangles away from the middle are its neighbours.
          const dx = ((left + right) / 2 - width / 2) / (width * 0.2);
          const dy = (middle - height / 2) / (height * 0.15);
          const centred = Math.exp(-(dx * dx + dy * dy) / 2);
          const score = ((columns[left]! + columns[right]! + across[top]! + across[bottom]!) / 4) * (0.3 + 0.7 * centred);
          found.push({ box: [at(left), at(top), at(right), at(bottom)], score });
        }
      }
    }
  }
  // A few rectangles per top and bottom edge pair, each with its best sides: otherwise the strong
  // edges of a neighbouring card fill every slot.
  found.sort((a, b) => b.score - a.score);
  const perRows = new Map<string, number>();
  const boxes: Box4[] = [];
  for (const { box } of found) {
    const key = `${Math.round(box[1])}:${Math.round(box[3])}`;
    const taken = perRows.get(key) ?? 0;
    if (taken >= SIDES_PER_SPAN) continue;
    perRows.set(key, taken + 1);
    boxes.push(box);
    if (boxes.length >= count) break;
  }
  return {
    boxes,
    lefts: lefts.map(at),
    rights: rights.map(at),
    rows: peaks(middleRows, 1, height - 1, PEAKS * 3).map(at),
    aspects: [aspect * NARROWER, aspect * SQUATTER],
  };
}

/**
 * Variations on a chosen box: its top and bottom with every pair of side edges,
 * and its sides with every pair of row edges, keeping a card's shape.
 */
export function refineBox(search: CenterSearch, box: Box4): Box4[] {
  const [x0, y0, x1, y1] = box;
  const [narrowest, widest] = search.aspects;
  const out: Box4[] = [];
  const fits = (w: number, h: number) => w > 0 && h > 0 && w / h >= narrowest && w / h <= widest;
  for (const left of search.lefts) for (const right of search.rights) if (fits(right - left, y1 - y0)) out.push([left, y0, right, y1]);
  for (const top of search.rows) for (const bottom of search.rows) if (fits(x1 - x0, bottom - top)) out.push([x0, top, x1, bottom]);
  return out;
}
