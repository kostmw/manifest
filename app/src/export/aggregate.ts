import type { BatchItem } from '../session/types';
import type { ExportRow, GroupBy } from './types';

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function rowKey(item: BatchItem, groupBy: GroupBy): string {
  return groupBy === 'name'
    ? item.printing.name
    : JSON.stringify([item.printing.id, item.finish, item.lang, item.condition]);
}

function compareRows(a: ExportRow, b: ExportRow): number {
  return (
    collator.compare(a.name, b.name) ||
    collator.compare(a.printing?.set ?? '', b.printing?.set ?? '') ||
    collator.compare(a.printing?.number ?? '', b.printing?.number ?? '') ||
    collator.compare(a.finish ?? '', b.finish ?? '') ||
    collator.compare(a.lang ?? '', b.lang ?? '') ||
    collator.compare(a.condition ?? '', b.condition ?? '')
  );
}

/** Merges duplicates into export rows, sorted so that output never depends on scan order. */
export function aggregate(items: readonly BatchItem[], groupBy: GroupBy): ExportRow[] {
  const rows = new Map<string, ExportRow>();
  for (const item of items) {
    const key = rowKey(item, groupBy);
    const row = rows.get(key);
    if (row) {
      row.qty += item.qty;
      if (item.addedAt < row.addedAt) row.addedAt = item.addedAt;
      continue;
    }
    const byPrinting = groupBy === 'printing';
    rows.set(key, {
      qty: item.qty,
      name: item.printing.name,
      exportName: item.printing.exportName ?? item.printing.name,
      printing: byPrinting ? item.printing : null,
      finish: byPrinting ? item.finish : null,
      lang: byPrinting ? item.lang : null,
      condition: byPrinting ? item.condition : null,
      reference: item.printing,
      addedAt: item.addedAt,
    });
  }
  return [...rows.values()].sort(compareRows);
}
