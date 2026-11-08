import type { ExportContext, ExportFormat, ExportRow, ExtraColumn, LineStyle } from './types';

export type FormatLine = (row: ExportRow, style: LineStyle) => string;

/** Merges rows that would print identically, e.g. the same printing in two conditions. */
export function renderLines(rows: readonly ExportRow[], style: LineStyle, formatLine: FormatLine): string[] {
  const merged = new Map<string, ExportRow>();
  for (const row of rows) {
    const key = formatLine({ ...row, qty: 1 }, style);
    const existing = merged.get(key);
    if (existing) existing.qty += row.qty;
    else merged.set(key, { ...row });
  }
  return [...merged.values()].map((row) => formatLine(row, style));
}

export function plainListFormat(formatLine: FormatLine): ExportFormat {
  return {
    id: 'plain',
    label: 'Plain list',
    extension: 'txt',
    mimeType: 'text/plain',
    supportsGrouping: false,
    supportsExtraColumns: false,
    note: 'Works almost everywhere, including EDHREC and AI chats. Each card appears once, under its front-face name.',
    render: (rows) => renderLines(rows, 'plain', formatLine).join('\n') + '\n',
  };
}

export function detailedListFormat(formatLine: FormatLine): ExportFormat {
  return {
    id: 'detailed',
    label: 'Detailed list',
    extension: 'txt',
    mimeType: 'text/plain',
    supportsGrouping: true,
    supportsExtraColumns: false,
    note: 'Moxfield and Arena style, with set, number and finish.',
    render: (rows) => renderLines(rows, 'detailed', formatLine).join('\n') + '\n',
  };
}

function escapeTableCell(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/\s*[\r\n]+\s*/g, ' ');
}

function escapeHeading(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ');
}

export interface MarkdownOptions {
  formatLine: FormatLine;
  finishLabel: (finish: string) => string;
  extraColumns: readonly ExtraColumn[];
}

export function markdownFormat({ formatLine, finishLabel, extraColumns }: MarkdownOptions): ExportFormat {
  return {
    id: 'markdown',
    label: 'Markdown for AI',
    extension: 'md',
    mimeType: 'text/markdown',
    supportsGrouping: true,
    supportsExtraColumns: true,
    note: 'A table plus a list ready to paste. Add type, colors and mana value to get better deck advice from an AI.',
    render(rows: ExportRow[], context: ExportContext): string {
      const columns = extraColumns.filter((column) => context.extraColumnIds.includes(column.id));
      const header = ['Qty', 'Name', 'Set', '#', 'Finish', 'Lang', ...columns.map((column) => column.label)];
      const toTableLine = (cells: readonly string[]) => `| ${cells.map(escapeTableCell).join(' | ')} |`;

      // Condition isn't a column, so rows differing only in condition would print twice. Merge them.
      const tableRows = new Map<string, { qty: number; cells: string[] }>();
      for (const row of rows) {
        const cells = [
          row.name,
          row.printing?.set.toUpperCase() ?? '',
          row.printing?.number ?? '',
          row.finish ? finishLabel(row.finish) : '',
          row.lang ?? '',
          ...columns.map((column) => column.value(row.reference)),
        ];
        const key = JSON.stringify(cells);
        const existing = tableRows.get(key);
        if (existing) existing.qty += row.qty;
        else tableRows.set(key, { qty: row.qty, cells });
      }

      const totalCards = rows.reduce((sum, row) => sum + row.qty, 0);
      const uniqueNames = new Set(rows.map((row) => row.name)).size;

      return [
        `# ${escapeHeading(context.batchName)}`,
        '',
        ...(context.location ? [`- Location: ${escapeHeading(context.location)}`] : []),
        `- Created: ${context.createdAt.slice(0, 10)}`,
        `- Exported: ${context.generatedAt.slice(0, 10)}`,
        `- Cards: ${totalCards}`,
        `- Unique: ${uniqueNames}`,
        '',
        toTableLine(header),
        `|${header.map(() => '---').join('|')}|`,
        ...[...tableRows.values()].map(({ qty, cells }) => toTableLine([String(qty), ...cells])),
        '',
        '```text',
        ...renderLines(rows, 'plain', formatLine),
        '```',
        '',
      ].join('\n');
    },
  };
}
