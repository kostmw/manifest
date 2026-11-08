import type { NameDictionary } from '../games/types';

/** Lowercase, no accents or punctuation: "Lim-Dûl's Vault" becomes "lim duls vault", "Æther" becomes "aether". */
export function normalizeName(text: string): string {
  return text
    .replace(/[æÆ]/g, 'ae')
    .replace(/[œŒ]/g, 'oe')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Optimal string alignment distance, a Damerau-Levenshtein variant. Returns limit + 1 once it exceeds limit. */
export function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  if (a === b) return 0;

  let beforePrevious: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, beforePrevious[j - 2]! + 1);
      }
      current[j] = best;
      if (best < rowBest) rowBest = best;
    }
    if (rowBest > limit) return limit + 1;
    beforePrevious = previous;
    previous = current;
  }
  return previous[b.length]!;
}

function trigrams(key: string): string[] {
  const padded = ` ${key} `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) grams.add(padded.slice(i, i + 3));
  return [...grams];
}

export type MatchTier = 'exact' | 'prefix' | 'word-prefix' | 'substring' | 'fuzzy';

const TIER_RANK: Record<MatchTier, number> = { exact: 0, prefix: 1, 'word-prefix': 2, substring: 3, fuzzy: 4 };

export interface NameHit {
  /** The full name to look up printings with. */
  name: string;
  /** The face that matched, when it isn't the full name. */
  matchedFace?: string;
  tier: MatchTier;
  /** Edit distance. Zero unless the tier is fuzzy. */
  distance: number;
}

interface Entry {
  key: string;
  name: string;
  face?: string;
}

const FUZZY_SHORTLIST = 64;

function fuzzyLimit(length: number): number {
  return Math.min(4, Math.ceil(length / 4));
}

function classify(key: string, query: string, tokens: readonly string[]): MatchTier | null {
  if (key === query) return 'exact';
  if (key.startsWith(query)) return 'prefix';
  if (tokens.every((token) => key.startsWith(token) || key.includes(` ${token}`))) return 'word-prefix';
  if (key.includes(query)) return 'substring';
  return null;
}

/** Searches card names, including each face of multi-face cards. Pure and synchronous; run it in a worker. */
export class NameIndex {
  private readonly entries: Entry[];
  private postings: Map<string, number[]> | null = null;

  constructor(dictionary: NameDictionary) {
    this.entries = dictionary.names.map((name) => ({ key: normalizeName(name), name }));
    for (const [face, fullNames] of Object.entries(dictionary.faces)) {
      const key = normalizeName(face);
      for (const name of fullNames) this.entries.push({ key, name, face });
    }
  }

  search(query: string, limit = 10): NameHit[] {
    const normalized = normalizeName(query);
    if (!normalized) return [];
    const tokens = normalized.split(' ');

    const best = new Map<string, NameHit>();
    const consider = (hit: NameHit) => {
      const current = best.get(hit.name);
      if (!current || this.isBetter(hit, current)) best.set(hit.name, hit);
    };

    for (const entry of this.entries) {
      const tier = classify(entry.key, normalized, tokens);
      if (tier) consider({ name: entry.name, matchedFace: entry.face, tier, distance: 0 });
    }

    if (best.size < limit && normalized.length >= 3) {
      for (const hit of this.fuzzy(normalized)) {
        if (!best.has(hit.name)) best.set(hit.name, hit);
      }
    }

    return [...best.values()].sort((a, b) => this.compare(a, b)).slice(0, limit);
  }

  private isBetter(a: NameHit, b: NameHit): boolean {
    return this.compare(a, b) < 0;
  }

  private compare(a: NameHit, b: NameHit): number {
    return (
      TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
      a.distance - b.distance ||
      // A hit on the card's own name beats a hit on one of its faces.
      Number(a.matchedFace !== undefined) - Number(b.matchedFace !== undefined) ||
      a.name.length - b.name.length ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    );
  }

  private getPostings(): Map<string, number[]> {
    if (this.postings) return this.postings;
    const postings = new Map<string, number[]>();
    this.entries.forEach((entry, index) => {
      for (const gram of trigrams(entry.key)) {
        const list = postings.get(gram);
        if (list) list.push(index);
        else postings.set(gram, [index]);
      }
    });
    this.postings = postings;
    return postings;
  }

  /** Typos: shortlist by shared trigrams, then confirm with edit distance. */
  private fuzzy(query: string): NameHit[] {
    const postings = this.getPostings();
    const overlap = new Map<number, number>();
    for (const gram of trigrams(query)) {
      for (const index of postings.get(gram) ?? []) overlap.set(index, (overlap.get(index) ?? 0) + 1);
    }
    const shortlist = [...overlap.entries()].sort((a, b) => b[1] - a[1]).slice(0, FUZZY_SHORTLIST);

    const limit = fuzzyLimit(query.length);
    const hits: NameHit[] = [];
    for (const [index] of shortlist) {
      const entry = this.entries[index]!;
      // Compare against the start of the name too, since the user may still be typing.
      const distance = Math.min(
        editDistance(query, entry.key, limit),
        editDistance(query, entry.key.slice(0, query.length), limit),
      );
      if (distance <= limit) hits.push({ name: entry.name, matchedFace: entry.face, tier: 'fuzzy', distance });
    }
    return hits;
  }
}
