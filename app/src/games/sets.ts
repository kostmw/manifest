/**
 * sets.<game>.json: every set in the index with its name, release date and
 * printing count, for choosing sets to lock a batch to. Shared by the index
 * builder and the app, so it must stay free of browser and Node APIs.
 */
import type { Printing } from './types';

export interface SetInfo {
  /** The data source's code, lower case. */
  code: string;
  name: string;
  /** ISO date of the set's earliest printing, when known. */
  released?: string;
  printings: number;
}

/** Newest first, then by name. */
export function buildSetList(printings: readonly Printing[]): SetInfo[] {
  const sets = new Map<string, SetInfo>();
  for (const printing of printings) {
    const found = sets.get(printing.set);
    if (!found) {
      sets.set(printing.set, {
        code: printing.set,
        name: printing.setName,
        ...(printing.released ? { released: printing.released } : {}),
        printings: 1,
      });
      continue;
    }
    found.printings += 1;
    if (printing.released && (!found.released || printing.released < found.released)) found.released = printing.released;
  }
  return [...sets.values()].sort(
    (a, b) => (b.released ?? '').localeCompare(a.released ?? '') || a.name.localeCompare(b.name) || a.code.localeCompare(b.code),
  );
}

/** Sets whose code or name matches what was typed: exact codes first, then names that start with it, then the rest. */
export function searchSets(sets: readonly SetInfo[], query: string, limit = 8): SetInfo[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [];
  const rank = (set: SetInfo): number => {
    const name = set.name.toLowerCase();
    if (set.code === wanted) return 0;
    if (name.startsWith(wanted)) return 1;
    if (set.code.startsWith(wanted)) return 2;
    if (name.split(/[\s:—–-]+/).some((word) => word.startsWith(wanted))) return 3;
    if (name.includes(wanted)) return 4;
    return 9;
  };
  return sets
    .map((set) => ({ set, rank: rank(set) }))
    .filter(({ rank }) => rank < 9)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map(({ set }) => set);
}
