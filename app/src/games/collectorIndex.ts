/**
 * collectors.<game>.json: set code → collector number → card name, for
 * identifying a card from its collector line when the title can't be read
 * (showcase fonts, other languages, glare on the title). Numbers are keyed by
 * their first run of digits without leading zeros, which is what a collector
 * line shows: "0166" on the card is Scryfall's "166" or a promo's "166s".
 *
 *   { "ltr": { "166": 1234, "20": [55, 56] } }   // indices into names.<game>.json
 *
 * Shared by the index builder and the app, so it must stay free of browser and Node APIs.
 */
import type { Printing } from './types';

export type CollectorIndexFile = Record<string, Record<string, number | number[]>>;

/** "0166" → "166", "166s" → "166", "DOM-70" (The List) → "70", "★" → null. */
export function collectorNumberCore(number: string): string | null {
  const digits = /-(\d+)\D*$/.exec(number)?.[1] ?? /\d+/.exec(number)?.[0];
  if (digits === undefined) return null;
  return String(Number(digits));
}

/**
 * Only printings from `since` on: older cards print no set code, so they can't
 * be looked up by one.
 */
export function buildCollectorIndex(printings: readonly Printing[], names: readonly string[], since: string): CollectorIndexFile {
  const nameIndex = new Map(names.map((name, i) => [name, i]));
  const sets = new Map<string, Map<string, Set<number>>>();
  for (const printing of printings) {
    if ((printing.released ?? '') < since) continue;
    const core = collectorNumberCore(printing.number);
    const index = nameIndex.get(printing.name);
    if (core === null || index === undefined) continue;
    const numbers = sets.get(printing.set) ?? new Map<string, Set<number>>();
    const found = numbers.get(core) ?? new Set<number>();
    found.add(index);
    numbers.set(core, found);
    sets.set(printing.set, numbers);
  }
  const out: CollectorIndexFile = {};
  for (const set of [...sets.keys()].sort()) {
    const numbers = sets.get(set)!;
    const entry: Record<string, number | number[]> = {};
    for (const core of [...numbers.keys()].sort((a, b) => Number(a) - Number(b))) {
      const indices = [...numbers.get(core)!].sort((a, b) => a - b);
      entry[core] = indices.length === 1 ? indices[0]! : indices;
    }
    out[set] = entry;
  }
  return out;
}

export class CollectorIndex {
  constructor(
    private readonly file: CollectorIndexFile,
    private readonly names: readonly string[],
  ) {}

  /** Every set code in the index, lower case. */
  sets(): string[] {
    return Object.keys(this.file);
  }

  /** Card names printed as `number` in `set`; empty when there are none. */
  lookup(set: string, number: string): string[] {
    const core = collectorNumberCore(number);
    if (core === null) return [];
    const found = this.file[set.toLowerCase()]?.[core];
    if (found === undefined) return [];
    return (Array.isArray(found) ? found : [found]).map((i) => this.names[i]!).filter(Boolean);
  }
}
