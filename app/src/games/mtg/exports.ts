import { toCsv } from '../../export/csv';
import type { ExportFormat, ExportRow } from '../../export/types';

/**
 * Column names and value spellings below come from real exports, kept in
 * tests/fixtures/formats and checked by exports.test.ts. Don't change them
 * from memory: find a new sample first.
 */

const CSV = { extension: 'csv', mimeType: 'text/csv', supportsGrouping: true, supportsExtraColumns: false } as const;
const NAME_GROUP_NOTE = 'Grouping by name leaves set and number empty, so the site picks a printing.';

type Vocabulary = Readonly<Record<string, string>>;

const FULL_LANGUAGE_NAMES: Vocabulary = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
  ru: 'Russian',
  zhs: 'Chinese',
  zht: 'Traditional Chinese',
};

const MANABOX_LANGUAGES: Vocabulary = {
  en: 'en',
  es: 'es',
  fr: 'fr',
  de: 'de',
  it: 'it',
  pt: 'pt',
  ja: 'ja',
  ko: 'ko',
  ru: 'ru',
  zhs: 'zh_CN',
  zht: 'zh_TW',
};

const ARCHIDEKT_LANGUAGES: Vocabulary = {
  en: 'EN',
  es: 'ES',
  fr: 'FR',
  de: 'DE',
  it: 'IT',
  pt: 'PT',
  ja: 'JP',
  ko: 'KR',
  ru: 'RU',
  zhs: 'CS',
  zht: 'CT',
};

const MOXFIELD_CONDITIONS: Vocabulary = {
  M: 'Mint',
  NM: 'Near Mint',
  LP: 'Good (Lightly Played)',
  MP: 'Played',
  HP: 'Heavily Played',
  D: 'Damaged',
};

// Same ladder as Moxfield apart from the bottom grade, which Deckbox calls Poor.
const DECKBOX_CONDITIONS: Vocabulary = { ...MOXFIELD_CONDITIONS, D: 'Poor' };

// ManaBox's words sit one step lower than their English meaning suggests, per real round-trips with Moxfield.
const MANABOX_CONDITIONS: Vocabulary = {
  M: 'mint',
  NM: 'near_mint',
  LP: 'good',
  MP: 'light_played',
  HP: 'played',
  D: 'poor',
};

// Archidekt has no Mint grade.
const ARCHIDEKT_CONDITIONS: Vocabulary = { M: 'NM', NM: 'NM', LP: 'LP', MP: 'MP', HP: 'HP', D: 'D' };

/** Rows grouped by name, and the rare languages a site doesn't list, use its English or Near Mint spelling. */
function lookup(vocabulary: Vocabulary, code: string | null, fallback: string): string {
  return vocabulary[code ?? fallback] ?? vocabulary[fallback]!;
}

function language(row: ExportRow, vocabulary: Vocabulary): string {
  return lookup(vocabulary, row.lang, 'en');
}

function condition(row: ExportRow, vocabulary: Vocabulary): string {
  return lookup(vocabulary, row.condition, 'NM');
}

export const moxfieldCsv: ExportFormat = {
  ...CSV,
  id: 'moxfield',
  label: 'Moxfield collection CSV',
  note: NAME_GROUP_NOTE,
  render: (rows) =>
    toCsv(
      [
        'Count',
        'Tradelist Count',
        'Name',
        'Edition',
        'Condition',
        'Language',
        'Foil',
        'Tags',
        'Last Modified',
        'Collector Number',
        'Alter',
        'Proxy',
        'Purchase Price',
      ],
      rows.map((row) => [
        row.qty,
        0, // Scanning a card says nothing about wanting to trade it.
        row.name,
        row.printing?.set ?? '',
        condition(row, MOXFIELD_CONDITIONS),
        language(row, FULL_LANGUAGE_NAMES),
        row.finish === 'foil' || row.finish === 'etched' ? row.finish : '',
        '',
        '', // Moxfield sets this itself on import.
        row.printing?.number ?? '',
        'False',
        'False',
        '',
      ]),
      true,
    ),
};

export const manaboxCsv: ExportFormat = {
  ...CSV,
  id: 'manabox',
  label: 'ManaBox CSV',
  note: `ManaBox fills in its own ID and prices on import. ${NAME_GROUP_NOTE}`,
  render: (rows) =>
    toCsv(
      [
        'Name',
        'Set code',
        'Set name',
        'Collector number',
        'Foil',
        'Rarity',
        'Quantity',
        'ManaBox ID',
        'Scryfall ID',
        'Purchase price',
        'Misprint',
        'Altered',
        'Signed',
        'Condition',
        'Language',
        'Proxy',
        'Purchase price currency',
        'Added',
      ],
      rows.map((row) => [
        row.name,
        row.printing?.set.toUpperCase() ?? '',
        row.printing?.setName ?? '',
        row.printing?.number ?? '',
        row.finish === 'foil' || row.finish === 'etched' ? row.finish : 'normal',
        // Rarity varies by printing, so it's only known when a row is one printing.
        String(row.printing?.attrs?.rarity ?? ''),
        row.qty,
        '',
        row.printing?.id ?? '',
        '',
        'false',
        'false',
        'false',
        condition(row, MANABOX_CONDITIONS),
        language(row, MANABOX_LANGUAGES),
        'false',
        '',
        row.addedAt,
      ]),
    ),
};

/** Deckbox's native importer rejects Scryfall's spelling of these set names. */
export function deckboxEdition(setName: string): string {
  if (setName === 'Secret Lair Drop') return 'Secret Lair Drop Series';
  if (setName === 'Ultimate Box Topper') return 'Ultimate Masters: Box Toppers';
  if (setName.endsWith(' Tokens')) return `Extras: ${setName.slice(0, -' Tokens'.length)}`;
  return setName;
}

export const deckboxCsv: ExportFormat = {
  ...CSV,
  id: 'deckbox',
  label: 'Deckbox CSV',
  note: `Deckbox has no etched finish, so etched cards export as foil. Its importer is strict about set names, so check any rows it flags, tokens especially. ${NAME_GROUP_NOTE}`,
  render: (rows) =>
    toCsv(
      [
        'Count',
        'Tradelist Count',
        'Name',
        'Edition',
        'Edition Code',
        'Card Number',
        'Condition',
        'Language',
        'Foil',
        'Signed',
        'Artist Proof',
        'Altered Art',
        'Misprint',
        'Promo',
        'Textless',
        'Printing Id',
        'Printing Note',
        'Tags',
        'My Price',
      ],
      rows.map((row) => [
        row.qty,
        0,
        row.name,
        row.printing ? deckboxEdition(row.printing.setName) : '',
        row.printing?.set ?? '',
        row.printing?.number ?? '',
        condition(row, DECKBOX_CONDITIONS),
        language(row, FULL_LANGUAGE_NAMES),
        row.finish === 'foil' || row.finish === 'etched' ? 'foil' : '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
      ]),
    ),
};

export const archidektCsv: ExportFormat = {
  ...CSV,
  id: 'archidekt',
  label: 'Archidekt CSV',
  note: `Matches Archidekt's own export, but its importer has no preset for this layout. Either match the columns by hand when importing, or use the Moxfield or ManaBox file with Archidekt's preset for that site. ${NAME_GROUP_NOTE}`,
  render: (rows) =>
    toCsv(
      [
        'Quantity',
        'Name',
        'Finish',
        'Condition',
        'Date Added',
        'Language',
        'Purchase Price',
        'Tags',
        'Edition Name',
        'Edition Code',
        'Multiverse Id',
        'Scryfall ID',
        'Collector Number',
      ],
      rows.map((row) => [
        row.qty,
        row.name,
        row.finish === 'foil' ? 'Foil' : row.finish === 'etched' ? 'Etched' : 'Normal',
        condition(row, ARCHIDEKT_CONDITIONS),
        row.addedAt.slice(0, 10),
        language(row, ARCHIDEKT_LANGUAGES),
        '',
        '',
        row.printing?.setName ?? '',
        row.printing?.set ?? '',
        row.printing ? String(row.printing.attrs?.multiverseId ?? 0) : '',
        row.printing?.id ?? '',
        row.printing?.number ?? '',
      ]),
    ),
};
