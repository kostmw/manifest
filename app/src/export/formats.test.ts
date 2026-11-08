import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mtg } from '../games/mtg/adapter';
import { deckboxEdition } from '../games/mtg/exports';
import type { Printing } from '../games/types';
import type { BatchItem } from '../session/types';
import { aggregate } from './aggregate';
import { toCsv } from './csv';
import type { ExportContext, ExportFormat, GroupBy } from './types';

const FIXTURES = 'tests/fixtures/formats';

/** A small RFC 4180 reader, kept here so tests don't depend on the writer they are checking. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') cell += char;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

function readTable(rows: string[][]): Record<string, string>[] {
  const [header, ...body] = rows;
  return body.map((row) => Object.fromEntries(header!.map((column, i) => [column, row[i] ?? ''])));
}

function fixture(file: string): Record<string, string>[] {
  return readTable(parseCsv(readFileSync(`${FIXTURES}/${file}`, 'utf8')));
}

function fixtureHeader(file: string): string[] {
  return parseCsv(readFileSync(`${FIXTURES}/${file}`, 'utf8'))[0]!;
}

function valuesIn(files: string[], column: string): Set<string> {
  return new Set(files.flatMap((file) => fixture(file).map((row) => row[column]!)));
}

const printing = (overrides: Partial<Printing> & { id: string; name: string }): Printing => ({
  set: 'cmm',
  setName: 'Commander Masters',
  number: '410',
  finishes: ['nonfoil', 'foil'],
  lang: 'en',
  attrs: { rarity: 'uncommon', typeLine: 'Artifact', colorIdentity: [], manaValue: 1, multiverseId: 627874 },
  ...overrides,
});

let nextId = 0;
const item = (p: Printing, overrides: Partial<BatchItem> = {}): BatchItem => ({
  id: `item-${nextId++}`,
  batchId: 'batch',
  printing: p,
  finish: 'nonfoil',
  lang: 'en',
  condition: 'NM',
  qty: 1,
  addedAt: '2026-05-15T13:51:43.373Z',
  mergeKey: '',
  ...overrides,
});

const SOL_RING = printing({ id: '1b59533a-3e38-495d-873e-2f89fbd08494', name: 'Sol Ring' });
const DELVER = printing({
  id: '11bf83bb-c95b-4b4f-9a56-ce7a1816307a',
  name: 'Delver of Secrets // Insectile Aberration',
  exportName: 'Delver of Secrets',
  set: 'isd',
  setName: 'Innistrad',
  number: '51',
  attrs: { rarity: 'common', typeLine: 'Creature — Human Wizard // Creature — Human Insect', colorIdentity: ['U'], manaValue: 1, multiverseId: 226749 },
});
const FIRE_ICE = printing({
  id: 'fire-ice',
  name: 'Fire // Ice',
  set: 'apc',
  setName: 'Apocalypse',
  number: '128',
  attrs: { rarity: 'uncommon', typeLine: 'Instant // Instant', colorIdentity: ['R', 'U'], manaValue: 4 },
});
const COMMA = printing({
  id: 'hogaak',
  name: 'Hogaak, Arisen Necropolis',
  set: 'mh1',
  setName: 'Modern Horizons',
  number: '202',
  attrs: { rarity: 'rare', typeLine: 'Legendary Creature — Avatar', colorIdentity: ['B', 'G'], manaValue: 7 },
});
const TUTOR = printing({
  id: 'tutor-etched',
  name: 'Demonic Tutor',
  number: '509',
  finishes: ['etched'],
  attrs: { rarity: 'mythic', typeLine: 'Sorcery', colorIdentity: ['B'], manaValue: 2, multiverseId: 626364 },
});
const TOKEN = printing({
  id: 'clue',
  name: 'Clue',
  set: 'tmh2',
  setName: 'Modern Horizons 2 Tokens',
  number: '14',
  attrs: { rarity: 'common', typeLine: 'Token Artifact — Clue', colorIdentity: [], manaValue: 0 },
});

const ITEMS: BatchItem[] = [
  item(SOL_RING, { qty: 2 }),
  item(SOL_RING, { finish: 'foil' }),
  item(SOL_RING, { condition: 'LP' }),
  item(DELVER, { lang: 'de', condition: 'MP' }),
  item(FIRE_ICE, { lang: 'ja' }),
  item(COMMA, { condition: 'HP' }),
  item(TUTOR, { finish: 'etched', condition: 'D', lang: 'zhs' }),
  item(TOKEN, { condition: 'M', lang: 'ko' }),
];

const context = (groupBy: GroupBy = 'printing', extraColumnIds: string[] = []): ExportContext => ({
  batchName: 'Box 3',
  location: 'Shelf | top',
  createdAt: '2026-05-15T10:00:00.000Z',
  generatedAt: '2026-05-16T10:00:00.000Z',
  groupBy,
  extraColumnIds,
});

function format(id: string): ExportFormat {
  const found = mtg.exportFormats.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`No format ${id}`);
  return found;
}

const render = (id: string, groupBy: GroupBy = 'printing', extras: string[] = [], items = ITEMS) =>
  format(id).render(aggregate(items, groupBy), context(groupBy, extras));

const table = (id: string, groupBy: GroupBy = 'printing') => readTable(parseCsv(render(id, groupBy)));

describe('aggregate', () => {
  it('merges identical printings and sums quantities', () => {
    const rows = aggregate([item(SOL_RING, { qty: 2 }), item(SOL_RING, { qty: 3 })], 'printing');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.qty).toBe(5);
  });

  it('keeps finishes, languages and conditions apart by printing', () => {
    expect(aggregate(ITEMS, 'printing').filter((row) => row.name === 'Sol Ring')).toHaveLength(3);
  });

  it('merges everything with one name when grouped by name, and drops printing details', () => {
    const rows = aggregate(ITEMS, 'name').filter((row) => row.name === 'Sol Ring');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ qty: 4, printing: null, finish: null, lang: null, condition: null });
  });

  it('sorts the same way whatever the scan order', () => {
    const forward = aggregate(ITEMS, 'printing');
    const backward = aggregate([...ITEMS].reverse(), 'printing');
    expect(backward).toEqual(forward);
    expect(forward.map((row) => row.name)[0]).toBe('Clue');
  });

  it('sorts collector numbers numerically', () => {
    const rows = aggregate(
      [item({ ...SOL_RING, id: 'a', number: '100' }), item({ ...SOL_RING, id: 'b', number: '20' })],
      'printing',
    );
    expect(rows.map((row) => row.printing?.number)).toEqual(['20', '100']);
  });

  it('keeps the earliest added time', () => {
    const [row] = aggregate(
      [item(SOL_RING, { addedAt: '2026-02-01T00:00:00.000Z' }), item(SOL_RING, { addedAt: '2026-01-01T00:00:00.000Z' })],
      'printing',
    );
    expect(row?.addedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('toCsv', () => {
  it('quotes only cells that need it', () => {
    expect(toCsv(['a', 'b'], [['Hogaak, Arisen', 'say "hi"'], ['plain', 1]])).toBe(
      'a,b\n"Hogaak, Arisen","say ""hi"""\nplain,1\n',
    );
  });

  it('can quote every cell, as Moxfield does', () => {
    expect(toCsv(['a'], [[1]], true)).toBe('"a"\n"1"\n');
  });

  it('round-trips awkward values', () => {
    const awkward = ['with, comma', 'with "quotes"', 'line\nbreak', 'Lim-Dûl’s'];
    expect(parseCsv(toCsv(['a', 'b', 'c', 'd'], [awkward]))[1]).toEqual(awkward);
  });
});

describe('plain list', () => {
  it('uses front faces, keeps split cards whole and merges each card into one line', () => {
    expect(render('plain')).toMatchSnapshot();
    expect(render('plain')).toContain('4 Sol Ring\n');
    expect(render('plain')).toContain('1 Delver of Secrets\n');
    expect(render('plain')).toContain('1 Fire // Ice\n');
    expect(render('plain')).not.toContain('Insectile');
  });
});

describe('detailed list', () => {
  it('matches the spec example', () => {
    expect(render('detailed', 'printing', [], [item(SOL_RING)])).toBe('1 Sol Ring (CMM) 410\n');
  });

  it('marks foil and etched as real Moxfield exports do', () => {
    const output = render('detailed');
    expect(output).toContain('1 Sol Ring (CMM) 410 *F*\n');
    expect(output).toContain('1 Demonic Tutor (CMM) 509 *E*\n');
    expect(output).toMatchSnapshot();
  });

  it('merges rows that only differ in condition or language', () => {
    expect(render('detailed')).toContain('3 Sol Ring (CMM) 410\n');
  });

  it('has only names and counts when grouped by name', () => {
    expect(render('detailed', 'name')).toContain('4 Sol Ring\n');
    expect(render('detailed', 'name')).not.toContain('(CMM)');
  });
});

describe('markdown for AI', () => {
  it('has title, metadata, totals, table and a fenced plain list', () => {
    const output = render('markdown');
    expect(output).toMatchSnapshot();
    expect(output).toMatch(/^# Box 3\n/);
    expect(output).toContain('- Cards: 9\n');
    expect(output).toContain('- Unique: 6\n');
    expect(output).toContain('| Qty | Name | Set | # | Finish | Lang |\n|---|---|---|---|---|---|\n');
    expect(output).toContain('```text\n1 Clue\n');
  });

  it('merges rows that differ only in condition, which the table does not show', () => {
    const output = render('markdown');
    expect(output).toContain('| 3 | Sol Ring | CMM | 410 | Nonfoil | en |\n');
    expect(output).toContain('| 1 | Sol Ring | CMM | 410 | Foil | en |\n');
    expect(output.match(/Sol Ring \| CMM \| 410 \| Nonfoil/g)).toHaveLength(1);
  });

  it('adds the optional columns only when asked', () => {
    expect(render('markdown')).not.toContain('| Type |');
    const output = render('markdown', 'printing', ['typeLine', 'colorIdentity', 'manaValue']);
    expect(output).toContain('| Qty | Name | Set | # | Finish | Lang | Type | Colors | MV |');
    expect(output).toContain('| 1 | Fire // Ice | APC | 128 | Nonfoil | ja | Instant // Instant | RU | 4 |');
  });

  it('keeps optional columns when grouped by name', () => {
    const output = render('markdown', 'name', ['manaValue']);
    expect(output).toContain('| 4 | Sol Ring |  |  |  |  | 1 |');
  });

  it('escapes characters that would break the table', () => {
    const piped = printing({ id: 'p', name: 'Weird | Name' });
    expect(render('markdown', 'printing', [], [item(piped)])).toContain('| 1 | Weird \\| Name |');
  });

  it("can't be broken by a line break in the batch name", () => {
    const output = format('markdown').render(aggregate([item(SOL_RING)], 'printing'), {
      ...context(),
      batchName: 'Box\n# Injected',
    });
    expect(output.split('\n')[0]).toBe('# Box # Injected');
  });
});

describe.each([
  { id: 'moxfield', sample: 'moxfield-real-export.csv' },
  { id: 'deckbox', sample: 'deckbox-reference.csv', baseColumns: 19 },
  { id: 'archidekt', sample: 'archidekt-real-export.csv' },
  { id: 'manabox', sample: 'manabox-2026-export.csv' },
])('$id CSV shape', ({ id, sample, baseColumns }) => {
  it('uses the exact columns of a real export, in order', () => {
    const header = parseCsv(render(id))[0];
    expect(header).toEqual(fixtureHeader(sample).slice(0, baseColumns));
  });

  it('gives every row the same number of columns', () => {
    const [header, ...body] = parseCsv(render(id));
    for (const row of body) expect(row).toHaveLength(header!.length);
  });

  it('survives a parse with commas intact', () => {
    expect(table(id).some((row) => Object.values(row).includes('Hogaak, Arisen Necropolis'))).toBe(true);
  });

  it('matches its snapshot', () => {
    expect(render(id)).toMatchSnapshot();
  });

  it('keeps the card in the file when grouped by name', () => {
    expect(render(id, 'name')).toContain('Sol Ring');
    expect(render(id, 'name')).toMatchSnapshot();
  });
});

describe('name grouping', () => {
  it("leaves ManaBox's rarity empty, because rarity varies by printing", () => {
    expect(table('manabox', 'name').find((row) => row.Name === 'Sol Ring')?.Rarity).toBe('');
  });
});

describe('values match what each site really writes', () => {
  const inSample = (id: string, column: string, files: string[]) => {
    const allowed = valuesIn(files, column);
    for (const row of table(id)) expect(allowed, `${id} ${column}: ${row[column]}`).toContain(row[column]);
  };

  it('Moxfield', () => {
    const files = ['moxfield-real-export.csv', 'moxfield-conditions-real-export.csv', 'moxfield-reference.csv'];
    inSample('moxfield', 'Condition', files);
    inSample('moxfield', 'Language', files);
    inSample('moxfield', 'Foil', files);
    inSample('moxfield', 'Alter', ['moxfield-real-export.csv']);
    inSample('moxfield', 'Proxy', ['moxfield-real-export.csv']);
  });

  it('ManaBox', () => {
    const files = ['manabox-real-export.csv', 'manabox-reference.csv'];
    inSample('manabox', 'Condition', files);
    inSample('manabox', 'Language', files);
    inSample('manabox', 'Foil', files);
    inSample('manabox', 'Misprint', ['manabox-2026-export.csv']);
    inSample('manabox', 'Altered', ['manabox-2026-export.csv']);
    inSample('manabox', 'Signed', ['manabox-2026-export.csv']);
    inSample('manabox', 'Proxy', ['manabox-2026-export.csv']);
  });

  it('Deckbox, which has no etched finish', () => {
    const files = ['deckbox-real-export.csv', 'deckbox-reference.csv'];
    inSample('deckbox', 'Condition', files);
    inSample('deckbox', 'Language', files);
    inSample('deckbox', 'Foil', files);
    expect(table('deckbox').find((row) => row.Name === 'Demonic Tutor')?.Foil).toBe('foil');
  });

  it('Archidekt', () => {
    const files = ['archidekt-real-export.csv', 'archidekt-reference.csv'];
    inSample('archidekt', 'Condition', files);
    inSample('archidekt', 'Language', files);
    inSample('archidekt', 'Finish', files);
  });

  it('covers every language and condition the app offers, in every format', () => {
    for (const { code: lang } of mtg.languages) {
      for (const { code: condition } of mtg.conditions) {
        const items = [item(SOL_RING, { lang, condition })];
        const check = (id: string, column: string, files: string[]) => {
          const [row] = readTable(parseCsv(render(id, 'printing', [], items)));
          expect(valuesIn(files, column), `${id} ${column} for ${lang}/${condition}`).toContain(row![column]);
        };
        const mox = ['moxfield-real-export.csv', 'moxfield-conditions-real-export.csv', 'moxfield-reference.csv'];
        check('moxfield', 'Condition', mox);
        check('moxfield', 'Language', mox);
        const box = ['deckbox-real-export.csv', 'deckbox-reference.csv'];
        check('deckbox', 'Condition', box);
        check('deckbox', 'Language', box);
        const mana = ['manabox-real-export.csv', 'manabox-reference.csv'];
        check('manabox', 'Condition', mana);
        check('manabox', 'Language', mana);
        const arch = ['archidekt-real-export.csv', 'archidekt-reference.csv'];
        check('archidekt', 'Condition', arch);
        check('archidekt', 'Language', arch);
      }
    }
  });
});

describe('real rows', () => {
  it('writes the same identifying cells as a real Moxfield row for the same card', () => {
    const real = fixture('moxfield-real-export.csv').find((row) => row.Name === 'Brazen Borrower // Petty Theft')!;
    const card = printing({ id: 'x', name: real.Name!, set: real.Edition!, number: real['Collector Number']! });
    const [mine] = readTable(parseCsv(render('moxfield', 'printing', [], [item(card)])));
    for (const column of ['Count', 'Name', 'Edition', 'Condition', 'Language', 'Foil', 'Collector Number', 'Alter', 'Proxy']) {
      expect(mine![column], column).toBe(real[column]);
    }
  });

  it('writes the same identifying cells as a real ManaBox row for the same card', () => {
    const real = fixture('manabox-real-export.csv').find((row) => row.Name === 'Brazen Borrower // Petty Theft')!;
    const card = printing({
      id: real['Scryfall ID']!,
      name: real.Name!,
      set: real['Set code']!.toLowerCase(),
      setName: real['Set name']!,
      number: real['Collector number']!,
      attrs: { rarity: real.Rarity! },
    });
    const [mine] = readTable(parseCsv(render('manabox', 'printing', [], [item(card)])));
    for (const column of ['Name', 'Set code', 'Set name', 'Collector number', 'Foil', 'Rarity', 'Quantity', 'Scryfall ID', 'Condition', 'Language']) {
      expect(mine![column], column).toBe(real[column]);
    }
  });

  it('writes the same identifying cells as a real Archidekt row for the same card', () => {
    const real = fixture('archidekt-real-export.csv').find((row) => row.Name === 'Brazen Borrower // Petty Theft')!;
    const card = printing({
      id: real['Scryfall ID']!,
      name: real.Name!,
      set: real['Edition Code']!,
      setName: real['Edition Name']!,
      number: real['Collector Number']!,
      attrs: { multiverseId: Number(real['Multiverse Id']) },
    });
    const [mine] = readTable(parseCsv(render('archidekt', 'printing', [], [item(card, { addedAt: `${real['Date Added']}T00:00:00.000Z` })])));
    for (const column of ['Quantity', 'Name', 'Finish', 'Condition', 'Date Added', 'Language', 'Edition Name', 'Edition Code', 'Multiverse Id', 'Scryfall ID', 'Collector Number']) {
      expect(mine![column], column).toBe(real[column]);
    }
  });

  it('writes the same identifying cells as a real Deckbox row for the same card', () => {
    const real = fixture('deckbox-real-export.csv').find((row) => row.Name === 'Brazen Borrower // Petty Theft')!;
    const card = printing({ id: 'x', name: real.Name!, set: real['Edition Code']!, setName: real.Edition!, number: real['Card Number']! });
    const [mine] = readTable(parseCsv(render('deckbox', 'printing', [], [item(card)])));
    for (const column of ['Count', 'Tradelist Count', 'Name', 'Edition', 'Edition Code', 'Card Number', 'Condition', 'Language', 'Foil']) {
      expect(mine![column], column).toBe(real[column]);
    }
  });

  it('uses Multiverse Id 0 when a printing has none, as Archidekt does', () => {
    expect(table('archidekt').find((row) => row.Name === 'Clue')?.['Multiverse Id']).toBe('0');
    expect(fixture('archidekt-real-export.csv').find((row) => row.Name === 'Clue')?.['Multiverse Id']).toBe('0');
  });
});

describe('deckboxEdition', () => {
  it.each([
    ['Secret Lair Drop', 'Secret Lair Drop Series'],
    ['Ultimate Box Topper', 'Ultimate Masters: Box Toppers'],
    ['Modern Horizons 2 Tokens', 'Extras: Modern Horizons 2'],
    ['Commander Masters', 'Commander Masters'],
  ])('%s becomes %s', (scryfall, deckbox) => {
    expect(deckboxEdition(scryfall)).toBe(deckbox);
  });
});

describe('every format', () => {
  it.each(mtg.exportFormats.map((candidate) => candidate.id))('%s handles an empty batch', (id) => {
    expect(() => render(id, 'printing', [], [])).not.toThrow();
  });

  it('offers all the formats the project promises', () => {
    expect(mtg.exportFormats.map((candidate) => candidate.id)).toEqual([
      'plain',
      'detailed',
      'markdown',
      'moxfield',
      'manabox',
      'deckbox',
      'archidekt',
    ]);
  });
});

describe('a language no site lists', () => {
  it('falls back to English rather than writing a value the site would reject', () => {
    const phyrexian = printing({ id: 'ph', name: 'Blighted Agent', lang: 'ph' });
    const items = [item(phyrexian, { lang: 'ph' })];
    const read = (id: string) => readTable(parseCsv(render(id, 'printing', [], items)))[0]!;
    expect(read('moxfield').Language).toBe('English');
    expect(read('manabox').Language).toBe('en');
    expect(read('deckbox').Language).toBe('English');
    expect(read('archidekt').Language).toBe('EN');
  });
});
