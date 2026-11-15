import { detailedListFormat, markdownFormat, plainListFormat } from '../../export/lists';
import type { ExportRow, ExtraColumn, LineStyle } from '../../export/types';
import type { CardRegions, GameAdapter } from '../adapter';
import type { Printing } from '../types';
import { matchMtgCollector, mtgPrintingPrior, parseMtgCollectorLine } from './collector';
import { archidektCsv, archidektDeckList, deckboxCsv, manaboxCsv, moxfieldCsv } from './exports';

const FINISHES = [
  { code: 'nonfoil', label: 'Nonfoil' },
  { code: 'foil', label: 'Foil' },
  { code: 'etched', label: 'Etched' },
];

const FINISH_MARKERS: Readonly<Record<string, string>> = { foil: ' *F*', etched: ' *E*' };

export function formatMtgExportLine(row: ExportRow, style: LineStyle): string {
  const plain = `${row.qty} ${row.exportName}`;
  if (style === 'plain' || !row.printing) return plain;
  const marker = FINISH_MARKERS[row.finish ?? ''] ?? '';
  return `${plain} (${row.printing.set.toUpperCase()}) ${row.printing.number}${marker}`;
}

const EXTRA_COLUMNS: readonly ExtraColumn[] = [
  { id: 'typeLine', label: 'Type', value: (printing) => String(printing.attrs?.typeLine ?? '') },
  {
    id: 'colorIdentity',
    label: 'Colors',
    value: (printing) => {
      const colors = printing.attrs?.colorIdentity;
      return Array.isArray(colors) ? colors.join('') : '';
    },
  },
  { id: 'manaValue', label: 'MV', value: (printing) => String(printing.attrs?.manaValue ?? '') },
];

/**
 * Calibrated on Scryfall's 488×680 scans (the size the index's images use) of
 * 1993, 1997, 2003 and 2015 frames, showcase, borderless and token cards. The
 * title band is tall on purpose: the line is searched for inside it.
 */
export const MTG_REGIONS: CardRegions = {
  size: { width: 488, height: 680 },
  // 19–23 px of 488 on 1993–2015 frames; the bottom border is about twice that.
  border: 0.042,
  // `wide` runs nearly the card's full width, a last try when the usual band reads poorly: an
  // outline a little off to one side (a dark border in a red deck box) clips the name's first
  // letter in it, but the wider band catches more of the frame, so it doesn't come first.
  title: {
    search: { x: 26, y: 12, width: 436, height: 88 },
    wide: { x: 10, y: 12, width: 468, height: 88 },
    lineHeight: 32,
    expectedCenterY: 53,
  },
  // Two lines (number, then set • language • artist) at the bottom left since 2014; the
  // 2003–2014 frames end the copyright line, at the same height, with the number. The band runs
  // to the card's bottom edge and a little higher than the lines sit, since an outline a few
  // pixels off moves them (round 8: the set line below the band, or the number line above it).
  collector: { search: { x: 16, y: 620, width: 300, height: 60 }, lineHeight: 9, maxLines: 2 },
  art: { x: 38, y: 76, width: 412, height: 302 },
  // Measured on the synthetic eval set: on a dark mat, detection stops at the frame line
  // (its bottom varies by frame, 610–660, so it's placed by aspect ratio); sleeves add ~2.8%.
  outlines: [
    { id: 'frame-line', box: { x: 24, y: 22, width: 440, height: 613 } },
    { id: 'sleeve', box: { x: -13.5, y: -13.5, width: 515, height: 707 } },
  ],
};

/** Nonfoil unless asked for foil; foil, then etched, when asked (or when there is no nonfoil). */
export function mtgDefaultFinish(printing: Pick<Printing, 'finishes'>, foil: boolean): string {
  const { finishes } = printing;
  if (!foil && finishes.includes('nonfoil')) return 'nonfoil';
  return finishes.find((finish) => finish === 'foil') ?? finishes.find((finish) => finish === 'etched') ?? finishes[0] ?? 'nonfoil';
}

/**
 * A set and its token set: Scryfall gives a set's tokens their own set, coded
 * "t" + the set's code (TTRK for Star Trek's TRK; all 193 such pairs in the
 * index are named "… Tokens"). They come in the set's packs, so a batch locked
 * to the set takes them too (round 9: Borg TTRK 20 went to review as outside
 * the lock).
 */
export function mtgLockedSets(codes: readonly string[]): string[] {
  const sets = new Set<string>();
  for (const code of codes) {
    sets.add(code);
    sets.add(`t${code}`);
  }
  return [...sets];
}

export const mtg: GameAdapter = {
  id: 'mtg',
  displayName: 'Magic: The Gathering',
  finishes: FINISHES,
  languages: [
    { code: 'en', label: 'English' },
    { code: 'es', label: 'Spanish' },
    { code: 'fr', label: 'French' },
    { code: 'de', label: 'German' },
    { code: 'it', label: 'Italian' },
    { code: 'pt', label: 'Portuguese' },
    { code: 'ja', label: 'Japanese' },
    { code: 'ko', label: 'Korean' },
    { code: 'ru', label: 'Russian' },
    { code: 'zhs', label: 'Chinese (Simplified)' },
    { code: 'zht', label: 'Chinese (Traditional)' },
  ],
  conditions: [
    { code: 'M', label: 'Mint' },
    { code: 'NM', label: 'Near Mint' },
    { code: 'LP', label: 'Lightly Played' },
    { code: 'MP', label: 'Moderately Played' },
    { code: 'HP', label: 'Heavily Played' },
    { code: 'D', label: 'Damaged' },
  ],
  defaultLang: 'en',
  defaultCondition: 'NM',
  extraColumns: EXTRA_COLUMNS,
  formatExportLine: formatMtgExportLine,
  regions: MTG_REGIONS,
  parseCollectorLine: parseMtgCollectorLine,
  matchCollector: matchMtgCollector,
  printingPrior: mtgPrintingPrior,
  defaultFinish: mtgDefaultFinish,
  isFoil: (finish) => finish === 'foil' || finish === 'etched',
  lockedSets: mtgLockedSets,
  exportFormats: [
    plainListFormat(formatMtgExportLine),
    detailedListFormat(formatMtgExportLine),
    markdownFormat({
      formatLine: formatMtgExportLine,
      finishLabel: (finish) => FINISHES.find((choice) => choice.code === finish)?.label ?? finish,
      extraColumns: EXTRA_COLUMNS,
    }),
    moxfieldCsv,
    manaboxCsv,
    deckboxCsv,
    archidektDeckList,
    archidektCsv,
  ],
};
