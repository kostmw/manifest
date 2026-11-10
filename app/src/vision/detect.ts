/**
 * Finds card-shaped quadrilaterals in a frame: Canny edges, connected edge
 * components, the convex hull of each, the largest quadrilateral inside that
 * hull, then each side re-fitted to the edge pixels along it so that rounded
 * corners don't pull the corners inwards. Candidates are scored on aspect ratio
 * and on how much of each side really is an edge.
 */
import { dilate, edgeRidges, gaussianBlur, hysteresis, percentile, percentileNonZero } from './filters';
import {
  convexHull,
  distance,
  fitLine,
  intersect,
  isConvex,
  lineDistance,
  lineThrough,
  maxAreaQuad,
  orderCardCorners,
  perimeter,
  polygonArea,
  simplifyClosed,
  type Line,
  type Point,
  type Quad,
} from './geometry';
import { grayDownscaled, type GrayImage, type RgbaImage } from './image';
import { cardPose } from './perspective';

export interface DetectOptions {
  /** Card width ÷ height, upright. */
  aspect: number;
  /** Long side of the working image, in pixels. */
  workingSize?: number;
  /** Give up on candidates smaller than this fraction of the frame. */
  minAreaFraction?: number;
  /**
   * Printed border width as a share of the card's width. When set, a quad that
   * stopped at the inside of a dark border on a dark background is pushed out
   * to the card's real edge.
   */
  border?: number;
  /** Called for each rejected component, for the eval's failure report. */
  onReject?: (reason: string, detail: Record<string, number>) => void;
}

export interface CardDetection {
  /** In input-image pixels, in reading order (see orderCardCorners). */
  corners: Quad;
  score: number;
  /** Lowest share of any side that lies on an edge, 0–1. */
  edgeSupport: number;
  /** Short side ÷ long side, with the perspective of a tilted view taken out. */
  aspect: number;
  /** Degrees between the card's face and the camera's view (0: straight above it), assuming a phone camera. */
  tilt: number;
  /** Card area ÷ frame area. */
  areaFraction: number;
}

interface Component {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  points: Point[];
}

/** 8-connected components of a mask, keeping the outline points of those at least `minExtent` across. */
function components(mask: Uint8Array, width: number, height: number, minExtent: number): Component[] {
  const labels = new Int32Array(width * height);
  const stack = new Int32Array(width * height);
  const boxes: { minX: number; maxX: number; minY: number; maxY: number }[] = [];
  let next = 0;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    next += 1;
    const box = { minX: width, maxX: 0, minY: height, maxY: 0 };
    let top = 0;
    stack[top++] = start;
    labels[start] = next;
    while (top > 0) {
      const i = stack[--top]!;
      const x = i % width;
      const y = (i - x) / width;
      if (x < box.minX) box.minX = x;
      if (x > box.maxX) box.maxX = x;
      if (y < box.minY) box.minY = y;
      if (y > box.maxY) box.maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const j = ny * width + nx;
          if (mask[j] && !labels[j]) {
            labels[j] = next;
            stack[top++] = j;
          }
        }
      }
    }
    boxes.push(box);
  }

  const kept = new Map<number, { rowMin: Int32Array; rowMax: Int32Array; box: (typeof boxes)[number] }>();
  boxes.forEach((box, index) => {
    if (box.maxX - box.minX + 1 >= minExtent && box.maxY - box.minY + 1 >= minExtent) {
      kept.set(index + 1, { rowMin: new Int32Array(height).fill(-1), rowMax: new Int32Array(height).fill(-1), box });
    }
  });
  if (kept.size === 0) return [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const entry = kept.get(labels[y * width + x]!);
      if (!entry) continue;
      if (entry.rowMin[y] === -1) entry.rowMin[y] = x;
      entry.rowMax[y] = x;
    }
  }

  return [...kept.values()].map(({ rowMin, rowMax, box }) => {
    const points: Point[] = [];
    for (let y = box.minY; y <= box.maxY; y++) {
      if (rowMin[y] === -1) continue;
      points.push({ x: rowMin[y]!, y });
      if (rowMax[y] !== rowMin[y]) points.push({ x: rowMax[y]!, y });
    }
    return { ...box, points };
  });
}

/** Edge pixels near the middle 70% of segment a→b, within `band` of the line. */
function edgePointsAlong(a: Point, b: Point, band: number, edges: Uint8Array, width: number, height: number): Point[] {
  const line = lineThrough(a, b);
  const length = distance(a, b);
  const seen = new Set<number>();
  const points: Point[] = [];
  const steps = Math.ceil(length);
  for (let s = Math.floor(steps * 0.15); s <= Math.ceil(steps * 0.85); s++) {
    const t = s / steps;
    const px = a.x + (b.x - a.x) * t;
    const py = a.y + (b.y - a.y) * t;
    for (let o = -band; o <= band; o += 0.5) {
      const x = Math.round(px + line.nx * o);
      const y = Math.round(py + line.ny * o);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const index = y * width + x;
      if (!edges[index] || seen.has(index)) continue;
      seen.add(index);
      points.push({ x, y });
    }
  }
  return points;
}

/** Re-fits each side to nearby edge pixels and intersects the fitted lines. */
export function refineQuad(quad: readonly Point[], edges: Uint8Array, width: number, height: number, band: number): Point[] {
  const lines: Line[] = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i]!;
    const b = quad[(i + 1) % 4]!;
    const points = edgePointsAlong(a, b, band, edges, width, height);
    const straight = lineThrough(a, b);
    const fitted = points.length >= distance(a, b) * 0.25 ? fitLine(points) : null;
    // Reject a fit that swung away from the side it was meant to refine.
    const keep = fitted && Math.abs(fitted.nx * straight.nx + fitted.ny * straight.ny) > 0.98;
    lines.push(keep ? fitted : straight);
  }
  const corners: Point[] = [];
  for (let i = 0; i < 4; i++) {
    const corner = intersect(lines[(i + 3) % 4]!, lines[i]!);
    if (!corner) return [...quad];
    corners.push(corner);
  }
  const diagonal = Math.max(distance(quad[0]!, quad[2]!), distance(quad[1]!, quad[3]!));
  return corners.every((corner, i) => distance(corner, quad[i]!) < diagonal * 0.08) ? corners : [...quad];
}

/** Share of samples along the middle of each side that land on an edge: the weakest side, and the average. */
export function edgeSupport(
  quad: readonly Point[],
  edges: Uint8Array,
  width: number,
  height: number,
): { weakest: number; mean: number } {
  let weakest = 1;
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i]!;
    const b = quad[(i + 1) % 4]!;
    const samples = Math.max(16, Math.round(distance(a, b) / 2));
    let hits = 0;
    let counted = 0;
    for (let s = 0; s < samples; s++) {
      const t = 0.1 + (0.8 * (s + 0.5)) / samples;
      const x = Math.round(a.x + (b.x - a.x) * t);
      const y = Math.round(a.y + (b.y - a.y) * t);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      counted++;
      if (edges[y * width + x]) hits++;
    }
    const share = counted ? hits / counted : 0;
    weakest = Math.min(weakest, share);
    total += share;
  }
  return { weakest, mean: total / 4 };
}

function grayAt(gray: GrayImage, x: number, y: number): number {
  const fx = Math.min(gray.width - 1, Math.max(0, x));
  const fy = Math.min(gray.height - 1, Math.max(0, y));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(gray.width - 1, x0 + 1);
  const y1 = Math.min(gray.height - 1, y0 + 1);
  const wx = fx - x0;
  const wy = fy - y0;
  const at = (xx: number, yy: number) => gray.data[yy * gray.width + xx]!;
  return (at(x0, y0) * (1 - wx) + at(x1, y0) * wx) * (1 - wy) + (at(x0, y1) * (1 - wx) + at(x1, y1) * wx) * wy;
}

function median(values: number[]): number {
  const sorted = values.sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

interface BorderSide {
  /** A flat, dark band lies just outside the side. */
  band: boolean;
  /** How far out the card's edge is, in pixels, when a step is visible there. */
  edge: number | null;
  line: Line;
}

/**
 * Looks just outside one side of a quad for a dark border: a flat, dark band
 * and, where the mat isn't exactly as dark, a step (the card's edge). Medians
 * along the side ignore text printed on the border. `needBrighterInside` asks
 * that the quad's own edge be a light-to-dark step too, which holds everywhere
 * except the bottom of most frames.
 */
function borderBeyond(a: Point, b: Point, gray: GrayImage, expected: number, needBrighterInside: boolean): BorderSide {
  const line = lineThrough(a, b); // Its normal points into the quad.
  const maxOffset = Math.round(expected * 3);
  const steps = Math.ceil(distance(a, b));
  const values = new Map<number, number>();
  for (let d = -4; d <= maxOffset + 3; d++) {
    const samples: number[] = [];
    for (let s = Math.floor(steps * 0.15); s <= Math.ceil(steps * 0.85); s += 2) {
      const t = s / steps;
      samples.push(grayAt(gray, a.x + (b.x - a.x) * t - line.nx * d, a.y + (b.y - a.y) * t - line.ny * d));
    }
    values.set(d, median(samples));
  }
  const p = (d: number) => values.get(d)!;
  const mean = (from: number, to: number) => {
    let sum = 0;
    for (let d = from; d <= to; d++) sum += p(d);
    return sum / (to - from + 1);
  };

  // Skip the blurred tail of the quad's own edge before the band starts.
  const bandStart = Math.max(2, Math.ceil(expected * 0.35));
  const bandEnd = Math.max(bandStart + 1, Math.round(expected * 0.8));
  const inside = mean(-4, -2);
  const near = mean(bandStart, bandEnd);
  let nearRange = 0;
  for (let d = bandStart; d <= bandEnd; d++) nearRange = Math.max(nearRange, Math.abs(p(d) - near));
  const band = near < 80 && nearRange < 6 && (!needBrighterInside || inside - near > 20);

  let edge: number | null = null;
  if (band) {
    let strongest = 0;
    for (let d = bandEnd; d <= maxOffset; d++) {
      const local = Math.abs(p(d + 1) - p(d - 1));
      if (local > strongest) {
        strongest = local;
        edge = d;
      }
    }
    // A black border on a black mat can differ by only a few grey levels; medians over the
    // whole side keep the noise well below that. The local gradient rules out lighting ramps.
    const flatUpTo = edge === null ? false : Math.max(...Array.from({ length: edge - bandStart - 1 }, (_, i) => Math.abs(p(bandStart + i) - near)), 0) < 6;
    const step = edge === null ? 0 : Math.abs(mean(edge + 2, edge + 3) - near);
    if (!(flatUpTo && step >= 2.5 && strongest >= 2)) edge = null;
  }
  return { band, edge, line };
}

const shifted = (line: Line, by: number): Line => ({ nx: line.nx, ny: line.ny, c: line.c - by });

function cornersOf(lines: readonly Line[]): Point[] | null {
  const corners: Point[] = [];
  for (let i = 0; i < 4; i++) {
    const corner = intersect(lines[(i + 3) % 4]!, lines[i]!);
    if (!corner) return null;
    corners.push(corner);
  }
  return corners;
}

/**
 * A black border on a dark mat leaves only the border's inner edge visible, so
 * the quad found is the card's frame, not the card. This pushes the top and
 * sides out to the card's edge when all three show a dark border of matching
 * width. The bottom border is wider on most frames and often has text on it:
 * its own edge is used when visible, else the bottom is placed by aspect ratio.
 * Returns null, leaving the quad alone, unless everything agrees.
 */
export function expandDarkBorder(quad: readonly Point[], gray: GrayImage, border: number, aspect: number): Point[] | null {
  const cardWidth = (distance(quad[0]!, quad[1]!) + distance(quad[3]!, quad[2]!)) / 2;
  const expected = border * cardWidth;
  if (expected < 2) return null;

  // Top, right, left: all must show the band; the border is the same width on all three,
  // so a side whose edge is invisible (mat exactly as dark as the border) borrows the others'.
  const sides = [
    borderBeyond(quad[0]!, quad[1]!, gray, expected, true),
    borderBeyond(quad[1]!, quad[2]!, gray, expected, true),
    borderBeyond(quad[3]!, quad[0]!, gray, expected, true),
  ];
  if (!sides.every((side) => side.band)) return null;
  const edges = sides.map((side) => side.edge).filter((edge): edge is number => edge !== null);
  if (edges.length < 2 || Math.max(...edges) > Math.min(...edges) * 1.6) return null;
  const typical = median([...edges]);
  const [top, right, left] = sides.map((side) => shifted(side.line, side.edge ?? typical)) as [Line, Line, Line];

  const bottom = borderBeyond(quad[2]!, quad[3]!, gray, expected, false);
  if (bottom.edge !== null && bottom.edge >= typical * 0.7 && bottom.edge <= typical * 3.2) {
    return cornersOf([top, right, shifted(bottom.line, bottom.edge), left]);
  }

  // Place the bottom so the card has its expected aspect ratio.
  let shift = typical;
  for (let pass = 0; pass < 2; pass++) {
    const trial = cornersOf([top, right, shifted(bottom.line, shift), left]);
    if (!trial) return null;
    const width = (distance(trial[0]!, trial[1]!) + distance(trial[3]!, trial[2]!)) / 2;
    const height = (distance(trial[1]!, trial[2]!) + distance(trial[0]!, trial[3]!)) / 2;
    shift += width / aspect - height;
  }
  if (shift < typical * 0.7 || shift > typical * 3.2) return null;
  return cornersOf([top, right, shifted(bottom.line, shift), left]);
}

function contains(quad: readonly Point[], point: Point): boolean {
  for (let i = 0; i < 4; i++) {
    if (lineDistance(lineThrough(quad[i]!, quad[(i + 1) % 4]!), point) < 0) return false;
  }
  return true;
}

/** Edge cut-offs to try, weakest first: a textured background that swamps the card at one level drops out at a higher one. */
function edgeLevels(ridges: Float32Array): number[] {
  const levels = [Math.max(40, percentile(ridges, 0.9)), percentileNonZero(ridges, 0.9), percentileNonZero(ridges, 0.97)];
  return levels.filter((level, i) => level >= 40 && levels.findIndex((other) => Math.abs(other - level) < level * 0.15) === i);
}

/** Degrees of tilt below which an outline's shape is taken as it is, and above which its pose is implausible. */
const MIN_TILT = 15;
const MAX_TILT = 70;

function quadCandidates(
  edges: Uint8Array,
  gray: GrayImage,
  options: DetectOptions,
): { corners: Point[]; score: number; edgeSupport: number; aspect: number; areaFraction: number; tilt: number }[] {
  const { width, height } = gray;
  const minAreaFraction = options.minAreaFraction ?? 0.03;
  const joined = dilate(edges, width, height, 1);
  const minExtent = Math.sqrt(minAreaFraction * width * height) * 0.6;
  const frameArea = width * height;
  const reject = (reason: string, detail: Record<string, number> = {}) => options.onReject?.(reason, detail);

  const found = [];
  for (const component of components(joined, width, height, minExtent)) {
    const hull = convexHull(component.points);
    const hullArea = polygonArea(hull);
    if (hullArea < minAreaFraction * frameArea) {
      reject('small', { hullArea: hullArea / frameArea });
      continue;
    }

    let epsilon = perimeter(hull) * 0.01;
    let simplified = simplifyClosed(hull, epsilon);
    while (simplified.length > 16) {
      epsilon *= 1.5;
      simplified = simplifyClosed(hull, epsilon);
    }
    const rough = maxAreaQuad(simplified);
    if (!rough) continue;
    // A hull much bigger than its best quadrilateral is a blob or a card merged with clutter.
    if (hullArea / polygonArea(rough) > 1.25) {
      reject('not-quad', { fill: hullArea / polygonArea(rough), hullArea: hullArea / frameArea });
      continue;
    }

    const diagonal = Math.max(distance(rough[0]!, rough[2]!), distance(rough[1]!, rough[3]!));
    let refined = refineQuad(rough, edges, width, height, Math.max(2, diagonal * 0.012));
    refined = refineQuad(refined, edges, width, height, 1.5);
    if (!isConvex(refined)) {
      reject('not-convex');
      continue;
    }

    const seen = orderCardCorners(refined);
    // One side may fade into the background (dark art on a dark mat) if the rest is clear.
    const support = edgeSupport(seen, joined, width, height);
    if (support.weakest < 0.3 || support.mean < 0.55) {
      reject('edge-support', { weakest: support.weakest, mean: support.mean });
      continue;
    }

    // Edge support is judged on the edges actually seen; the card's own edge, when found
    // beyond a dark border, is invisible to Canny by nature.
    const expanded = options.border ? expandDarkBorder(seen, gray, options.border, options.aspect) : null;
    let ordered = expanded ? orderCardCorners(expanded) : seen;
    const top = distance(ordered[0], ordered[1]);
    const right = distance(ordered[1], ordered[2]);
    const bottom = distance(ordered[2], ordered[3]);
    const left = distance(ordered[3], ordered[0]);
    const outline = (top + bottom) / (left + right);
    // A card seen at an angle looks squatter than it is: judge its shape with the perspective
    // taken out, so a phone tilted 30–60° still finds the card (and can be told to hold flatter).
    // Nearly flat (under MIN_TILT), the correction is smaller than the noise in the corners, and
    // beyond MAX_TILT the pose is implausible: then, and whenever the outline itself looks more
    // like a card, the outline is used as it is.
    const pose = outline > 0.3 && outline < 1.7 ? cardPose(ordered as Quad, { width, height }) : null;
    let ratio = outline;
    if (pose && pose.tilt >= MIN_TILT && pose.tilt <= MAX_TILT) {
      // Seen steeply, the outline can be wider than tall: a long side was taken for the top.
      const sideways = pose.aspect > 1;
      const corrected = sideways ? 1 / pose.aspect : pose.aspect;
      if (Math.abs(corrected - options.aspect) < Math.abs(outline - options.aspect)) {
        ratio = corrected;
        if (sideways) ordered = [ordered[1], ordered[2], ordered[3], ordered[0]] as typeof ordered;
      }
    }
    if (ratio < options.aspect * 0.7 || ratio > Math.min(1, options.aspect * 1.3)) {
      reject('aspect', { ratio, outline });
      continue;
    }

    const areaFraction = polygonArea(ordered) / frameArea;
    const aspectScore = Math.exp(-(((ratio - options.aspect) / 0.1) ** 2));
    const score = support.mean * aspectScore * Math.min(1, 0.6 + areaFraction * 2);
    found.push({ corners: ordered, score, edgeSupport: support.weakest, aspect: ratio, areaFraction, tilt: pose && pose.tilt <= MAX_TILT ? pose.tilt : 0 });
  }
  return found;
}

const center = (quad: readonly Point[]) => ({
  x: quad.reduce((sum, p) => sum + p.x, 0) / quad.length,
  y: quad.reduce((sum, p) => sum + p.y, 0) / quad.length,
});

export function detectCards(image: RgbaImage, options: DetectOptions): CardDetection[] {
  const { gray, scale } = grayDownscaled(image, options.workingSize ?? 640);
  const { width, height } = gray;
  const blurred = gaussianBlur(gray, 1.2);
  const ridges = edgeRidges(blurred);

  // The same card found at several levels: keep its best-scoring version.
  const candidates: ReturnType<typeof quadCandidates> = [];
  for (const level of edgeLevels(ridges)) {
    for (const candidate of quadCandidates(hysteresis(ridges, width, height, level * 0.4, level), blurred, options)) {
      const diagonal = distance(candidate.corners[0]!, candidate.corners[2]!);
      const same = candidates.findIndex((other) =>
        other.corners.every((corner, i) => distance(corner, candidate.corners[i]!) < diagonal * 0.03),
      );
      if (same === -1) candidates.push(candidate);
      else if (candidate.score > candidates[same]!.score) candidates[same] = candidate;
    }
  }

  // A card's own frame line or sleeve edge gives a second, almost identical quad: keep the outer one.
  candidates.sort((a, b) => b.areaFraction - a.areaFraction);
  const kept: typeof candidates = [];
  const encloses = (outer: (typeof candidates)[number], inner: (typeof candidates)[number], minRatio: number) =>
    outer !== inner && inner.areaFraction / outer.areaFraction >= minRatio && contains(outer.corners, center(inner.corners));
  for (const candidate of candidates) {
    if (!kept.some((outer) => encloses(outer, candidate, 0.75))) kept.push(candidate);
  }

  // Art and text boxes sit inside the card, and the card may sit inside a card-shaped patch
  // of background. Whatever encloses others is tried first; the caller can fall back to the rest.
  const depth = new Map(kept.map((candidate) => [candidate, kept.filter((outer) => encloses(outer, candidate, 0.2)).length]));
  return kept
    .sort((a, b) => depth.get(a)! - depth.get(b)! || b.score - a.score)
    .map((candidate) => ({
      ...candidate,
      corners: candidate.corners.map((p) => ({ x: (p.x + 0.5) / scale - 0.5, y: (p.y + 0.5) / scale - 0.5 })) as Quad,
    }));
}
