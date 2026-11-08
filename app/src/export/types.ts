import type { Printing } from '../games/types';

export type GroupBy = 'printing' | 'name';
export type LineStyle = 'plain' | 'detailed';

/** One aggregated line of an export. */
export interface ExportRow {
  qty: number;
  name: string;
  exportName: string;
  /** Null when grouped by name: no single printing applies, so printing columns stay empty. */
  printing: Printing | null;
  finish: string | null;
  lang: string | null;
  condition: string | null;
  /** Any one printing of this card, for attributes that don't vary by printing. */
  reference: Printing;
  /** Earliest ISO timestamp among the merged items. */
  addedAt: string;
}

export interface ExportContext {
  batchName: string;
  location?: string;
  createdAt: string;
  generatedAt: string;
  groupBy: GroupBy;
  extraColumnIds: string[];
}

export interface ExtraColumn {
  id: string;
  label: string;
  value: (printing: Printing) => string;
}

export interface ExportFormat {
  id: string;
  label: string;
  extension: 'txt' | 'md' | 'csv';
  mimeType: string;
  /** False when output is the same whichever way the rows are grouped. */
  supportsGrouping: boolean;
  supportsExtraColumns: boolean;
  /** Import advice shown next to the format. */
  note?: string;
  render: (rows: ExportRow[], context: ExportContext) => string;
}
