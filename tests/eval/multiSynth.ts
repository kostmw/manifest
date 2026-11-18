/**
 * Synthetic photos with several cards in them, for M5's multi-card eval:
 *
 * - `binder`: a 9-pocket binder page photographed from above. The cards sit
 *   in clear plastic pockets, slid a little off centre and settled to the
 *   bottom; the pockets' welded seams show as thin light lines, the plastic
 *   hazes the whole page, and broad glare bands (sometimes a flash hotspot)
 *   run across it. Some pockets are empty, some cards wear an inner sleeve
 *   too, the page is turned and tipped a little, and on some photos the page
 *   runs off the frame so the outer cards are cut off.
 * - `spread`: 4–12 cards on a table, in rows (touching or with gaps) or
 *   scattered and turned.
 *
 * Every card's corners are known, and how much of it is inside the frame.
 * Deterministic for a given seed. Like synthesize.ts, optimistic: the card
 * images are the index's own scans.
 */
import { gaussianBlur } from '../../app/src/vision/filters';
import { applyHomography, homography, type Homography, type Point, type Quad } from '../../app/src/vision/geometry';
import { createGray, createRgba, type RgbaImage } from '../../app/src/vision/image';
import type { Rng } from './synthesize';

const uniform = (rng: Rng, lo: number, hi: number) => lo + (hi - lo) * rng();
const gaussian = (rng: Rng) => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());

/** A card, in millimetres. */
export const CARD_MM = { width: 63, height: 88 };

/** A card as placed on the page or table, in millimetres. */
export interface Placement {
  /** Index into the photo's card images. */
  card: number;
  /** The card's centre and turn. */
  center: Point;
  rotation: number;
  /** An inner sleeve on the card (inside the pocket, for binders). */
  sleeved: boolean;
  /** A foil's sheen. */
  foil: boolean;
}

export interface MultiParams {
  kind: 'binder' | 'spread';
  frame: { width: number; height: number };
  /** The page or table area, in millimetres; the photo looks at it through `camera`. */
  surface: { width: number; height: number };
  /** Where the surface's corners land in the frame (top-left, top-right, bottom-right, bottom-left). */
  camera: Quad;
  placements: Placement[];
  /** Binder: the page's colour behind the cards; spread: the table's. */
  color: [number, number, number];
  /** Spread: the table's pattern. */
  table?: 'plain' | 'wood' | 'cloth';
  /** Binder: pockets and seams, in millimetres. */
  pockets?: { x: number; y: number; width: number; height: number }[];
  /** Haze from the pocket plastic, 0–1. */
  haze: number;
  /** Broad glare bands across the surface, in surface millimetres. */
  bands: { angle: number; offset: number; width: number; strength: number }[];
  /** A flash hotspot, in surface millimetres. */
  hotspot: { x: number; y: number; radius: number; strength: number } | null;
  brightness: number;
  tint: [number, number, number];
  gradient: Point;
  blur: number;
  noise: number;
  jpegQuality: number;
  conditions: string[];
}

/** Binder page geometry: 9 pockets, a wider margin on the punched side. */
const POCKET = { width: 66.5, height: 92, seam: 3.5 };
const PAGE_MARGIN = { left: 14, right: 6, top: 6, bottom: 6 };
const PAGE = {
  width: PAGE_MARGIN.left + 3 * POCKET.width + 2 * POCKET.seam + PAGE_MARGIN.right,
  height: PAGE_MARGIN.top + 3 * POCKET.height + 2 * POCKET.seam + PAGE_MARGIN.bottom,
};

/**
 * A phone photo as the app reads it: scaled so its long side is 3000 pixels
 * (recognize.worker.ts's PHOTO_MAX_SIDE), 3:4 like a phone camera's.
 */
const PORTRAIT = { width: 2250, height: 3000 };
const LANDSCAPE = { width: 3000, height: 2250 };

/** Focal length as a share of the frame's long side, as in synthesize.ts. */
const PHONE_FOCAL = 0.75;

/**
 * Where a surface's corners land in a photo taken from above it: centred at
 * `center`, `pixelsPerMm` across, turned by `rotation`, and tipped by `tiltX`
 * (top edge away) and `tiltY` (right edge away), seen through a phone's lens.
 */
function cameraQuad(
  surface: { width: number; height: number },
  frame: { width: number; height: number },
  view: { center: Point; pixelsPerMm: number; rotation: number; tiltX: number; tiltY: number },
): Quad {
  const focal = PHONE_FOCAL * Math.max(frame.width, frame.height);
  const corners = [
    { x: -surface.width / 2, y: -surface.height / 2 },
    { x: surface.width / 2, y: -surface.height / 2 },
    { x: surface.width / 2, y: surface.height / 2 },
    { x: -surface.width / 2, y: surface.height / 2 },
  ];
  const cos = Math.cos(view.rotation);
  const sin = Math.sin(view.rotation);
  return corners.map((p) => {
    const x = p.x * view.pixelsPerMm;
    const y = p.y * view.pixelsPerMm;
    const depth = -y * Math.sin(view.tiltX) + x * Math.sin(view.tiltY);
    const scale = focal / (focal + depth);
    const lx = x * Math.cos(view.tiltY) * scale;
    const ly = y * Math.cos(view.tiltX) * scale;
    return { x: view.center.x + lx * cos - ly * sin, y: view.center.y + lx * sin + ly * cos };
  }) as Quad;
}

/** A card's corners on the surface, in millimetres, in the card's own reading order. */
export function placementCorners(placement: Placement): Quad {
  const cos = Math.cos(placement.rotation);
  const sin = Math.sin(placement.rotation);
  return [
    { x: -CARD_MM.width / 2, y: -CARD_MM.height / 2 },
    { x: CARD_MM.width / 2, y: -CARD_MM.height / 2 },
    { x: CARD_MM.width / 2, y: CARD_MM.height / 2 },
    { x: -CARD_MM.width / 2, y: CARD_MM.height / 2 },
  ].map((p) => ({ x: placement.center.x + p.x * cos - p.y * sin, y: placement.center.y + p.x * sin + p.y * cos })) as Quad;
}

const surfaceRect = (surface: { width: number; height: number }): Point[] => [
  { x: 0, y: 0 },
  { x: surface.width, y: 0 },
  { x: surface.width, y: surface.height },
  { x: 0, y: surface.height },
];

/** Every card's corners in the photo, in the card's reading order. */
export function photoCorners(params: MultiParams): Quad[] {
  const toPhoto = homography(surfaceRect(params.surface), params.camera)!;
  return params.placements.map((placement) => placementCorners(placement).map((p) => applyHomography(toPhoto, p.x, p.y)) as Quad);
}

/** Share of a card inside the frame, from a grid of points over it. */
export function visibleShare(corners: Quad, frame: { width: number; height: number }): number {
  const toPhoto = homography(
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
    corners,
  )!;
  let inside = 0;
  const steps = 24;
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const p = applyHomography(toPhoto, (i + 0.5) / steps, (j + 0.5) / steps);
      if (p.x >= 0 && p.y >= 0 && p.x < frame.width && p.y < frame.height) inside++;
    }
  }
  return inside / (steps * steps);
}

function lighting(rng: Rng, conditions: string[]) {
  let brightness = uniform(rng, 0.85, 1.1);
  if (rng() < 0.12) {
    brightness = uniform(rng, 0.45, 0.6);
    conditions.push('low-light');
  }
  const warm = uniform(rng, -0.08, 0.08);
  let blur = uniform(rng, 0.2, 1.1);
  if (rng() < 0.08) {
    blur = uniform(rng, 1.8, 2.6);
    conditions.push('blur');
  }
  return {
    brightness,
    tint: [1 + warm, 1, 1 - warm] as [number, number, number],
    gradient: { x: uniform(rng, -0.25, 0.25), y: uniform(rng, -0.25, 0.25) },
    blur,
    noise: uniform(rng, 1.5, 4.5),
    jpegQuality: Math.round(uniform(rng, 75, 92)),
  };
}

/**
 * A binder page. `cards` says which card goes in each of the 9 pockets, in
 * reading order (null: empty pocket); `foils` which of them are foil.
 */
export function binderParams(rng: Rng, cards: readonly (number | null)[], foils: ReadonlySet<number>): MultiParams {
  const conditions: string[] = [];
  const portrait = rng() < 0.8;
  const frame = portrait ? PORTRAIT : LANDSCAPE;
  const pockets = Array.from({ length: 9 }, (_, i) => ({
    x: PAGE_MARGIN.left + (i % 3) * (POCKET.width + POCKET.seam),
    y: PAGE_MARGIN.top + Math.floor(i / 3) * (POCKET.height + POCKET.seam),
    width: POCKET.width,
    height: POCKET.height,
  }));
  const placements: Placement[] = [];
  cards.forEach((card, i) => {
    if (card === null) return;
    const pocket = pockets[i]!;
    const slack = POCKET.width - CARD_MM.width;
    placements.push({
      card,
      center: {
        x: pocket.x + pocket.width / 2 + uniform(rng, -slack / 2, slack / 2) * 0.8,
        // Settled towards the bottom of the pocket.
        y: pocket.y + pocket.height - CARD_MM.height / 2 - uniform(rng, 0.3, 2.5),
      },
      rotation: (uniform(rng, -1.2, 1.2) * Math.PI) / 180,
      sleeved: rng() < 0.3,
      foil: foils.has(card),
    });
  });
  if (cards.includes(null)) conditions.push('empty-pocket');
  if (placements.some((p) => p.sleeved)) conditions.push('inner-sleeve');

  // Usually the whole page fills most of the frame; one photo in four is closer, and cuts off the outer cards.
  const close = rng() < 0.25;
  // A landscape photo has the page turned a quarter: its long side across the frame.
  const fit = portrait ? Math.min(frame.width / PAGE.width, frame.height / PAGE.height) : Math.min(frame.width / PAGE.height, frame.height / PAGE.width);
  const pixelsPerMm = fit * (close ? uniform(rng, 1.15, 1.4) : uniform(rng, 0.82, 0.97));
  if (close) conditions.push('cut-off');
  const rotation = ((portrait ? 0 : rng() < 0.5 ? 90 : -90) + uniform(rng, -6, 6)) * (Math.PI / 180);
  const tiltX = (uniform(rng, -12, 16) * Math.PI) / 180;
  const tiltY = (uniform(rng, -8, 8) * Math.PI) / 180;
  if (Math.abs(tiltX) > (10 * Math.PI) / 180) conditions.push('tilted');
  const center = {
    x: frame.width / 2 + uniform(rng, -0.04, 0.04) * frame.width,
    y: frame.height / 2 + uniform(rng, -0.04, 0.04) * frame.height,
  };
  const camera = cameraQuad(PAGE, frame, { center, pixelsPerMm, rotation, tiltX, tiltY });

  const colors: [number, number, number][] = [
    [18, 18, 20],
    [22, 22, 26],
    [235, 235, 232],
    [60, 64, 72],
    [24, 34, 70],
  ];
  const color = colors[rng() < 0.55 ? 0 : 1 + Math.floor(rng() * (colors.length - 1))]!;
  if (color[0] < 40) conditions.push('black-page');

  const bands = Array.from({ length: 1 + Math.floor(rng() * 3) }, () => ({
    angle: uniform(rng, 0, Math.PI),
    offset: uniform(rng, 0.1, 0.9) * PAGE.width,
    width: uniform(rng, 15, 60),
    strength: uniform(rng, 0.08, 0.45),
  }));
  let hotspot: MultiParams['hotspot'] = null;
  if (rng() < 0.3) {
    hotspot = { x: uniform(rng, 0.2, 0.8) * PAGE.width, y: uniform(rng, 0.2, 0.8) * PAGE.height, radius: uniform(rng, 12, 30), strength: uniform(rng, 0.6, 1.1) };
    conditions.push('flash');
  }
  if (bands.some((band) => band.strength > 0.3) || hotspot) conditions.push('glare');

  return {
    kind: 'binder',
    frame,
    surface: PAGE,
    camera,
    placements,
    color,
    pockets,
    haze: uniform(rng, 0.04, 0.12),
    bands,
    hotspot,
    ...lighting(rng, conditions),
    conditions,
  };
}

/** Cards on a table: `count` of them, from `cards`, in rows or scattered. */
export function spreadParams(rng: Rng, cards: readonly number[], foils: ReadonlySet<number>): MultiParams {
  const conditions: string[] = [];
  const portrait = rng() < 0.6;
  const frame = portrait ? PORTRAIT : LANDSCAPE;
  const count = cards.length;
  const layout = rng() < 0.65 ? 'rows' : 'scatter';
  const placements: Placement[] = [];
  let surface: { width: number; height: number };
  if (layout === 'rows') {
    const columns = portrait ? Math.min(count, count > 6 ? 3 : 2) : Math.min(count, count > 8 ? 4 : 3);
    const rows = Math.ceil(count / columns);
    const touching = rng() < 0.4;
    const gap = touching ? uniform(rng, 0, 0.8) : uniform(rng, 3, 15);
    conditions.push(touching ? 'touching' : 'gaps');
    const margin = 25;
    surface = { width: columns * CARD_MM.width + (columns - 1) * gap + 2 * margin, height: rows * CARD_MM.height + (rows - 1) * gap + 2 * margin };
    cards.forEach((card, i) => {
      placements.push({
        card,
        center: {
          x: margin + (i % columns) * (CARD_MM.width + gap) + CARD_MM.width / 2 + (touching ? 0 : uniform(rng, -1.5, 1.5)),
          y: margin + Math.floor(i / columns) * (CARD_MM.height + gap) + CARD_MM.height / 2 + (touching ? 0 : uniform(rng, -1.5, 1.5)),
        },
        rotation: ((touching ? uniform(rng, -0.4, 0.4) : uniform(rng, -3, 3)) * Math.PI) / 180,
        sleeved: rng() < 0.2,
        foil: foils.has(card),
      });
    });
  } else {
    conditions.push('scattered');
    // Clear of each other by a few millimetres (cards on a table don't overlap here): a bigger table until they all fit.
    let side = Math.ceil(Math.sqrt(count * 1.6));
    for (;;) {
      surface = { width: side * 75 + 30, height: side * 95 + 30 };
      placements.length = 0;
      let fits = true;
      for (const card of cards) {
        let placed = false;
        for (let attempt = 0; attempt < 400 && !placed; attempt++) {
          const candidate: Placement = {
            card,
            center: { x: uniform(rng, 50, surface.width - 50), y: uniform(rng, 60, surface.height - 60) },
            rotation: (uniform(rng, -18, 18) * Math.PI) / 180,
            sleeved: rng() < 0.2,
            foil: foils.has(card),
          };
          if (placements.every((other) => Math.hypot(other.center.x - candidate.center.x, other.center.y - candidate.center.y) > 112)) {
            placements.push(candidate);
            placed = true;
          }
        }
        if (!placed) {
          fits = false;
          break;
        }
      }
      if (fits) break;
      side += 1;
    }
  }
  const fit = Math.min(frame.width / surface.width, frame.height / surface.height);
  const pixelsPerMm = fit * uniform(rng, 0.9, 1.05);
  const rotation = (uniform(rng, -8, 8) * Math.PI) / 180;
  const tiltX = (uniform(rng, -10, 18) * Math.PI) / 180;
  const tiltY = (uniform(rng, -8, 8) * Math.PI) / 180;
  if (Math.abs(tiltX) > (10 * Math.PI) / 180) conditions.push('tilted');
  const camera = cameraQuad(surface, frame, { center: { x: frame.width / 2, y: frame.height / 2 }, pixelsPerMm, rotation, tiltX, tiltY });

  const tables = ['plain', 'wood', 'cloth'] as const;
  const table = tables[Math.floor(rng() * tables.length)]!;
  const dark = rng() < 0.3;
  const color: [number, number, number] = dark
    ? [uniform(rng, 15, 45), uniform(rng, 15, 45), uniform(rng, 15, 45)]
    : [uniform(rng, 70, 200), uniform(rng, 70, 200), uniform(rng, 70, 200)];
  if (dark) conditions.push('dark-background');
  let hotspot: MultiParams['hotspot'] = null;
  if (rng() < 0.15) {
    hotspot = { x: uniform(rng, 0.2, 0.8) * surface.width, y: uniform(rng, 0.2, 0.8) * surface.height, radius: uniform(rng, 10, 25), strength: uniform(rng, 0.5, 0.9) };
    conditions.push('glare');
  }
  return {
    kind: 'spread',
    frame,
    surface,
    camera,
    placements,
    color,
    table,
    haze: 0,
    bands: [],
    hotspot,
    ...lighting(rng, conditions),
    conditions,
  };
}

/** Signed distance inside a rounded rectangle centred on the origin (positive inside). */
function roundedDepth(x: number, y: number, width: number, height: number, radius: number): number {
  const qx = Math.abs(x) - (width / 2 - radius);
  const qy = Math.abs(y) - (height / 2 - radius);
  return radius - (Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0));
}

function bilinear(image: RgbaImage, x: number, y: number, channel: number): number {
  const fx = Math.min(image.width - 1, Math.max(0, x - 0.5));
  const fy = Math.min(image.height - 1, Math.max(0, y - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(image.width - 1, x0 + 1);
  const y1 = Math.min(image.height - 1, y0 + 1);
  const wx = fx - x0;
  const wy = fy - y0;
  const at = (xx: number, yy: number) => image.data[(yy * image.width + xx) * 4 + channel]!;
  return (at(x0, y0) * (1 - wx) + at(x1, y0) * wx) * (1 - wy) + (at(x0, y1) * (1 - wx) + at(x1, y1) * wx) * wy;
}

function blurRgba(image: RgbaImage, sigma: number): RgbaImage {
  if (sigma < 0.3) return image;
  const out = createRgba(image.width, image.height);
  for (let c = 0; c < 3; c++) {
    const channel = createGray(image.width, image.height);
    for (let i = 0; i < channel.data.length; i++) channel.data[i] = image.data[i * 4 + c]!;
    const blurred = gaussianBlur(channel, sigma);
    for (let i = 0; i < channel.data.length; i++) out.data[i * 4 + c] = blurred.data[i]!;
  }
  for (let i = 0; i < image.width * image.height; i++) out.data[i * 4 + 3] = 255;
  return out;
}

/** A table or the floor around a binder page: the colour with a little texture. */
function surroundColor(params: MultiParams, x: number, y: number, c: number): number {
  const base = params.kind === 'binder' ? [92, 70, 52][c]! : params.color[c]!;
  if (params.kind === 'spread' && params.table === 'wood') {
    const grain = Math.sin(x / 9 + Math.sin(y / 41) * 2) * 0.5 + 0.5;
    return base * [0.75 + 0.35 * grain, 0.55 + 0.25 * grain, 0.35 + 0.2 * grain][c]!;
  }
  if (params.kind === 'spread' && params.table === 'cloth') return base * ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? 1 : 0.86);
  return base * (1 + 0.04 * Math.sin(x / 13 + y / 29));
}

export function renderMulti(cards: readonly RgbaImage[], params: MultiParams, rng: Rng): RgbaImage {
  const { width, height } = params.frame;
  const out = createRgba(width, height);
  const toSurface: Homography = homography(params.camera, surfaceRect(params.surface))!;
  // Surface millimetres per photo pixel, near the middle: for soft edges.
  const mmPerPixel = params.surface.width / Math.hypot(params.camera[1].x - params.camera[0].x, params.camera[1].y - params.camera[0].y);
  const placed = params.placements.map((placement) => ({
    placement,
    image: cards[placement.card]!,
    cos: Math.cos(-placement.rotation),
    sin: Math.sin(-placement.rotation),
  }));
  const radius = CARD_MM.width * 0.045;
  const sleeve = 1.4;
  const foilPhase = uniform(rng, 0, Math.PI * 2);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = applyHomography(toSurface, x + 0.5, y + 0.5);
      const p = (y * width + x) * 4;
      const onSurface = s.x >= 0 && s.y >= 0 && s.x <= params.surface.width && s.y <= params.surface.height;
      let r: number;
      let g: number;
      let b: number;
      if (params.kind === 'binder' && onSurface) {
        [r, g, b] = params.color;
        // Welded seams around each pocket: thin light lines.
        for (const pocket of params.pockets!) {
          const dx = Math.min(Math.abs(s.x - pocket.x), Math.abs(s.x - pocket.x - pocket.width));
          const dy = Math.min(Math.abs(s.y - pocket.y), Math.abs(s.y - pocket.y - pocket.height));
          const insideX = s.x > pocket.x - 0.6 && s.x < pocket.x + pocket.width + 0.6;
          const insideY = s.y > pocket.y - 0.6 && s.y < pocket.y + pocket.height + 0.6;
          if ((dx < 0.6 && insideY) || (dy < 0.6 && insideX)) {
            const lift = params.color[0] < 128 ? 55 : -35;
            r += lift;
            g += lift;
            b += lift;
            break;
          }
        }
      } else {
        r = surroundColor(params, s.x, s.y, 0);
        g = surroundColor(params, s.x, s.y, 1);
        b = surroundColor(params, s.x, s.y, 2);
      }

      for (const { placement, image, cos, sin } of placed) {
        const dx = s.x - placement.center.x;
        const dy = s.y - placement.center.y;
        const lx = dx * cos - dy * sin;
        const ly = dx * sin + dy * cos;
        if (Math.abs(lx) > CARD_MM.width / 2 + sleeve + 1 || Math.abs(ly) > CARD_MM.height / 2 + sleeve + 1) continue;
        const depth = roundedDepth(lx, ly, CARD_MM.width, CARD_MM.height, radius);
        const alpha = Math.max(0, Math.min(1, 0.5 + depth / mmPerPixel));
        if (alpha > 0) {
          const cx = ((lx + CARD_MM.width / 2) / CARD_MM.width) * image.width;
          const cy = ((ly + CARD_MM.height / 2) / CARD_MM.height) * image.height;
          const sheen = (channel: number) =>
            placement.foil ? 1 + 0.22 * (0.5 + 0.5 * Math.sin((cx + cy * 0.7) / (image.width * 0.35) + foilPhase + (channel * 2 * Math.PI) / 3)) : 1;
          r = r * (1 - alpha) + bilinear(image, cx, cy, 0) * sheen(0) * alpha;
          g = g * (1 - alpha) + bilinear(image, cx, cy, 1) * sheen(1) * alpha;
          b = b * (1 - alpha) + bilinear(image, cx, cy, 2) * sheen(2) * alpha;
        }
        if (placement.sleeved) {
          const sleeveDepth = roundedDepth(lx, ly, CARD_MM.width + 2 * sleeve, CARD_MM.height + 2 * sleeve, radius + sleeve);
          if (sleeveDepth > 0) {
            const haze = sleeveDepth < 0.5 ? 0.18 : 0.06;
            r = r * (1 - haze) + 255 * haze;
            g = g * (1 - haze) + 255 * haze;
            b = b * (1 - haze) + 255 * haze;
          }
        }
        break;
      }

      // The pocket plastic over the whole page, and the light on it.
      let boost = 0;
      if (onSurface && params.haze > 0) {
        r = r * (1 - params.haze) + 255 * params.haze;
        g = g * (1 - params.haze) + 255 * params.haze;
        b = b * (1 - params.haze) + 255 * params.haze;
      }
      if (onSurface || params.kind === 'spread') {
        for (const band of params.bands) {
          const u = s.x * Math.cos(band.angle) + s.y * Math.sin(band.angle) - band.offset;
          boost += band.strength * 255 * Math.exp(-((u / band.width) ** 2));
        }
        if (params.hotspot) {
          const d2 = (s.x - params.hotspot.x) ** 2 + (s.y - params.hotspot.y) ** 2;
          boost += params.hotspot.strength * 255 * Math.exp(-d2 / params.hotspot.radius ** 2);
        }
      }
      const light =
        params.brightness *
        (1 + params.gradient.x * (x / width - 0.5) + params.gradient.y * (y / height - 0.5)) *
        (1 - 0.25 * (((x / width - 0.5) ** 2 + (y / height - 0.5) ** 2) * 2));
      out.data[p] = r * light * params.tint[0] + boost;
      out.data[p + 1] = g * light * params.tint[1] + boost;
      out.data[p + 2] = b * light * params.tint[2] + boost;
      out.data[p + 3] = 255;
    }
  }

  const blurred = blurRgba(out, params.blur);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) blurred.data[i * 4 + c] = blurred.data[i * 4 + c]! + gaussian(rng) * params.noise;
    blurred.data[i * 4 + 3] = 255;
  }
  return blurred;
}
