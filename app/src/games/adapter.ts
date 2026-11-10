import type { ExportFormat, ExportRow, ExtraColumn, LineStyle } from '../export/types';
import type { CollectorRegion } from '../recognize/collectorCrop';
import type { TitleRegion } from '../recognize/titleCrop';
import type { Box } from '../vision/image';
import type { GameId, Printing } from './types';

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
  /** The band searched for the collector line (MTG: bottom left); see recognize/collectorCrop. */
  collector: CollectorRegion;
  /** Artwork, for visual fingerprints. */
  art: Box;
  /**
   * Where else a detected outline can lie on the card, in card pixels, besides
   * the card's own edge: the frame line inside a dark border on a dark mat, a
   * sleeve's edge. The art hash tries each and keeps the best fit.
   */
  outlines: readonly { id: string; box: Box }[];
}

/** What a collector line says, as far as OCR could read it. */
export interface CollectorReading {
  /** Collector numbers, without leading zeros, most likely first. */
  numbers: string[];
  /** Set codes the text could spell, upper case, most likely first. */
  sets: string[];
  /**
   * True when the numbers are guesses from loose digits (a lost slash or
   * rarity), not a recognizable collector-number shape: weaker evidence.
   */
  looseNumbers?: boolean;
  /** The printed set size ("261" in "083/261"), when there is one. */
  total?: string;
  rarity?: string;
  /** The data source's language code, when printed. */
  lang?: string;
  /** The OCR text it came from. */
  text: string;
}

/** How a collector reading fits one printing. */
export interface CollectorMatch {
  number: 'exact' | 'conflict' | 'unread';
  set: 'exact' | 'close' | 'conflict' | 'unread';
  /**
   * Evidence for this printing: about 1.6 when set and number both match,
   * 1 for the number alone (less when the number was a loose guess),
   * negative when what was read contradicts it, 0 when nothing was read.
   */
  score: number;
}

/**
 * Everything the shared app needs to know about one game. Index building lives
 * in scripts/games because it needs Node.
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
  /** Reads set, number and language out of the OCR text of the collector line's rows. Null when there is nothing useful. */
  parseCollectorLine: (lines: readonly string[]) => CollectorReading | null;
  /** How well a reading fits a printing, knowing how this game prints codes on promos and reprints. */
  matchCollector: (reading: CollectorReading, printing: Pick<Printing, 'set' | 'number'>) => CollectorMatch;
  /**
   * A small score for how common this kind of printing is in a collection (0
   * for a normal one, about -0.1 for a promo), which breaks ties between
   * printings that look and read the same.
   */
  printingPrior: (printing: Pick<Printing, 'set' | 'number'>) => number;
}
