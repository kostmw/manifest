import { detailedListFormat, markdownFormat, plainListFormat } from '../../export/lists';
import type { ExportRow, ExtraColumn, LineStyle } from '../../export/types';
import type { GameAdapter } from '../adapter';
import { archidektCsv, deckboxCsv, manaboxCsv, moxfieldCsv } from './exports';

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
    archidektCsv,
  ],
};
