/**
 * Every card in a photo of several: a binder page, a table spread. Plain
 * TypeScript like detect.ts, which it builds on.
 *
 * Detection finds outlines, but in a photo of many cards an outline is not
 * always one card. Any k×k block of cards, a whole 3×3 binder page included,
 * has a card's own shape; touching cards and the welded seams of binder
 * pockets join into one outline around a row or block; a card's art and
 * text boxes are outlines inside it; and two cards side by side have one
 * card's shape too. So:
 *
 * 1. Detection returns every outline that lies on edges (`everything`), at a
 *    larger working size than for one card, card-shaped or not.
 * 2. A card-shaped outline is a page or block (and dropped, or split into
 *    its cells) when a k×k grid fits it, or when it holds two or more
 *    separate card-shaped outlines of about the same size. A grid is believed
 *    only when every line between its cells lies on edges much better than
 *    the lines beside it (a seam, a gap, two cards' borders meeting, never
 *    busy artwork). Outlines that aren't card-shaped (rows, blocks) give the
 *    cells of the smallest grid that fits them.
 * 3. An outline twice the size of the other cards, splittable into two, is
 *    two touching cards.
 * 4. Whatever lies inside a card is a piece of it, repeats of one card (its
 *    frame line, its pocket) keep the outer one, and outlines far from the
 *    photo's card size are dropped.
 * 5. With two or more cards found, their neighbours in a grid are looked for
 *    one card over in each direction (growGrid): that finds the cards whose
 *    outlines joined the page's seams where they run off the photo, and the
 *    ones cut off by its edge.
 *
 * Pieces of one card can still come back as two "cards" (an art box and a
 * text box when the card's own edge is invisible); recognizeCards in
 * pipeline.ts only reads a photo as several when two outlines name
 * different cards.
 */
import { detectCards, type CardDetection, type DetectOptions } from './detect';
import { dilate, edgeRidges, gaussianBlur, hysteresis, percentileNonZero } from './filters';
import { applyHomography, homography, orderCardCorners, polygonArea, type Homography, type Point, type Quad } from './geometry';
import { grayDownscaled, type GrayImage, type RgbaImage } from './image';
import { cardPose } from './perspective';

export interface FoundCard {
  detection: CardDetection;
  /** Its own outline, or a cell of a grid of cards. */
  source: 'outline' | 'grid';
  /** Share of the card inside the photo. */
  visible: number;
}

/** Long side of the working image: a 3×3 page in it gives cards about 250 pixels tall. */
const WORKING_SIZE = 1024;
/** Smaller outlines are ignored: a 4×4 spread's card is about 4% of the photo. */
const MIN_AREA = 0.004;
/** Cells per side of a grid tried. */
const MAX_CELLS = 4;
/** How far from a grid's shape an outline may be, as the log of the ratio of their aspects. */
const GRID_FIT = 0.13;
/** Share of a line between cells that must lie on edges for the grid to be believed. */
const LINE_SUPPORT = 0.6;
/** How far either side of its place a line between cells is searched for, as a share of a cell. */
const LINE_SEARCH = 0.12;

/** Neighbours are looked for this far past a card (the gap between cards, or pocket to pocket), as a share of its size. */
const MAX_GAP = 0.2;
/** A neighbour's sides must lie this well on edges. */
const NEIGHBOUR_SUPPORT = 0.55;
/** Cells mostly outside the photo aren't worth reading. */
const MIN_VISIBLE = 0.6;
/** An outline with a corner this close to the photo's edge (a share of its long side) may be cut off by it. */
const EDGE_MARGIN = 0.005;
/** At most this many cards in a photo. */
const MAX_CARDS = 20;

const centerOf = (quad: readonly Point[]): Point => ({ x: quad.reduce((s, p) => s + p.x, 0) / quad.length, y: quad.reduce((s, p) => s + p.y, 0) / quad.length });

function inside(polygon: readonly Point[], p: Point): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

const UNIT: Point[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

/** Share of quad `a` inside polygon `b`, from a grid of points over `a`. */
export function coverage(a: readonly Point[], b: readonly Point[], steps = 10): number {
  const map = homography(UNIT, a);
  if (!map) return 0;
  let hits = 0;
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) if (inside(b, applyHomography(map, (i + 0.5) / steps, (j + 0.5) / steps))) hits++;
  }
  return hits / (steps * steps);
}

/** Edges of the photo at the working size, joined across a pixel, for judging lines between cells. */
interface EdgeMap {
  edges: Uint8Array;
  width: number;
  height: number;
  /** Working pixels per photo pixel. */
  scale: number;
}

function edgeMap(image: RgbaImage): EdgeMap {
  const { gray, scale } = grayDownscaled(image, WORKING_SIZE);
  const blurred: GrayImage = gaussianBlur(gray, 1.2);
  const ridges = edgeRidges(blurred);
  const level = Math.max(30, percentileNonZero(ridges, 0.85));
  return { edges: dilate(hysteresis(ridges, gray.width, gray.height, level * 0.4, level), gray.width, gray.height, 1), width: gray.width, height: gray.height, scale };
}

/** Share of the middle 80% of the segment a→b (photo pixels) that lies on edges. */
function lineSupport(map: EdgeMap, a: Point, b: Point): number {
  const ax = a.x * map.scale;
  const ay = a.y * map.scale;
  const bx = b.x * map.scale;
  const by = b.y * map.scale;
  const length = Math.hypot(bx - ax, by - ay);
  const samples = Math.max(8, Math.round(length * 0.8));
  let hits = 0;
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const t = 0.1 + (0.8 * (i + 0.5)) / samples;
    const x = Math.round(ax + (bx - ax) * t);
    const y = Math.round(ay + (by - ay) * t);
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
    total++;
    if (map.edges[y * map.width + x]) hits++;
  }
  return total ? hits / total : 0;
}

/**
 * How well a line lies on edges near where it should be, and how much better
 * than the lines beside it: a seam, a gap or two cards' borders meeting is a
 * sharp peak, while busy artwork puts edges everywhere. `line(offset)` gives
 * the segment at an offset; the best within `near` is compared with the
 * median over `far`.
 */
function peak(map: EdgeMap, line: (offset: number) => [Point, Point], near: number, far: number): { support: number; at: number; contrast: number } {
  // Finely near its place (an edge is a pixel or two wide), coarsely around it for comparison.
  const [a0, b0] = line(0);
  const [a1] = line(near);
  const pixels = Math.max(4, Math.hypot(a1.x - a0.x, a1.y - a0.y) * map.scale);
  const steps = Math.min(60, Math.ceil(pixels * 1.5));
  void b0;
  let best = { support: 0, at: 0 };
  for (let step = -steps; step <= steps; step++) {
    const offset = (near * step) / steps;
    const support = lineSupport(map, ...line(offset));
    if (support > best.support) best = { support, at: offset };
  }
  const around: number[] = [];
  for (let step = -12; step <= 12; step++) around.push(lineSupport(map, ...line((far * step) / 12)));
  around.sort((a, b) => a - b);
  return { ...best, contrast: best.support - around[Math.floor(around.length / 2)]! };
}

/** A line between cells counts when it lies on edges this much better than the lines beside it. */
const LINE_CONTRAST = 0.3;

/** Top edge ÷ left edge of an outline as it lies flat, perspective taken out where that's plausible. */
function flatRatio(corners: Quad, frame: { width: number; height: number }): number {
  const top = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y) + Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y);
  const left = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y) + Math.hypot(corners[2].x - corners[1].x, corners[2].y - corners[1].y);
  const seen = top / left;
  const pose = cardPose(corners, frame);
  return pose && pose.tilt >= 10 && pose.tilt <= 60 ? pose.aspect : seen;
}

interface Grid {
  columns: number;
  rows: number;
  /** Where the lines between cells are, in the outline's own 0–1 coordinates: 0, …, 1. */
  xs: number[];
  ys: number[];
}

/**
 * The lines between cells, each searched for near its place: the offset
 * where it lies best on edges. Null when one of them doesn't lie on edges.
 */
function fitLines(map: EdgeMap, toPhoto: Homography, columns: number, rows: number): Grid | null {
  const xs = [0];
  const ys = [0];
  const point = (u: number, v: number) => applyHomography(toPhoto, u, v);
  for (let i = 1; i < columns; i++) {
    const near = LINE_SEARCH / columns;
    const found = peak(map, (offset) => [point(i / columns + offset, 0), point(i / columns + offset, 1)], near, near * 3);
    if (found.support < LINE_SUPPORT || found.contrast < LINE_CONTRAST) return null;
    xs.push(i / columns + found.at);
  }
  for (let j = 1; j < rows; j++) {
    const near = LINE_SEARCH / rows;
    const found = peak(map, (offset) => [point(0, j / rows + offset), point(1, j / rows + offset)], near, near * 3);
    if (found.support < LINE_SUPPORT || found.contrast < LINE_CONTRAST) return null;
    ys.push(j / rows + found.at);
  }
  xs.push(1);
  ys.push(1);
  return { columns, rows, xs, ys };
}

/** The grids of cards an outline could hold, whose lines between cells all lie on edges; 1×1 for a card-shaped outline. */
function gridsOf(detection: CardDetection, aspect: number, map: EdgeMap, frame: { width: number; height: number }): Grid[] {
  const corners = detection.corners;
  const ratio = flatRatio(corners, frame);
  const toPhoto = homography(UNIT, corners);
  if (!toPhoto) return [];
  const grids: Grid[] = [];
  const tried = new Set<string>();
  for (let columns = 1; columns <= MAX_CELLS; columns++) {
    for (let rows = 1; rows <= MAX_CELLS; rows++) {
      // Cards upright in the outline, or turned a quarter (two cards side by side read as one tall outline).
      for (const cell of [aspect, 1 / aspect]) {
        if (Math.abs(Math.log(ratio / ((columns * cell) / rows))) >= GRID_FIT || tried.has(`${columns}x${rows}`)) continue;
        tried.add(`${columns}x${rows}`);
        if (columns * rows === 1) {
          if (!detection.block) grids.push({ columns: 1, rows: 1, xs: [0, 1], ys: [0, 1] });
          continue;
        }
        const grid = fitLines(map, toPhoto, columns, rows);
        if (grid) grids.push(grid);
      }
    }
  }
  return grids;
}

/** The cells of a grid, as card outlines in the photo. */
function cells(detection: CardDetection, grid: Grid, frame: { width: number; height: number }): FoundCard[] {
  const toPhoto = homography(UNIT, detection.corners)!;
  const found: FoundCard[] = [];
  for (let j = 0; j < grid.rows; j++) {
    for (let i = 0; i < grid.columns; i++) {
      const raw = [
        applyHomography(toPhoto, grid.xs[i]!, grid.ys[j]!),
        applyHomography(toPhoto, grid.xs[i + 1]!, grid.ys[j]!),
        applyHomography(toPhoto, grid.xs[i + 1]!, grid.ys[j + 1]!),
        applyHomography(toPhoto, grid.xs[i]!, grid.ys[j + 1]!),
      ];
      const corners = orderCardCorners(raw);
      found.push({
        detection: { ...detection, corners, areaFraction: polygonArea(corners) / (frame.width * frame.height), block: undefined } as CardDetection,
        source: 'grid',
        visible: 1,
      });
    }
  }
  return found;
}

/** Share of a quad inside the photo. */
function visibleShare(corners: readonly Point[], frame: { width: number; height: number }): number {
  const map = homography(UNIT, corners);
  if (!map) return 0;
  let hits = 0;
  const steps = 12;
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const p = applyHomography(map, (i + 0.5) / steps, (j + 0.5) / steps);
      if (p.x >= 0 && p.y >= 0 && p.x < frame.width && p.y < frame.height) hits++;
    }
  }
  return hits / (steps * steps);
}

/** A neighbour's side: how well it lies on edges near its place, and how much better than beside it (see peak). */
function sideSupport(map: EdgeMap, toPhoto: Homography, side: 'top' | 'bottom' | 'left' | 'right', at: number, from: number, to: number): number {
  const found = peak(
    map,
    (offset) =>
      side === 'top' || side === 'bottom'
        ? [applyHomography(toPhoto, from, at + offset), applyHomography(toPhoto, to, at + offset)]
        : [applyHomography(toPhoto, at + offset, from), applyHomography(toPhoto, at + offset, to)],
    0.04,
    0.12,
  );
  return found.contrast >= LINE_CONTRAST ? found.support : 0;
}

/**
 * The cards next to the ones found, in a grid (a binder page, a row of
 * cards): one card over in each direction, past a gap that is searched for,
 * kept when the neighbour's four sides lie on edges (pocket seams, card
 * edges). Finds the cards whose outlines joined the page's grid of seams
 * where it runs off the photo, and those cut off by the photo's edge.
 * Empty pockets come back too; reading them finds no card.
 */
function growGrid(cards: FoundCard[], map: EdgeMap, frame: { width: number; height: number }): FoundCard[] {
  const all = [...cards];
  const queue = [...cards];
  const taken = (corners: readonly Point[]) => all.some((card) => coverage(corners, card.detection.corners) > 0.35 || coverage(card.detection.corners, corners) > 0.35);
  while (queue.length > 0 && all.length < MAX_CARDS) {
    const card = queue.shift()!;
    const toPhoto = homography(UNIT, card.detection.corners);
    if (!toPhoto) continue;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      let best: { corners: Point[]; support: number } | null = null;
      for (let gap = 0; gap <= MAX_GAP + 1e-9; gap += 0.02) {
        // The neighbour in this card's own coordinates: one card over, past the gap.
        const x0 = dx === 0 ? 0 : dx > 0 ? 1 + gap : -1 - gap;
        const y0 = dy === 0 ? 0 : dy > 0 ? 1 + gap : -1 - gap;
        const supports = [
          sideSupport(map, toPhoto, 'top', y0, x0, x0 + 1),
          sideSupport(map, toPhoto, 'bottom', y0 + 1, x0, x0 + 1),
          sideSupport(map, toPhoto, 'left', x0, y0, y0 + 1),
          sideSupport(map, toPhoto, 'right', x0 + 1, y0, y0 + 1),
        ];
        const corners = [
          applyHomography(toPhoto, x0, y0),
          applyHomography(toPhoto, x0 + 1, y0),
          applyHomography(toPhoto, x0 + 1, y0 + 1),
          applyHomography(toPhoto, x0, y0 + 1),
        ];
        // Sides outside the photo can't be judged: the ones inside must hold.
        const judged = supports.filter((_, i) => {
          const [a, b] = [corners[[0, 3, 0, 1][i]!]!, corners[[1, 2, 3, 2][i]!]!];
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          return mid.x >= 0 && mid.y >= 0 && mid.x < frame.width && mid.y < frame.height;
        });
        if (judged.length < 2) continue;
        const support = judged.reduce((sum, value) => sum + value, 0) / judged.length;
        if (Math.min(...judged) < NEIGHBOUR_SUPPORT * 0.6 || support < NEIGHBOUR_SUPPORT) continue;
        if (!best || support > best.support) best = { corners, support };
      }
      if (!best) continue;
      const visible = visibleShare(best.corners, frame);
      if (visible < MIN_VISIBLE || taken(best.corners)) continue;
      const corners = orderCardCorners(best.corners);
      const found: FoundCard = {
        detection: { ...card.detection, corners, areaFraction: polygonArea(corners) / (frame.width * frame.height), score: best.support, block: undefined } as CardDetection,
        source: 'grid',
        visible,
      };
      all.push(found);
      queue.push(found);
      if (all.length >= MAX_CARDS) break;
    }
  }
  return all;
}

export function findCards(image: RgbaImage, options: Pick<DetectOptions, 'aspect' | 'border'>): FoundCard[] {
  const frame = { width: image.width, height: image.height };
  const outlines = detectCards(image, { ...options, workingSize: WORKING_SIZE, minAreaFraction: MIN_AREA, everything: true });
  if (outlines.length === 0) return [];
  const map = edgeMap(image);
  const quadArea = (corners: readonly Point[]) => polygonArea(corners);
  const holds = (outer: readonly Point[], inner: readonly Point[], maxRatio: number) =>
    quadArea(inner) / quadArea(outer) <= maxRatio && inside(outer, centerOf(inner));
  const apart = (a: readonly Point[], b: readonly Point[]) => coverage(a, b) < 0.3 && coverage(b, a) < 0.3;

  // Card-shaped outlines, biggest first; the cells of rows and blocks of touching cards.
  const shaped = outlines.filter((outline) => !outline.block).sort((a, b) => quadArea(b.corners) - quadArea(a.corners));
  const blockCells: FoundCard[] = [];
  for (const block of outlines.filter((outline) => outline.block)) {
    const grid = gridsOf(block, options.aspect, map, frame).sort((a, b) => a.columns * a.rows - b.columns * b.rows)[0];
    if (grid) blockCells.push(...cells(block, grid, frame));
  }

  /**
   * A card-shaped outline is a page or a block of cards, not a card, when a
   * grid of 2×2 or more fits it, or when it holds two or more separate
   * card-shaped outlines of about the same size (a page's pockets). One card
   * holds its art box at most: never two such outlines.
   */
  const cards: FoundCard[] = [];
  for (const outline of shaped) {
    const grid = gridsOf(outline, options.aspect, map, frame).filter((g) => g.columns >= 2 && g.rows >= 2 && g.columns === g.rows).at(-1);
    const area = quadArea(outline.corners);
    const held = [...shaped.map((other) => other.corners), ...blockCells.map((cell) => cell.detection.corners)].filter(
      (corners) => corners !== outline.corners && holds(outline.corners, corners, 1 / 3) && quadArea(corners) >= area / 80,
    );
    const separate = held.some((a, i) => held.some((b, k) => k > i && apart(a, b) && Math.abs(Math.log(quadArea(a) / quadArea(b))) < Math.log(1.8)));
    if (grid) cards.push(...cells(outline, grid, frame));
    else if (!separate) cards.push({ detection: outline, source: 'outline', visible: 1 });
  }
  cards.push(...blockCells);

  const area = (card: FoundCard) => quadArea(card.detection.corners);
  // Two touching cards side by side have a card's own shape: an outline twice the size of the
  // other cards in the photo, split down a line between them, is two cards.
  const singles = cards.filter((card) => card.source === 'outline').map(area).sort((a, b) => a - b);
  if (singles.length >= 3) {
    const typical = singles[Math.floor(singles.length / 2)]!;
    for (const card of [...cards]) {
      if (card.source !== 'outline' || area(card) < typical * 1.6 || area(card) > typical * 2.6) continue;
      const pair = gridsOf(card.detection, options.aspect, map, frame).find((grid) => grid.columns * grid.rows === 2);
      if (!pair) continue;
      cards.splice(cards.indexOf(card), 1, ...cells(card.detection, pair, frame));
    }
  }
  // Pieces of a card (art and text boxes, title bars, grid cells over them): whatever lies inside a card.
  let kept = cards.filter((inner) => !cards.some((outer) => outer !== inner && outer.source === 'outline' && holds(outer.detection.corners, inner.detection.corners, 0.6)));
  // The same card twice (its frame line, its pocket, a grid cell over it): its own outline first, the outer one.
  kept.sort((a, b) => (a.source === b.source ? area(b) - area(a) : a.source === 'outline' ? -1 : 1));
  const unique: FoundCard[] = [];
  for (const card of kept) {
    if (!unique.some((other) => !apart(card.detection.corners, other.detection.corners))) unique.push(card);
  }
  kept = unique;
  // Cards in one photo are about the same size: much smaller or bigger outlines are something else.
  if (kept.length >= 3) {
    const sizes = kept.map(area).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)]!;
    kept = kept.filter((card) => area(card) >= median * 0.45 && area(card) <= median * 2.2);
  }
  // An outline touching the photo's edge may be a card cut off by it: never treated as whole.
  const margin = EDGE_MARGIN * Math.max(frame.width, frame.height);
  kept = kept.map((card) =>
    card.visible === 1 && card.detection.corners.some((p) => p.x < margin || p.y < margin || p.x > frame.width - margin || p.y > frame.height - margin)
      ? { ...card, visible: 0.99 }
      : card,
  );
  // A grid of two or more: the cards next to them that detection missed.
  const final = kept.length >= 2 ? growGrid(kept, map, frame) : kept;
  // Reading order: rows from the top, left to right.
  const height = final.length ? Math.sqrt(final.reduce((s, card) => s + area(card), 0) / final.length) : 0;
  return final.sort((a, b) => {
    const ca = centerOf(a.detection.corners);
    const cb = centerOf(b.detection.corners);
    return Math.abs(ca.y - cb.y) > height * 0.5 ? ca.y - cb.y : ca.x - cb.x;
  });
}
