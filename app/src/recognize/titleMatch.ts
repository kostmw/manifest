/**
 * Turns a noisy OCR reading of a card's title into ranked card names. OCR adds
 * junk around the name (mana symbols read as letters, a frame edge read as
 * "l"), so stray characters before and after the name cost less than real
 * edits, and so do missing or extra spaces.
 */
import { normalizeName, type NameIndex } from './nameSearch';

export interface NameCandidate {
  /** Full name, the way the index spells it. */
  name: string;
  /** The face that matched, for multi-face cards. */
  matchedFace?: string;
  /** Weighted alignment cost between the name and the reading. */
  distance: number;
  /** 1 for a perfect match, falling to 0. */
  similarity: number;
}

export interface TitleMatch {
  /** Best first, at most `limit`, one per full name. */
  candidates: NameCandidate[];
  /** 0–1: how sure the top candidate is right, from its similarity and its lead over the next. */
  confidence: number;
  /** The normalized reading that was matched. */
  reading: string;
}

const SHORTLIST = 300;
/** Readings this short share too few trigrams with their name, so every name of similar length is checked. */
const SHORT_READING = 8;
/** Per character of junk before or after the name. */
export const JUNK_COST = 0.3;
/** A missing or extra space inside the name. */
const SPACE_COST = 0.3;
/** How far ahead of the runner-up the best name must be for full confidence. */
const CLEAR_LEAD = 0.2;

/**
 * Semi-global alignment: the whole name against any stretch of the reading.
 * Reading characters outside that stretch cost JUNK_COST each (spaces free);
 * inside it, ordinary edits cost 1 except spaces, which cost SPACE_COST.
 */
export function alignmentCost(name: string, reading: string): number {
  const n = name.length;
  const m = reading.length;
  let previous = new Float64Array(m + 1);
  let current = new Float64Array(m + 1);
  // Skipping a leading stretch of the reading is junk.
  for (let j = 1; j <= m; j++) previous[j] = previous[j - 1]! + (reading[j - 1] === ' ' ? 0 : JUNK_COST);
  let beforePrevious = new Float64Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const a = name[i - 1]!;
    current[0] = previous[0]! + (a === ' ' ? SPACE_COST : 1);
    for (let j = 1; j <= m; j++) {
      const b = reading[j - 1]!;
      const substitute = previous[j - 1]! + (a === b ? 0 : 1);
      const skipName = previous[j]! + (a === ' ' ? SPACE_COST : 1);
      const skipReading = current[j - 1]! + (b === ' ' ? SPACE_COST : 1);
      let best = Math.min(substitute, skipName, skipReading);
      if (i > 1 && j > 1 && a === reading[j - 2] && name[i - 2] === b) best = Math.min(best, beforePrevious[j - 2]! + 1);
      current[j] = best;
    }
    [beforePrevious, previous, current] = [previous, current, beforePrevious];
  }
  // Trailing junk after the end of the name.
  let best = Number.POSITIVE_INFINITY;
  let tail = 0;
  for (let j = m; j >= 0; j--) {
    best = Math.min(best, previous[j]! + tail);
    if (j > 0 && reading[j - 1] !== ' ') tail += JUNK_COST;
  }
  return best;
}

export function similarityFor(name: string, distance: number): number {
  return Math.max(0, 1 - distance / Math.max(name.replace(/ /g, '').length, 4));
}

interface Scored extends NameCandidate {
  /** The normalized text that matched: a candidate with the same key reads identically. */
  key: string;
}

/**
 * High when the best name is a near-exact match and clearly ahead of the best
 * candidate that reads differently. Names that read the same (a card and its
 * reversible printing "X // X") can't be told apart by the title, so they
 * don't count against each other.
 */
export function matchConfidence(candidates: readonly Scored[]): number {
  const first = candidates[0];
  if (!first) return 0;
  const second = candidates.find((candidate) => candidate.key !== first.key)?.similarity ?? 0;
  const lead = Math.min(1, Math.max(0, first.similarity - second) / CLEAR_LEAD);
  return Math.min(first.similarity * (0.5 + 0.5 * lead), shortNameCap(first.key));
}

/**
 * A very short name ("Ow", "Opt") is too little evidence on its own: two
 * letters of junk can spell it. Such cards always go to review.
 */
export function shortNameCap(key: string): number {
  const letters = key.replace(/ /g, '').length;
  return letters <= 3 ? 0.85 : letters <= 5 ? 0.95 : 1;
}

/** "X // X": a reversible printing of one card. Rarer than the card itself, so it ranks after it. */
const isReversible = (name: string) => {
  const faces = name.split(' // ');
  return faces.length > 1 && faces.every((face) => face === faces[0]);
};

export function matchTitle(index: NameIndex, rawText: string, limit = 5): TitleMatch {
  const reading = normalizeName(rawText);
  const letters = reading.replace(/ /g, '').length;
  if (letters < 2) return { candidates: [], confidence: 0, reading };

  const pool = new Map<object, { key: string; name: string; face?: string }>();
  for (const entry of index.shortlist(reading, SHORTLIST)) pool.set(entry, entry);
  if (letters <= SHORT_READING) {
    for (const entry of index.entriesNear(letters, 2)) pool.set(entry, entry);
  }

  const best = new Map<string, Scored>();
  for (const entry of pool.values()) {
    // Names that are nearly all punctuation ("_____") normalize to nothing and would match any junk.
    if (entry.key.replace(/ /g, '').length < 2) continue;
    const distance = alignmentCost(entry.key, reading);
    const similarity = similarityFor(entry.key, distance);
    if (similarity <= 0) continue;
    const current = best.get(entry.name);
    const better =
      !current ||
      distance < current.distance ||
      (distance === current.distance && current.matchedFace !== undefined && entry.face === undefined);
    if (better) best.set(entry.name, { name: entry.name, matchedFace: entry.face, distance, similarity, key: entry.key });
  }

  const ranked = [...best.values()].sort(
    (a, b) =>
      b.similarity - a.similarity ||
      a.distance - b.distance ||
      // The card's own name before a face of another card that reads the same.
      Number(a.matchedFace !== undefined) - Number(b.matchedFace !== undefined) ||
      Number(isReversible(a.name)) - Number(isReversible(b.name)) ||
      a.name.length - b.name.length ||
      (a.name < b.name ? -1 : 1),
  );
  const confidence = matchConfidence(ranked);
  const candidates = ranked.slice(0, limit).map(({ key: _key, ...candidate }) => candidate);
  return { candidates, confidence, reading };
}
