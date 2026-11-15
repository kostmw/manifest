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
  /** Best first, one per full name: at most `limit` read whole, plus up to two read only in part. */
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
/**
 * Letters glued to the front of a match cost this much each when there are two
 * or more and the whole word they belong to is a word of some card's name: a
 * short name matched inside such a word ("minion" inside "dominion", of
 * Dominion Saboteur) cuts a real word in two. Glued junk that makes no word
 * ("riforest") stays cheap, as does a single stray letter.
 */
const GLUED_COST = 1;
const GLUED_MIN = 2;
const isLetter = (c: string | undefined) => c !== undefined && c >= 'a' && c <= 'z';

/** How far ahead of the runner-up the best name must be for full confidence. */
const CLEAR_LEAD = 0.2;
/**
 * A long name read only as far as its first words, the rest garbled or
 * missing (round 9: "Doninio ir Q O:," for Dominion Saboteur under the
 * flashlight): its trailing words cost this much per letter, not a full edit,
 * and whatever the reading has where they would be is taken as their garbled
 * text. Above JUNK_COST so that, of names sharing the words read, the one
 * with the shortest tail ranks first.
 */
const CUT_COST = 0.6;
/**
 * Letters of the name that must have been read for it to count as cut short,
 * and how well (edits and junk per letter read): a few letters, or letters
 * read badly, start too many names. At 5 letters, "stand" (an Island misread)
 * put Stand Firm ahead of Island and cost the art-matched Island its title.
 */
const CUT_MIN = 7;
const CUT_READ_COST = 0.3;
/** A cut-short name is never sure by its title alone: at most this similar. */
const CUT_MAX = 0.75;
/**
 * Names read only in part are added to the candidates, at most this many, and
 * never push out a name read whole: that name's artwork may settle the card
 * (round 9's first try lost an art-matched Island to Stand Firm).
 */
const CUT_EXTRA = 2;

/**
 * Semi-global alignment: the whole name against any stretch of the reading.
 * Reading characters outside that stretch cost JUNK_COST each (spaces free);
 * inside it, ordinary edits cost 1 except spaces, which cost SPACE_COST.
 */
export function alignmentCost(name: string, reading: string, wordStarts?: Uint8Array): number {
  return align(name, reading, wordStarts, false).cost;
}

/** The name read only up to the end of one of its words: what that cost, and how many letters were left out. */
export interface CutAlignment {
  cost: number;
  missing: number;
}

/**
 * The alignment cost of the whole name, and with `cut`, of the best match of
 * its first words alone (at least CUT_MIN letters, at least one word left
 * out), with the reading's characters after it free up to as many as were
 * left out. The cut's own cost doesn't include CUT_COST for the missing letters.
 */
export function align(name: string, reading: string, wordStarts: Uint8Array | undefined, cut: boolean): { cost: number; cut: CutAlignment | null } {
  const n = name.length;
  const m = reading.length;
  // Non-space characters of the reading from each position on, for the junk after a cut.
  const after = new Int32Array(m + 1);
  for (let j = m - 1; j >= 0; j--) after[j] = after[j + 1]! + (reading[j] === ' ' ? 0 : 1);
  const totalLetters = cut ? name.replace(/ /g, '').length : 0;
  let lettersRead = 0;
  let bestCut: CutAlignment | null = null;
  let previous = new Float64Array(m + 1);
  let current = new Float64Array(m + 1);
  // Skipping a leading stretch of the reading is junk, except letters glued to the start of the
  // match within one word: those cut a word in two.
  let junk = 0;
  for (let j = 1; j <= m; j++) {
    junk += reading[j - 1] === ' ' ? 0 : JUNK_COST;
    let glued = 0;
    if (wordStarts?.[j] && isLetter(reading[j])) for (let k = j - 1; k >= 0 && isLetter(reading[k]); k--) glued += 1;
    previous[j] = junk + (glued >= GLUED_MIN ? (GLUED_COST - JUNK_COST) * glued : 0);
  }
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
    if (!cut) continue;
    if (a !== ' ') lettersRead += 1;
    // The end of a word, with more words after it: the name may have been read only this far.
    if (i < n && name[i] === ' ' && a !== ' ' && lettersRead >= CUT_MIN) {
      const missing = totalLetters - lettersRead;
      let cost = Number.POSITIVE_INFINITY;
      for (let j = 0; j <= m; j++) cost = Math.min(cost, previous[j]! + Math.max(0, after[j]! - missing) * JUNK_COST);
      const better = !bestCut || cost + CUT_COST * missing < bestCut.cost + CUT_COST * bestCut.missing;
      if (cost <= CUT_READ_COST * lettersRead && better) bestCut = { cost, missing };
    }
  }
  // Trailing junk after the end of the name.
  let best = Number.POSITIVE_INFINITY;
  let tail = 0;
  for (let j = m; j >= 0; j--) {
    best = Math.min(best, previous[j]! + tail);
    if (j > 0 && reading[j - 1] !== ' ') tail += JUNK_COST;
  }
  return { cost: best, cut: bestCut };
}

export function similarityFor(name: string, distance: number): number {
  return Math.max(0, 1 - distance / Math.max(name.replace(/ /g, '').length, 4));
}

interface Scored extends NameCandidate {
  /** The normalized text that matched: a candidate with the same key reads identically. */
  key: string;
  /** Matched as cut short: only its first words were read (see CUT_COST). */
  cut?: true;
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
  // A name read only in part is no rival to a name read whole: it would make a garbled but
  // right reading look less sure than junk, and the reading of the title is chosen by this.
  const rival = (candidate: Scored) => candidate.key !== first.key && !(candidate.cut && !first.cut);
  const second = candidates.find(rival)?.similarity ?? 0;
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

  // Positions inside a reading word that is itself a word of some card's name: a match starting
  // there cuts that word (see GLUED_COST).
  const inNameWord = new Uint8Array(reading.length + 1);
  for (const match of reading.matchAll(/[a-z]+/g)) {
    if (match[0].length > GLUED_MIN && index.hasWord(match[0])) inNameWord.fill(1, match.index + 1, match.index + match[0].length);
  }

  const best = new Map<string, Scored>();
  for (const entry of pool.values()) {
    // Names that are nearly all punctuation ("_____") normalize to nothing and would match any junk.
    if (entry.key.replace(/ /g, '').length < 2) continue;
    const aligned = align(entry.key, reading, inNameWord, true);
    let distance = aligned.cost;
    let similarity = similarityFor(entry.key, distance);
    let cut = false;
    if (aligned.cut) {
      const cutDistance = aligned.cut.cost + CUT_COST * aligned.cut.missing;
      const cutSimilarity = Math.min(CUT_MAX, similarityFor(entry.key, cutDistance));
      if (cutSimilarity > similarity) [distance, similarity, cut] = [cutDistance, cutSimilarity, true];
    }
    if (similarity <= 0) continue;
    const current = best.get(entry.name);
    const better =
      !current ||
      distance < current.distance ||
      (distance === current.distance && current.matchedFace !== undefined && entry.face === undefined);
    if (better) best.set(entry.name, { name: entry.name, matchedFace: entry.face, distance, similarity, key: entry.key, ...(cut ? { cut: true as const } : {}) });
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
  const whole = new Set(ranked.filter((candidate) => !candidate.cut).slice(0, limit));
  const cut = new Set(ranked.slice(0, limit).filter((candidate) => candidate.cut).slice(0, CUT_EXTRA));
  const candidates = ranked
    .filter((candidate) => whole.has(candidate) || cut.has(candidate))
    .map(({ key: _key, cut: _cut, ...candidate }) => candidate);
  return { candidates, confidence, reading };
}
