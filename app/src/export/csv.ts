type Cell = string | number;

function encodeCell(cell: Cell, quoteAll: boolean): string {
  const text = String(cell);
  if (quoteAll || /[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

/** RFC 4180 quoting. LF line endings and no BOM, matching the real exports in tests/fixtures/formats. */
export function toCsv(header: readonly string[], rows: readonly (readonly Cell[])[], quoteAll = false): string {
  return [header, ...rows].map((row) => row.map((cell) => encodeCell(cell, quoteAll)).join(',')).join('\n') + '\n';
}
