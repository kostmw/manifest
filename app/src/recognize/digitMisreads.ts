/**
 * How likely a collector number read by OCR is a misreading of another: an
 * edit distance over digits where the swaps OCR makes in small card fonts
 * cost half. Measured on round 11's Doctor Who cards, whose 5 reads as 6 or 8
 * ("R0S87" for 557, "R0860" for 560, "0664" for 564, "R0S46" for 548).
 */
const CONFUSED = new Set(['56', '58', '68', '38', '89', '08', '17', '35', '69']);
const LIKELY_SWAP = 0.5;

function swapCost(a: string, b: string): number {
  if (a === b) return 0;
  return CONFUSED.has(a < b ? a + b : b + a) ? LIKELY_SWAP : 1;
}

/** Edit distance from `read` to `actual` (both digit strings, no leading zeros), likely swaps costing half. */
export function numberMisreadCost(read: string, actual: string): number {
  const rows = read.length + 1;
  const cols = actual.length + 1;
  let previous = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i++) {
    const current = [i];
    for (let j = 1; j < cols; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + swapCost(read[i - 1]!, actual[j - 1]!));
    }
    previous = current;
  }
  return previous[cols - 1]!;
}
