/**
 * Renders synthetic "phone photos" of a card: a clean card image placed on a
 * procedural background with perspective, rotation, lighting, glare, sleeve
 * sheen, blur, noise and (in the caller) JPEG compression. Deterministic for a
 * given seed. These stand in for real scans until the owner supplies some, and
 * they are optimistic: the source images are the same scans the index uses.
 */
import { gaussianBlur } from '../../app/src/vision/filters';
import { applyHomography, homography, type Point, type Quad } from '../../app/src/vision/geometry';
import { createGray, createRgba, type RgbaImage } from '../../app/src/vision/image';

export type Rng = () => number;

/** mulberry32: small, fast, good enough for test data. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFrom(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const uniform = (rng: Rng, lo: number, hi: number) => lo + (hi - lo) * rng();
const gaussian = (rng: Rng) => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());

export type BackgroundKind = 'solid' | 'dark' | 'wood' | 'mat' | 'paper' | 'cloth';

export interface SynthParams {
  frame: { width: number; height: number };
  background: BackgroundKind;
  backgroundColor: [number, number, number];
  /** Card height as a share of the frame height. */
  cardHeight: number;
  center: Point;
  /** Radians, including any 180° or 90° turn. */
  rotation: number;
  /** Per-corner offsets, as shares of the card width. */
  jitter: Point[];
  brightness: number;
  tint: [number, number, number];
  gradient: Point;
  glare: { x: number; y: number; radius: number; strength: number } | null;
  sleeved: boolean;
  blur: number;
  noise: number;
  jpegQuality: number;
  conditions: string[];
  /**
   * The card tipped away from the camera about its horizontal axis, in
   * radians: positive puts the top edge farther away, as when a phone is
   * tilted back from straight above the card. Absent in the standard sets.
   */
  tilt?: number;
  /** A foil's rainbow sheen, in card coordinates. Absent in the standard sets. */
  foil?: { angle: number; period: number; phase: number; strength: number };
}

const FRAMES = [
  { width: 720, height: 1280, weight: 0.5 },
  { width: 1280, height: 720, weight: 0.3 },
  { width: 1200, height: 1600, weight: 0.2 },
];

function pickFrame(rng: Rng) {
  let roll = rng();
  for (const frame of FRAMES) {
    roll -= frame.weight;
    if (roll <= 0) return { width: frame.width, height: frame.height };
  }
  return { width: FRAMES[0]!.width, height: FRAMES[0]!.height };
}

export function randomParams(rng: Rng, aspect: number): SynthParams {
  const frame = pickFrame(rng);
  const conditions: string[] = [];
  const kinds: BackgroundKind[] = ['solid', 'dark', 'wood', 'mat', 'paper', 'cloth'];
  const background = kinds[Math.floor(rng() * kinds.length)]!;
  const backgroundColor: [number, number, number] =
    background === 'dark'
      ? [uniform(rng, 10, 45), uniform(rng, 10, 45), uniform(rng, 10, 45)]
      : background === 'paper'
        ? [uniform(rng, 215, 245), uniform(rng, 215, 245), uniform(rng, 210, 240)]
        : [uniform(rng, 40, 200), uniform(rng, 40, 200), uniform(rng, 40, 200)];
  if (background === 'dark') conditions.push('dark-background');

  let rotation = (uniform(rng, -10, 10) * Math.PI) / 180;
  const turn = rng();
  if (turn < 0.1) {
    rotation += Math.PI;
    conditions.push('upside-down');
  } else if (turn < 0.17) {
    rotation += (rng() < 0.5 ? 1 : -1) * (Math.PI / 2);
    conditions.push('sideways');
  }
  // Size the card so its rotated bounding box fits the frame with some room.
  const portrait = frame.height > frame.width;
  let cardHeight = portrait ? uniform(rng, 0.42, 0.72) : uniform(rng, 0.6, 0.88);
  const fit = () => {
    const h = cardHeight * frame.height;
    const w = h * aspect;
    const c = Math.abs(Math.cos(rotation));
    const s = Math.abs(Math.sin(rotation));
    return { bw: w * c + h * s, bh: w * s + h * c };
  };
  while (fit().bw > frame.width * 0.9 || fit().bh > frame.height * 0.92) cardHeight *= 0.95;
  const { bw, bh } = fit();
  const center = {
    x: uniform(rng, bw / 2 + frame.width * 0.03, frame.width - bw / 2 - frame.width * 0.03),
    y: uniform(rng, bh / 2 + frame.height * 0.03, frame.height - bh / 2 - frame.height * 0.03),
  };
  const jitter = Array.from({ length: 4 }, () => ({ x: uniform(rng, -0.035, 0.035), y: uniform(rng, -0.035, 0.035) }));

  let brightness = uniform(rng, 0.8, 1.1);
  if (rng() < 0.08) {
    brightness = uniform(rng, 0.35, 0.55);
    conditions.push('low-light');
  }
  const warm = uniform(rng, -0.08, 0.08);
  const tint: [number, number, number] = [1 + warm, 1, 1 - warm];
  const gradient = { x: uniform(rng, -0.25, 0.25), y: uniform(rng, -0.25, 0.25) };

  let glare: SynthParams['glare'] = null;
  if (rng() < 0.15) {
    glare = { x: uniform(rng, 0.15, 0.85), y: uniform(rng, 0.05, 0.9), radius: uniform(rng, 0.08, 0.25), strength: uniform(rng, 0.6, 1.2) };
    conditions.push('glare');
  } else if (rng() < 0.3) {
    glare = { x: uniform(rng, 0.1, 0.9), y: uniform(rng, 0.1, 0.9), radius: uniform(rng, 0.15, 0.35), strength: uniform(rng, 0.1, 0.3) };
  }

  const sleeved = rng() < 0.15;
  if (sleeved) conditions.push('sleeved');

  let blur = uniform(rng, 0, 0.9);
  if (rng() < 0.08) {
    blur = uniform(rng, 1.8, 3.2);
    conditions.push('blur');
  }

  if (!conditions.some((c) => ['glare', 'sleeved', 'blur', 'low-light'].includes(c))) conditions.push('clean');

  return {
    frame,
    background,
    backgroundColor,
    cardHeight,
    center,
    rotation,
    jitter,
    brightness,
    tint,
    gradient,
    glare,
    sleeved,
    blur,
    noise: uniform(rng, 1.5, 5),
    jpegQuality: Math.round(uniform(rng, 72, 92)),
    conditions,
  };
}

function renderBackground(params: SynthParams, rng: Rng): RgbaImage {
  const { width, height } = params.frame;
  const out = createRgba(width, height);
  const [r0, g0, b0] = params.backgroundColor;
  const waves = Array.from({ length: 4 }, () => ({
    fx: uniform(rng, 0.5, 3) / width,
    fy: uniform(rng, 0.5, 3) / height,
    phase: uniform(rng, 0, Math.PI * 2),
    amp: uniform(rng, 4, 14),
  }));
  const angle = uniform(rng, 0, Math.PI);
  const period = uniform(rng, 6, 18);
  const check = uniform(rng, 12, 30);
  const blobs = Array.from({ length: 5 }, () => ({
    x: rng() * width,
    y: rng() * height,
    r: uniform(rng, 0.1, 0.4) * Math.max(width, height),
    color: [uniform(rng, 0, 120), uniform(rng, 0, 120), uniform(rng, 0, 120)],
  }));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let low = 0;
      for (const w of waves) low += w.amp * Math.sin(2 * Math.PI * (w.fx * x + w.fy * y) + w.phase);
      let r = r0 + low;
      let g = g0 + low;
      let b = b0 + low;
      if (params.background === 'wood') {
        const u = x * Math.cos(angle) + y * Math.sin(angle);
        const grain = Math.sin(u / period + Math.sin(y / 37) * 2 + low / 6) * 0.5 + 0.5;
        r = r0 * (0.75 + 0.35 * grain);
        g = g0 * 0.7 * (0.75 + 0.35 * grain);
        b = b0 * 0.45 * (0.75 + 0.35 * grain);
      } else if (params.background === 'cloth') {
        const on = (Math.floor(x / check) + Math.floor(y / check)) % 2 === 0 ? 1 : 0.82;
        r *= on;
        g *= on;
        b *= on;
      } else if (params.background === 'mat') {
        r = r0 * 0.4;
        g = g0 * 0.4;
        b = b0 * 0.4;
        for (const blob of blobs) {
          const d = Math.exp(-((x - blob.x) ** 2 + (y - blob.y) ** 2) / (blob.r * blob.r));
          r += blob.color[0]! * d;
          g += blob.color[1]! * d;
          b += blob.color[2]! * d;
        }
      }
      const p = (y * width + x) * 4;
      out.data[p] = r;
      out.data[p + 1] = g;
      out.data[p + 2] = b;
      out.data[p + 3] = 255;
    }
  }
  return out;
}

/** Signed distance inside a rounded rectangle (positive inside). */
function roundedRectDepth(x: number, y: number, width: number, height: number, radius: number): number {
  const qx = Math.abs(x - width / 2) - (width / 2 - radius);
  const qy = Math.abs(y - height / 2) - (height / 2 - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
  return radius - outside;
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

/** Focal length as a share of the frame's long side: a phone's main camera sees about 70° across it. */
const PHONE_FOCAL = 0.75;

/** A foil's sheen: brighter, colour-shifted bands across the card, like light on a holographic finish. */
function foilSheen(foil: NonNullable<SynthParams['foil']>, x: number, y: number, width: number, channel: number): number {
  const u = (x * Math.cos(foil.angle) + y * Math.sin(foil.angle)) / (width * foil.period);
  return 1 + foil.strength * (0.5 + 0.5 * Math.sin(2 * Math.PI * u + foil.phase + (channel * 2 * Math.PI) / 3));
}

/** Where the card's corners land in the frame, in reading order of the card itself. */
export function placedCorners(params: SynthParams, card: { width: number; height: number }): Quad {
  const h = params.cardHeight * params.frame.height;
  const w = h * (card.width / card.height);
  const cos = Math.cos(params.rotation);
  const sin = Math.sin(params.rotation);
  const flat: Point[] = [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ];
  // A pinhole camera with a phone's field of view (about 70° across the long side):
  // tipping the card shortens it and makes its far edge narrower.
  const focal = PHONE_FOCAL * Math.max(params.frame.width, params.frame.height);
  const tilt = params.tilt ?? 0;
  const local = flat.map((p) => {
    const depth = -p.y * Math.sin(tilt);
    const scale = focal / (focal + depth);
    return { x: p.x * scale, y: p.y * Math.cos(tilt) * scale };
  });
  return local.map((p, i) => {
    const jx = p.x + params.jitter[i]!.x * w;
    const jy = p.y + params.jitter[i]!.y * w;
    return { x: params.center.x + jx * cos - jy * sin, y: params.center.y + jx * sin + jy * cos };
  }) as Quad;
}

export function renderSynthetic(card: RgbaImage, params: SynthParams, rng: Rng): { image: RgbaImage; corners: Quad } {
  const frame = renderBackground(params, rng);
  const corners = placedCorners(params, card);
  const cardRect: Point[] = [
    { x: 0, y: 0 },
    { x: card.width, y: 0 },
    { x: card.width, y: card.height },
    { x: 0, y: card.height },
  ];
  const toCard = homography(corners, cardRect)!;
  const cardPerPixel = card.width / (params.cardHeight * params.frame.height * (card.width / card.height));
  const radius = card.width * 0.045;
  const sleeveMargin = card.width * 0.025;

  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const pad = Math.ceil(sleeveMargin / cardPerPixel) + 2;
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - pad);
  const x1 = Math.min(params.frame.width - 1, Math.ceil(Math.max(...xs)) + pad);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - pad);
  const y1 = Math.min(params.frame.height - 1, Math.ceil(Math.max(...ys)) + pad);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const p = applyHomography(toCard, x + 0.5, y + 0.5);
      const p4 = (y * params.frame.width + x) * 4;
      const depth = roundedRectDepth(p.x, p.y, card.width, card.height, radius);
      const alpha = Math.max(0, Math.min(1, 0.5 + depth / cardPerPixel));
      if (alpha > 0) {
        for (let c = 0; c < 3; c++) {
          const sheen = params.foil ? foilSheen(params.foil, p.x, p.y, card.width, c) : 1;
          frame.data[p4 + c] = frame.data[p4 + c]! * (1 - alpha) + bilinear(card, p.x, p.y, c) * sheen * alpha;
        }
      }
      if (params.sleeved) {
        const sleeveDepth = roundedRectDepth(
          p.x + sleeveMargin,
          p.y + sleeveMargin,
          card.width + sleeveMargin * 2,
          card.height + sleeveMargin * 2,
          radius + sleeveMargin,
        );
        if (sleeveDepth > 0) {
          const band = Math.exp(-(((p.x - p.y * 0.6 - card.width * 0.1) / (card.width * 0.18)) ** 2));
          const haze = 0.07 + 0.18 * band;
          for (let c = 0; c < 3; c++) frame.data[p4 + c] = frame.data[p4 + c]! * (1 - haze) + 255 * haze;
          if (sleeveDepth < 1.5 * cardPerPixel) {
            for (let c = 0; c < 3; c++) frame.data[p4 + c] = frame.data[p4 + c]! * 0.85 + 255 * 0.15;
          }
        }
      }
    }
  }

  // Glare is placed in card coordinates, so it lands on the card.
  const glareAt = params.glare ? applyHomography(homography(cardRect, corners)!, params.glare.x * card.width, params.glare.y * card.height) : null;
  const glareRadius = params.glare ? (params.glare.radius * card.width) / cardPerPixel : 0;
  const { width, height } = params.frame;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const light =
        params.brightness *
        (1 + params.gradient.x * (x / width - 0.5) + params.gradient.y * (y / height - 0.5)) *
        (1 - 0.25 * (((x / width - 0.5) ** 2 + (y / height - 0.5) ** 2) * 2));
      const boost =
        glareAt && params.glare
          ? params.glare.strength * 255 * Math.exp(-((x - glareAt.x) ** 2 + (y - glareAt.y) ** 2) / (glareRadius * glareRadius))
          : 0;
      const p = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) frame.data[p + c] = frame.data[p + c]! * light * params.tint[c]! + boost;
    }
  }

  const blurred = blurRgba(frame, params.blur);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) blurred.data[i * 4 + c] = blurred.data[i * 4 + c]! + gaussian(rng) * params.noise;
    blurred.data[i * 4 + 3] = 255;
  }
  return { image: blurred, corners };
}

/**
 * The same photo at `factor` times the resolution: what a phone camera gives
 * when the frame isn't scaled down as far. Blur scales with it, so the image
 * is equally sharp relative to its size; noise stays per pixel.
 */
export function scaleParams(params: SynthParams, factor: number): SynthParams {
  return {
    ...params,
    frame: { width: Math.round(params.frame.width * factor), height: Math.round(params.frame.height * factor) },
    center: { x: params.center.x * factor, y: params.center.y * factor },
    blur: params.blur * factor,
  };
}

/**
 * Scenes for the `phone` set: how people actually hold a phone over a card.
 * `plain` is an ordinary scene without the extreme conditions; `tilt` views
 * the card 30–55° off straight-on (mostly with the title on the far edge,
 * phone tilted back); `dim` is either a dark frame or one the camera has
 * brightened, which is what a phone does in dim light: noisy and soft.
 */
export type PhoneScene = 'plain' | 'tilt' | 'dim';

export function phoneParams(rng: Rng, aspect: number, scene: PhoneScene, foil: boolean): SynthParams {
  const base = randomParams(rng, aspect);
  // Upright or upside down only: sideways cards are a separate problem.
  const turned = base.conditions.includes('upside-down');
  const conditions = base.conditions.filter((c) => !['sideways', 'blur', 'low-light', 'glare', 'clean'].includes(c));
  const params: SynthParams = {
    ...base,
    rotation: (uniform(rng, -8, 8) * Math.PI) / 180 + (turned ? Math.PI : 0),
    blur: uniform(rng, 0, 0.7),
    glare: base.glare && base.glare.strength < 0.4 ? base.glare : null,
    brightness: uniform(rng, 0.85, 1.1),
    conditions,
  };
  // The phone set's frames are portrait or landscape at live-camera size; the card fills a phone-like share.
  const portrait = params.frame.height > params.frame.width;
  params.cardHeight = portrait ? uniform(rng, 0.45, 0.65) : uniform(rng, 0.62, 0.85);

  if (scene === 'tilt') {
    const degrees = uniform(rng, 30, 55);
    params.tilt = ((rng() < 0.75 ? 1 : -1) * degrees * Math.PI) / 180;
    // Corner jitter on top of a real perspective would double-count it.
    params.jitter = params.jitter.map((j) => ({ x: j.x * 0.3, y: j.y * 0.3 }));
    conditions.push('tilt', degrees >= 42 ? 'tilt-steep' : 'tilt-moderate');
  } else if (scene === 'dim') {
    if (rng() < 0.5) {
      params.brightness = uniform(rng, 0.18, 0.35);
      params.noise = uniform(rng, 4, 8);
      conditions.push('dim', 'dim-dark');
    } else {
      params.brightness = uniform(rng, 0.6, 0.8);
      params.noise = uniform(rng, 10, 16);
      params.blur = uniform(rng, 0.9, 1.6);
      conditions.push('dim', 'dim-noisy');
    }
    params.jpegQuality = Math.round(uniform(rng, 70, 85));
  } else {
    conditions.push('plain');
  }
  if (foil) {
    params.foil = { angle: uniform(rng, 0, Math.PI), period: uniform(rng, 0.5, 1.2), phase: uniform(rng, 0, 2 * Math.PI), strength: uniform(rng, 0.12, 0.3) };
    conditions.push('foil');
  }
  // Keep the card inside the frame whatever was changed above.
  const h = params.cardHeight * params.frame.height;
  const w = h * aspect;
  const c = Math.abs(Math.cos(params.rotation));
  const s = Math.abs(Math.sin(params.rotation));
  const bw = w * c + h * s;
  const bh = w * s + h * c;
  const shrink = Math.min(1, (params.frame.width * 0.9) / bw, (params.frame.height * 0.92) / bh);
  params.cardHeight *= shrink;
  params.center = {
    x: Math.min(Math.max(params.center.x, (bw * shrink) / 2 + 8), params.frame.width - (bw * shrink) / 2 - 8),
    y: Math.min(Math.max(params.center.y, (bh * shrink) / 2 + 8), params.frame.height - (bh * shrink) / 2 - 8),
  };
  return params;
}
