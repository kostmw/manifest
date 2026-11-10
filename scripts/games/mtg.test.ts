import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { printingShardFile, printingShardIndex } from '../../app/src/games/shard';
import type { Printing } from '../../app/src/games/types';
import { writeGameIndex, writeManifest } from '../writeIndex';
import { buildNameDictionary, mtgIndexBuilder, readJsonLines, toPrinting, type ScryfallCard } from './mtg';

const SAMPLE = 'tests/fixtures/scryfall-sample.jsonl';
let cards: ScryfallCard[] = [];

const card = (name: string, set?: string): ScryfallCard => {
  const found = cards.find((c) => c.name === name && (!set || c.set === set));
  if (!found) throw new Error(`Fixture is missing ${name}`);
  return found;
};

beforeAll(async () => {
  for await (const line of readJsonLines<ScryfallCard>(createReadStream(SAMPLE))) cards.push(line);
});

describe('toPrinting', () => {
  it('keeps the fields that exports and search need', () => {
    expect(toPrinting(card('Sol Ring'))).toMatchObject({
      name: 'Sol Ring',
      set: 'cmm',
      setName: 'Commander Masters',
      number: '410',
      finishes: ['nonfoil', 'foil'],
      lang: 'en',
      attrs: { rarity: 'uncommon', typeLine: 'Artifact', manaValue: 1, colorIdentity: [] },
    });
  });

  it('leaves out digital-only cards, which cannot be scanned', () => {
    expect(card('Bronze Horse').digital).toBe(true);
    expect(toPrinting(card('Bronze Horse'))).toBeNull();
  });

  it.each([
    ['Delver of Secrets // Insectile Aberration', 'Delver of Secrets'], // transform
    ['Skyclave Cleric // Skyclave Basilica', 'Skyclave Cleric'], // modal DFC
    ['Brazen Borrower // Petty Theft', 'Brazen Borrower'], // adventure
    ["Erayo, Soratami Ascendant // Erayo's Essence", 'Erayo, Soratami Ascendant'], // flip
    ["Jinnie Fay, Jetmir's Second // Jinnie Fay, Jetmir's Second", "Jinnie Fay, Jetmir's Second"], // reversible
  ])('exports %s under its front face', (name, exportName) => {
    expect(toPrinting(card(name))?.exportName).toBe(exportName);
    expect(toPrinting(card(name))?.name).toBe(name);
  });

  it('keeps both halves of a split card', () => {
    expect(toPrinting(card('Fire // Ice'))?.exportName).toBeUndefined();
  });

  it('takes image and type from the front face when the card has none of its own', () => {
    const delver = card('Delver of Secrets // Insectile Aberration');
    expect(delver.image_uris).toBeUndefined();
    expect(toPrinting(delver)?.image).toContain('/normal/front/');

    const reversible = card("Jinnie Fay, Jetmir's Second // Jinnie Fay, Jetmir's Second");
    expect(toPrinting(reversible)?.attrs?.typeLine).toBeTruthy();
  });

  it('records the language of cards with no English printing', () => {
    expect(toPrinting(card('Fire Elemental'))?.lang).toBe('es');
    expect(toPrinting(card('Blighted Agent'))?.lang).toBe('ph');
  });
});

describe('buildNameDictionary', () => {
  it('lists each name once, sorted', () => {
    const { names } = buildNameDictionary(cards);
    expect(names.filter((name) => name === 'Plains')).toHaveLength(1);
    expect(names).toEqual([...names].sort());
  });

  it('maps every face to its full name', () => {
    const { faces } = buildNameDictionary(cards);
    expect(faces['Insectile Aberration']).toEqual(['Delver of Secrets // Insectile Aberration']);
    expect(faces['Delver of Secrets']).toEqual(['Delver of Secrets // Insectile Aberration']);
    expect(faces['Ice']).toEqual(['Fire // Ice']);
  });

  it('maps printed alternate names to the card they stand for', () => {
    const solitude: ScryfallCard = { ...card('Sol Ring'), name: 'Solitude', flavor_name: 'Yojimbo' };
    const dracula: ScryfallCard = {
      ...card('Sol Ring'),
      name: 'Voldaren Bloodcaster // Bloodbat Summoner',
      card_faces: [
        { name: 'Voldaren Bloodcaster', flavor_name: 'Dracula, Lord of Blood' },
        { name: 'Bloodbat Summoner', flavor_name: 'Dracula, Lord of Bats' },
      ],
    };
    const simon: ScryfallCard = { ...card('Sol Ring'), name: 'Mathise, Surge Channeler', printed_name: 'Simon, Wild Magic Sorcerer' };
    const { aliases, names } = buildNameDictionary([solitude, dracula, simon]);
    expect(aliases?.['Yojimbo']).toEqual(['Solitude']);
    expect(aliases?.['Simon, Wild Magic Sorcerer']).toEqual(['Mathise, Surge Channeler']);
    expect(aliases?.['Dracula, Lord of Bats']).toEqual(['Voldaren Bloodcaster // Bloodbat Summoner']);
    expect(names).not.toContain('Yojimbo');
  });

  it('keeps every full name when two cards share a face', () => {
    const shared = (name: string): ScryfallCard => ({
      ...card('Sol Ring'),
      name,
      card_faces: name.split(' // ').map((face) => ({ name: face })),
    });
    const { faces } = buildNameDictionary([shared('Zombie // Treasure'), shared('Zombie // Food')]);
    expect(faces['Zombie']).toEqual(['Zombie // Food', 'Zombie // Treasure']);
  });
});

describe('build from the Scryfall sample', () => {
  let outDir = '';
  afterEach(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true });
  });

  async function build(dir: string) {
    const data = await mtgIndexBuilder.buildIndex({ sourceFile: SAMPLE, cacheDir: dir });
    return { data, index: await writeGameIndex('mtg', data, mtgIndexBuilder.shardCount, dir) };
  }

  it('puts every printing in the shard the app will look in', async () => {
    outDir = await mkdtemp(join(tmpdir(), 'manifest-index-'));
    const { data, index } = await build(outDir);

    expect(index.counts.printings).toBe(cards.length - 1); // The digital card is gone.
    expect(index.shards).toHaveLength(mtgIndexBuilder.shardCount);
    for (const printing of data.printings) {
      const file = printingShardFile('mtg', printingShardIndex(printing.name, mtgIndexBuilder.shardCount));
      const shard = JSON.parse(await readFile(join(outDir, file), 'utf8')) as Printing[];
      expect(shard.map((entry) => entry.id)).toContain(printing.id);
    }
  });

  it('reports the true size of each file', async () => {
    outDir = await mkdtemp(join(tmpdir(), 'manifest-index-'));
    const { index } = await build(outDir);
    for (const file of [index.names, ...index.shards]) {
      expect((await stat(join(outDir, file.file))).size).toBe(file.bytes);
    }
  });

  it('is deterministic, so unchanged shards are not downloaded again', async () => {
    outDir = await mkdtemp(join(tmpdir(), 'manifest-index-'));
    const first = await build(outDir);
    const second = await build(outDir);
    expect(second.index.shards).toEqual(first.index.shards);
    expect(second.index.names).toEqual(first.index.names);
  });

  it('refuses to write a file over the hosting limit', async () => {
    outDir = await mkdtemp(join(tmpdir(), 'manifest-index-'));
    const printing = toPrinting(card('Sol Ring'))!;
    const huge = { ...printing, setName: 'x'.repeat(21 * 1024 * 1024) };
    await expect(
      writeGameIndex('mtg', { source: { name: 't', updatedAt: 't' }, printings: [huge], names: { names: [], faces: {} } }, 1, outDir),
    ).rejects.toThrow(/over the .* byte limit/);
  });

  it('writes a manifest with the build date and shard list, keeping other games', async () => {
    outDir = await mkdtemp(join(tmpdir(), 'manifest-index-'));
    const { index } = await build(outDir);
    await writeManifest(outDir, { mtg: index }, '2026-01-01T00:00:00.000Z');
    const manifest = await writeManifest(outDir, {}, '2026-01-02T00:00:00.000Z');
    expect(manifest.buildDate).toBe('2026-01-02T00:00:00.000Z');
    expect(manifest.games.mtg?.shards).toHaveLength(mtgIndexBuilder.shardCount);
  });
});
