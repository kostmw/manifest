/**
 * MTG collector lines, as OCR reads them. Modern cards print two lines at the
 * bottom left:
 *
 *   083/261 C              (2014–2022: number / set size, rarity)
 *   R 0166                 (2023 on: rarity, zero-padded number)
 *   DMR • EN  ✒ Artist     (set code, • or ★ for foil, language, artist)
 *
 * 2003–2014 frames end the copyright line with "36/249" and print no set code;
 * older cards print nothing. OCR drops the spaces and mangles the separators,
 * so parsing looks for shapes, not exact text.
 */
import type { CollectorMatch, CollectorReading } from '../adapter';
import { collectorNumberCore } from '../collectorIndex';
import type { Printing } from '../types';

/** Printed language codes and Scryfall's. */
const LANGUAGES: Readonly<Record<string, string>> = {
  EN: 'en',
  DE: 'de',
  FR: 'fr',
  IT: 'it',
  ES: 'es',
  SP: 'es',
  PT: 'pt',
  JP: 'ja',
  JA: 'ja',
  KO: 'ko',
  KR: 'ko',
  RU: 'ru',
  CS: 'zhs',
  CT: 'zht',
  PH: 'ph',
};

/** Letters OCR gives for digits, in a place where only digits belong. */
const AS_DIGIT: Readonly<Record<string, string>> = { O: '0', Q: '0', D: '0', I: '1', L: '1', '|': '1', S: '5', B: '8', Z: '2', G: '6' };
const RARITIES = 'CURMSTLPB';

const digitsOf = (text: string) =>
  [...text].map((c) => (/\d/.test(c) ? c : AS_DIGIT[c] ?? '')).join('');
const isDigitLike = (text: string) => [...text].every((c) => /\d/.test(c) || c in AS_DIGIT);

function addUnique(list: string[], value: string | null | undefined): void {
  if (value && !list.includes(value)) list.push(value);
}

/**
 * The numbers on a line: "083/261" or "R0166". Returns the line with them
 * blanked out, so the set size is never mistaken for a number later.
 */
function readNumbers(line: string, reading: { numbers: string[]; total?: string; rarity?: string }): string {
  let rest = line;
  // number / set size, then perhaps the rarity.
  for (const match of line.matchAll(/([0-9OQDILSBZG]{1,4})\/([0-9OQDILSBZG]{2,4})([A-Z])?/g)) {
    if (!isDigitLike(match[1]!) || !isDigitLike(match[2]!) || !/\d/.test(match[1]! + match[2]!)) continue;
    addUnique(reading.numbers, collectorNumberCore(digitsOf(match[1]!)));
    reading.total ??= collectorNumberCore(digitsOf(match[2]!)) ?? undefined;
    if (match[3] && RARITIES.includes(match[3])) reading.rarity ??= match[3];
    rest = rest.replace(match[0], ' ');
  }
  // Rarity, then a zero-padded number.
  for (const match of line.matchAll(/(?:^|[^A-Z0-9])([CURMSTLPB])([0-9OQDILSBZG]{4})(?![0-9])/g)) {
    if (!/\d/.test(match[2]!)) continue;
    addUnique(reading.numbers, collectorNumberCore(digitsOf(match[2]!)));
    reading.rarity ??= match[1];
    rest = rest.replace(match[1]! + match[2]!, ' ');
  }
  return rest;
}

/** Plain runs of digits: a number whose rarity or slash was lost. Only used when nothing better was found. */
/** No set of the 2003–2014 frame era had more cards than this. */
const LARGEST_OLD_SET = 400;

function readLooseNumbers(line: string, reading: { numbers: string[] }): void {
  // 2003–2014 copyright lines end "…Coast LLC 24/81"; when the slash is lost, every way of
  // splitting the digits that gives a set of a plausible size, at least as big as the number,
  // is a candidate.
  const copyright = /(WIZARDS|COAST|LLC|INC)/.test(line) ? /([0-9][0-9OQDILSBZG]{2,6})[^0-9A-Z]*$/.exec(line) : null;
  if (copyright && isDigitLike(copyright[1]!)) {
    const digits = digitsOf(copyright[1]!);
    for (let cut = Math.min(4, digits.length - 1); cut >= 1; cut--) {
      const total = Number(digits.slice(cut));
      if (total >= Number(digits.slice(0, cut)) && total <= LARGEST_OLD_SET) addUnique(reading.numbers, collectorNumberCore(digits.slice(0, cut)));
    }
    return;
  }
  for (const match of line.matchAll(/(?:^|[^0-9])([0-9]{2,4})(?![0-9])/g)) addUnique(reading.numbers, collectorNumberCore(match[1]!));
}

/** Characters OCR gives for the • or ★ between set code and language. */
const isSeparator = (c: string) => /[^A-Z0-9]/.test(c) || 'EASW*'.includes(c);

/**
 * Set codes and the language from "DMR•EN": the language anchors where the
 * code ends. Returns the line with that part blanked out.
 */
function readSet(line: string, reading: { sets: string[]; lang?: string }): string {
  // The code starts the line (after a stray mark or two, such as The List's symbol), and the
  // artist's name runs straight on after the language, so only an early match counts. OCR
  // often reads the E of EN as &.
  for (const match of line.matchAll(/(EN|&N|DE|FR|IT|ES|SP|PT|JP|JA|KO|KR|RU|CS|CT|PH)/g)) {
    const end = match.index;
    if (end < 3) continue;
    if (end > 10) break;
    const before = line.slice(Math.max(0, end - 6), end);
    // The code is the three characters before the separator, which may be read as one or two
    // marks, a letter, or nothing at all. Real punctuation is the surest separator.
    const found: { code: string; rank: number }[] = [];
    for (let strip = 0; strip <= 2; strip++) {
      const separator = before.slice(before.length - strip);
      if (![...separator].every(isSeparator)) continue;
      const code = before.slice(0, before.length - strip).slice(-3);
      if (!/^[A-Z0-9]{3}$/.test(code)) continue;
      const punctuation = [...separator].filter((c) => /[^A-Z0-9]/.test(c)).length;
      found.push({ code, rank: strip === 0 ? 2 : punctuation === strip ? 0 : 1 });
    }
    if (found.length === 0) continue;
    found.sort((a, b) => a.rank - b.rank).forEach(({ code }) => addUnique(reading.sets, code));
    reading.lang ??= LANGUAGES[match[1] === '&N' ? 'EN' : match[1]!];
    return line.slice(0, Math.max(0, end - 5)) + ' '.repeat(Math.min(end, 5) + 2) + line.slice(end + 2);
  }
  return line;
}

export function parseMtgCollectorLine(lines: readonly string[]): CollectorReading | null {
  const reading: CollectorReading = { numbers: [], sets: [], text: lines.join(' / ') };
  const rests: string[] = [];
  for (const raw of lines) {
    const line = raw.toUpperCase().replace(/\s+/g, '');
    rests.push(readNumbers(readSet(line, reading), reading));
  }
  if (reading.numbers.length === 0) {
    rests.forEach((rest) => readLooseNumbers(rest, reading));
    if (reading.numbers.length > 0) reading.looseNumbers = true;
  }
  return reading.numbers.length || reading.sets.length ? reading : null;
}

/** OCR confusions between set-code characters, which mix letters and digits. */
const LOOKALIKE: readonly string[] = ['0OQD', '1IL', '5S', '8B', '2Z', '6G', 'UV', 'MN', 'CG', 'EF', 'HN'];
const lookalike = (a: string, b: string) => LOOKALIKE.some((group) => group.includes(a) && group.includes(b));

/** Edit distance between two set codes, where look-alike characters cost a third. */
export function setCodeDistance(read: string, actual: string): number {
  const a = read.toUpperCase();
  const b = actual.toUpperCase();
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const same = a[i - 1] === b[j - 1] ? 0 : lookalike(a[i - 1]!, b[j - 1]!) ? 0.34 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + same);
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * The set code printed on a printing. Promos, tokens and art cards use the
 * code of the set they belong to ("pltr" prints LTR); The List prints the
 * original card's set ("plst" "DOM-70" prints DOM 070).
 */
export function printedSetCodes(printing: Pick<Printing, 'set' | 'number'>): { exact: string[]; derived: string[] } {
  const list = /^([A-Z0-9]{2,5})-\d+/i.exec(printing.number);
  if (list) return { exact: [list[1]!.toUpperCase()], derived: [] };
  const derived = /^[pta][a-z0-9]{3}$/.test(printing.set) ? [printing.set.slice(1).toUpperCase()] : [];
  return { exact: [printing.set.toUpperCase()], derived };
}

/** How well a reading fits a printing. See CollectorMatch for what the score means. */
export function matchMtgCollector(reading: CollectorReading, printing: Pick<Printing, 'set' | 'number'>): CollectorMatch {
  const core = collectorNumberCore(printing.number);
  const number: CollectorMatch['number'] =
    reading.numbers.length === 0 || core === null ? 'unread' : reading.numbers.includes(core) ? 'exact' : 'conflict';

  let set: CollectorMatch['set'] = 'unread';
  if (reading.sets.length > 0) {
    const codes = printedSetCodes(printing);
    const distance = (list: string[]) => Math.min(Number.POSITIVE_INFINITY, ...list.flatMap((code) => reading.sets.map((read) => setCodeDistance(read, code))));
    const own = distance(codes.exact);
    // A promo or a List card printed with another set's code fits less well than that set's own printing.
    const best = Math.min(own, distance(codes.derived) + 0.5);
    set = best === 0 ? 'exact' : best <= 0.7 ? 'close' : 'conflict';
  }

  // A loose guess that misses says little; one that hits says less than a clean read.
  const numberScore: Record<CollectorMatch['number'], number> = reading.looseNumbers
    ? { exact: 0.5, conflict: -0.2, unread: 0 }
    : { exact: 1, conflict: -0.6, unread: 0 };
  const setScore: Record<CollectorMatch['set'], number> = { exact: 0.6, close: 0.35, conflict: -0.3, unread: 0 };
  return { number, set, score: numberScore[number] + setScore[set] };
}

/**
 * Promos and The List reprint a set's card with its art and collector line,
 * so nothing on the card tells them apart from the set's own printing. They
 * are much rarer in a collection, so when the evidence ties, the set's own
 * printing should come first.
 */
export function mtgPrintingPrior(printing: Pick<Printing, 'set' | 'number'>): number {
  if (printing.set === 'plst' || /^p[a-z0-9]{3}$/.test(printing.set)) return -0.1;
  return 0;
}
