/**
 * Rejects frames before spending OCR on them, and says what to change. Every
 * check is cheap and runs on the rectified card, except the framing checks,
 * which use the corners in the frame.
 */
import { laplacianVariance } from './filters';
import { distance, type Quad } from './geometry';
import { cropGray, luma, toGray, type Box, type GrayImage, type RgbaImage } from './image';
import { cardPose } from './perspective';
import type { Size } from './rectify';

export type QualityIssue = 'out-of-frame' | 'too-small' | 'blurry' | 'glare' | 'too-dark';

/** In the order they should be fixed: there is no point asking for stillness before the card is in view. */
export const QUALITY_ISSUES: readonly QualityIssue[] = ['out-of-frame', 'too-small', 'too-dark', 'glare', 'blurry'];

export const QUALITY_HINTS: Record<QualityIssue, string> = {
  'out-of-frame': 'Fit the whole card in the frame.',
  'too-small': 'Move closer: the card is too small.',
  'too-dark': 'Too dark: add some light.',
  glare: 'Too much glare: tilt the card.',
  blurry: 'Hold still: the picture is blurry.',
};

/**
 * Conditions that don't stop a read but make it likelier to fail: worth
 * telling the user while they line the card up, and when a card can't be read.
 */
export type QualityAdvice = 'tilted' | 'dim';

export const ADVICE_HINTS: Record<QualityAdvice, string> = {
  tilted: 'Hold the phone flatter, straight above the card.',
  dim: 'More light would help.',
};

export interface QualityThresholds {
  /** Card width in the frame, in pixels. */
  minCardWidth: number;
  /** Corners must be at least this fraction of the frame's short side from its edges. */
  edgeMargin: number;
  /** Laplacian variance of the title region at canonical size. */
  minSharpness: number;
  /** Share of blown-out pixels allowed in the title region. */
  maxTitleGlare: number;
  /** Share of blown-out pixels allowed on the card as a whole. */
  maxCardGlare: number;
  /** Mean luma of the card, 0–255. */
  minBrightness: number;
  /** Degrees of tilt from straight above the card beyond which to advise holding the phone flatter. */
  adviseTilt: number;
  /** Mean luma below which to advise more light (above minBrightness, the card is still read). */
  adviseBrightness: number;
  /**
   * Noise level (see noiseLevel) above which a card that isn't bright either
   * (mean luma under adviseNoisyBrightness) gets the advice: the camera is
   * brightening a dim scene.
   */
  adviseNoise: number;
  adviseNoisyBrightness: number;
}

export const DEFAULT_QUALITY: QualityThresholds = {
  minCardWidth: 200,
  edgeMargin: 0.005,
  minSharpness: 60,
  maxTitleGlare: 0.08,
  maxCardGlare: 0.2,
  minBrightness: 35,
  adviseTilt: 35,
  adviseBrightness: 70,
  adviseNoise: 1.8,
  adviseNoisyBrightness: 90,
};

export interface QualityMetrics {
  cardWidth: number;
  sharpness: number;
  titleGlare: number;
  cardGlare: number;
  brightness: number;
  /** Degrees between the card's face and the camera's view, assuming a phone camera; 0 when unknown. */
  tilt: number;
  /** Sensor noise of the card, in grey levels (see noiseLevel). */
  noise: number;
}

export interface QualityReport {
  ok: boolean;
  /** Most important first. */
  issues: QualityIssue[];
  /** Not reasons to skip the frame, but worth saying. */
  advice: QualityAdvice[];
  metrics: QualityMetrics;
}

/** A pixel is blown out when every channel is near the top: glare is white, whatever the card's colour. */
function glareShare(image: RgbaImage, box: Box): number {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(image.width, Math.ceil(box.x + box.width));
  const y1 = Math.min(image.height, Math.ceil(box.y + box.height));
  let blown = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * image.width + x) * 4;
      total++;
      if (image.data[p]! >= 245 && image.data[p + 1]! >= 245 && image.data[p + 2]! >= 245) blown++;
    }
  }
  return total ? blown / total : 0;
}

/**
 * Sensor noise, as a standard deviation in grey levels (Immerkær, "Fast noise
 * variance estimation", 1996). Fine texture adds to it a little, but a phone
 * brightening a dim scene adds far more: the picture looks fine, just grainy.
 */
export function noiseLevel(gray: GrayImage): number {
  const { width, height, data } = gray;
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const value =
        data[i - width - 1]! - 2 * data[i - width]! + data[i - width + 1]! -
        2 * data[i - 1]! + 4 * data[i]! - 2 * data[i + 1]! +
        data[i + width - 1]! - 2 * data[i + width]! + data[i + width + 1]!;
      sum += Math.abs(value);
    }
  }
  return (Math.sqrt(Math.PI / 2) * sum) / (6 * (width - 2) * (height - 2));
}

function meanLuma(image: RgbaImage): number {
  let sum = 0;
  const pixels = image.width * image.height;
  for (let p = 0; p < pixels * 4; p += 4) sum += luma(image.data[p]!, image.data[p + 1]!, image.data[p + 2]!);
  return pixels ? sum / pixels : 0;
}

export function assessQuality(input: {
  frame: Size;
  corners: Quad;
  card: RgbaImage;
  titleBox: Box;
  thresholds?: QualityThresholds;
}): QualityReport {
  const { frame, corners, card, titleBox } = input;
  const thresholds = input.thresholds ?? DEFAULT_QUALITY;

  const cardWidth = (distance(corners[0], corners[1]) + distance(corners[3], corners[2])) / 2;
  const margin = Math.min(frame.width, frame.height) * thresholds.edgeMargin;
  const inFrame = corners.every(
    (p) => p.x >= margin && p.y >= margin && p.x <= frame.width - 1 - margin && p.y <= frame.height - 1 - margin,
  );

  // Inset by the card's border so a white border isn't mistaken for glare.
  const inset = card.width * 0.05;
  const inner = { x: inset, y: inset, width: card.width - inset * 2, height: card.height - inset * 2 };
  const gray = toGray(card);
  const metrics: QualityMetrics = {
    cardWidth,
    sharpness: laplacianVariance(cropGray(gray, titleBox)),
    titleGlare: glareShare(card, titleBox),
    cardGlare: glareShare(card, inner),
    brightness: meanLuma(card),
    tilt: cardPose(corners, frame)?.tilt ?? 0,
    noise: noiseLevel(gray),
  };

  const found = new Set<QualityIssue>();
  if (!inFrame) found.add('out-of-frame');
  if (cardWidth < thresholds.minCardWidth) found.add('too-small');
  if (metrics.brightness < thresholds.minBrightness) found.add('too-dark');
  if (metrics.titleGlare > thresholds.maxTitleGlare || metrics.cardGlare > thresholds.maxCardGlare) found.add('glare');
  if (metrics.sharpness < thresholds.minSharpness) found.add('blurry');

  const issues = QUALITY_ISSUES.filter((issue) => found.has(issue));
  const advice: QualityAdvice[] = [];
  if (metrics.tilt > thresholds.adviseTilt) advice.push('tilted');
  const dim =
    metrics.brightness < thresholds.adviseBrightness ||
    (metrics.noise > thresholds.adviseNoise && metrics.brightness < thresholds.adviseNoisyBrightness);
  if (dim && !found.has('too-dark')) advice.push('dim');
  return { ok: issues.length === 0, issues, advice, metrics };
}
