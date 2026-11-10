import { detailedListFormat, markdownFormat, plainListFormat } from '../../export/lists';
import type { ExportRow, ExtraColumn, LineStyle } from '../../export/types';
import type { CardRegions, GameAdapter } from '../adapter';
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
  title: { search: { x: 26, y: 12, width: 436, height: 88 }, lineHeight: 32, expectedCenterY: 53 },
  collector: { x: 20, y: 626, width: 230, height: 40 },
  art: { x: 38, y: 76, width: 412, height: 302 },
};

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
