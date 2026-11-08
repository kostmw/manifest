import type { ExportFormat, ExportRow, ExtraColumn, LineStyle } from '../export/types';
import type { GameId } from './types';

export interface Choice {
  code: string;
  label: string;
}

/**
 * Everything the shared app needs to know about one game. Index building lives
 * in scripts/games because it needs Node. Card regions and collector-line
 * parsing join this interface with the recognition milestones that use them.
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
}
