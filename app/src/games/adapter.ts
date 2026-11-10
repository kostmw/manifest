import type { ExportFormat, ExportRow, ExtraColumn, LineStyle } from '../export/types';
import type { TitleRegion } from '../recognize/titleCrop';
import type { Box } from '../vision/image';
import type { GameId } from './types';

export interface Choice {
  code: string;
  label: string;
}

/**
 * Where things are on an upright, rectified card. Every box is in pixels of
 * `size`, the canonical size cards are warped to, which also fixes the card's
 * aspect ratio for detection.
 */
export interface CardRegions {
  size: { width: number; height: number };
  /** Printed border width at the top and sides, as a share of the card's width. Helps detection on dark mats. */
  border: number;
  /** The band searched for the title line; see recognize/titleCrop. */
  title: TitleRegion;
  /** Set code and collector number (MTG: bottom left). Calibrated in M3. */
  collector: Box;
  /** Artwork, for visual fingerprints. Calibrated in M3. */
  art: Box;
}

/**
 * Everything the shared app needs to know about one game. Index building lives
 * in scripts/games because it needs Node. Collector-line parsing joins this
 * interface in M3, with the milestone that calibrates it.
 */
export interface GameAdapter {
  id: GameId;
  displayName: string;
  finishes: readonly Choice[];
  languages: readonly Choice[];
  conditions: readonly Choice[];
  defaultLang: string;
  defaultCondition: string;
  extraColumns: readonly ExtraColumn[];
  exportFormats: readonly ExportFormat[];
  formatExportLine: (row: ExportRow, style: LineStyle) => string;
  regions: CardRegions;
}
