/**
 * Rejects frames before spending OCR on them, and says what to change. Every
 * check is cheap and runs on the rectified card, except the framing checks,
 * which use the corners in the frame.
 */
import { laplacianVariance } from './filters';
import { distance, type Quad } from './geometry';
import { cropGray, luma, toGray, type Box, type RgbaImage } from './image';
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
}

export const DEFAULT_QUALITY: QualityThresholds = {
  minCardWidth: 200,
  edgeMargin: 0.005,
  minSharpness: 60,
  maxTitleGlare: 0.08,
  maxCardGlare: 0.2,
  minBrightness: 35,
};

export interface QualityMetrics {
  cardWidth: number;
  sharpness: number;
  titleGlare: number;
  cardGlare: number;
  brightness: number;
}

export interface QualityReport {
  ok: boolean;
  /** Most important first. */
  issues: QualityIssue[];
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
  const metrics: QualityMetrics = {
    cardWidth,
    sharpness: laplacianVariance(cropGray(toGray(card), titleBox)),
    titleGlare: glareShare(card, titleBox),
    cardGlare: glareShare(card, inner),
    brightness: meanLuma(card),
  };

  const found = new Set<QualityIssue>();
  if (!inFrame) found.add('out-of-frame');
  if (cardWidth < thresholds.minCardWidth) found.add('too-small');
  if (metrics.brightness < thresholds.minBrightness) found.add('too-dark');
  if (metrics.titleGlare > thresholds.maxTitleGlare || metrics.cardGlare > thresholds.maxCardGlare) found.add('glare');
  if (metrics.sharpness < thresholds.minSharpness) found.add('blurry');

  const issues = QUALITY_ISSUES.filter((issue) => found.has(issue));
  return { ok: issues.length === 0, issues, metrics };
}
