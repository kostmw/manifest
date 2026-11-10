export interface Point {
  x: number;
  y: number;
}

/** Card corners in reading order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];

export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Convex hull (Andrew's monotone chain), counter-clockwise in y-up terms, so clockwise on screen. */
export function convexHull(points: readonly Point[]): Point[] {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const lower: Point[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const point = sorted[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Shoelace area, positive regardless of winding. */
export function polygonArea(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function perimeter(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) sum += distance(points[i]!, points[(i + 1) % points.length]!);
  return sum;
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function douglasPeucker(points: readonly Point[], epsilon: number): Point[] {
  if (points.length < 3) return [...points];
  let worst = 0;
  let index = 0;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  for (let i = 1; i < points.length - 1; i++) {
    const d = segmentDistance(points[i]!, first, last);
    if (d > worst) {
      worst = d;
      index = i;
    }
  }
  if (worst <= epsilon) return [first, last];
  const left = douglasPeucker(points.slice(0, index + 1), epsilon);
  const right = douglasPeucker(points.slice(index), epsilon);
  return left.slice(0, -1).concat(right);
}

/** Douglas-Peucker on a closed polygon, split at its two farthest-apart vertices. */
export function simplifyClosed(points: readonly Point[], epsilon: number): Point[] {
  if (points.length <= 4) return [...points];
  let start = 0;
  let far = 0;
  let best = -1;
  for (let i = 0; i < points.length; i++) {
    const d = distance(points[0]!, points[i]!);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  start = far;
  best = -1;
  for (let i = 0; i < points.length; i++) {
    const d = distance(points[start]!, points[i]!);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const rotated = points.slice(start).concat(points.slice(0, start));
  const split = (far - start + points.length) % points.length;
  const a = douglasPeucker(rotated.slice(0, split + 1), epsilon);
  const b = douglasPeucker(rotated.slice(split).concat([rotated[0]!]), epsilon);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

const triangleArea = (a: Point, b: Point, c: Point) => Math.abs(cross(a, b, c)) / 2;

/** The largest-area quadrilateral whose corners are vertices of a convex polygon. O(n³), for small n. */
export function maxAreaQuad(polygon: readonly Point[]): Point[] | null {
  const n = polygon.length;
  if (n < 4) return null;
  let best = -1;
  let result: Point[] | null = null;
  for (let i = 0; i < n; i++) {
    for (let k = i + 2; k < n; k++) {
      if (i === 0 && k === n - 1) continue;
      let left = -1;
      let leftIndex = -1;
      for (let j = i + 1; j < k; j++) {
        const area = triangleArea(polygon[i]!, polygon[j]!, polygon[k]!);
        if (area > left) {
          left = area;
          leftIndex = j;
        }
      }
      let right = -1;
      let rightIndex = -1;
      for (let l = k + 1; l < n + i; l++) {
        const area = triangleArea(polygon[k]!, polygon[l % n]!, polygon[i]!);
        if (area > right) {
          right = area;
          rightIndex = l % n;
        }
      }
      if (leftIndex < 0 || rightIndex < 0) continue;
      if (left + right > best) {
        best = left + right;
        result = [polygon[i]!, polygon[leftIndex]!, polygon[k]!, polygon[rightIndex]!];
      }
    }
  }
  return result;
}

/** A line as n·p = c, with n a unit normal. */
export interface Line {
  nx: number;
  ny: number;
  c: number;
}

export function lineThrough(a: Point, b: Point): Line {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;
  return { nx, ny, c: nx * a.x + ny * a.y };
}

/** Total least squares: the line closest to the points by perpendicular distance. */
export function fitLine(points: readonly Point[]): Line | null {
  if (points.length < 2) return null;
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.x;
    my += p.y;
  }
  mx /= points.length;
  my /= points.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  // Direction of most spread; the normal is perpendicular to it.
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle);
  return { nx, ny, c: nx * mx + ny * my };
}

export function intersect(a: Line, b: Line): Point | null {
  const det = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(det) < 1e-9) return null;
  return { x: (a.c * b.ny - a.ny * b.c) / det, y: (a.nx * b.c - a.c * b.nx) / det };
}

export const lineDistance = (line: Line, p: Point) => line.nx * p.x + line.ny * p.y - line.c;

/** Row-major 3×3 homography. */
export type Homography = [number, number, number, number, number, number, number, number, number];

function solve(matrix: number[][], vector: number[]): number[] | null {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row;
    if (Math.abs(a[pivot]![col]!) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row]![col]! / a[col]![col]!;
      for (let k = col; k <= n; k++) a[row]![k]! -= factor * a[col]![k]!;
    }
  }
  return a.map((row, i) => row[n]! / row[i]!);
}

/** The homography that maps each `from` point onto the matching `to` point. */
export function homography(from: readonly Point[], to: readonly Point[]): Homography | null {
  const matrix: number[][] = [];
  const vector: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i]!;
    const { x: u, y: v } = to[i]!;
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    vector.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    vector.push(v);
  }
  const h = solve(matrix, vector);
  return h ? ([...h, 1] as Homography) : null;
}

export function applyHomography(h: Homography, x: number, y: number): Point {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

export function isConvex(points: readonly Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const value = cross(points[i]!, points[(i + 1) % points.length]!, points[(i + 2) % points.length]!);
    if (value === 0) continue;
    if (sign === 0) sign = Math.sign(value);
    else if (Math.sign(value) !== sign) return false;
  }
  return sign !== 0;
}

/**
 * Puts four corners in reading order for a portrait card: clockwise on screen,
 * a short side on top, and of the two short sides the one higher in the frame.
 * Upside-down cards are fixed later, by reading the title both ways.
 */
export function orderCardCorners(points: readonly Point[]): Quad {
  const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  // Clockwise on screen (y down) is increasing angle.
  const sorted = [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  const side = (i: number) => distance(sorted[i % 4]!, sorted[(i + 1) % 4]!);
  let start = side(0) + side(2) > side(1) + side(3) ? 1 : 0;
  const topY = (s: number) => (sorted[s % 4]!.y + sorted[(s + 1) % 4]!.y) / 2;
  if (topY(start + 2) < topY(start)) start += 2;
  return [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]!) as Quad;
}
