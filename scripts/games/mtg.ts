import { createReadStream, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable as ReadableType } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { NameDictionary, Printing } from '../../app/src/games/types';
import { downloadToFile, fetchJson } from '../download';
import type { BuildOptions, BuiltGameData, GameIndexBuilder } from './types';

const SCRYFALL_HEADERS = {
  'User-Agent': 'ManifestIndexBuilder/0.1 (+https://github.com/kostmw/manifest)',
  Accept: 'application/json;q=0.9,*/*;q=0.8',
};
const BULK_TYPE = 'default_cards';

export interface ScryfallFace {
  name: string;
  /** Printed in place of the name on some crossover cards. */
  flavor_name?: string;
  /** The name as printed, when it differs: another language, or a renamed reprint. */
  printed_name?: string;
  type_line?: string;
  cmc?: number;
  image_uris?: { normal?: string };
}

export interface ScryfallCard {
  id: string;
  name: string;
  set: string;
  set_name: string;
  collector_number: string;
  finishes: string[];
  lang: string;
  layout: string;
  digital?: boolean;
  flavor_name?: string;
  printed_name?: string;
  rarity?: string;
  type_line?: string;
  color_identity?: string[];
  cmc?: number;
  multiverse_ids?: number[];
  released_at?: string;
  image_uris?: { normal?: string };
  card_faces?: ScryfallFace[];
}

/**
 * The name for plain lists. Double-faced cards use the front face. Split cards
 * keep both halves, because neither half alone names the card.
 */
export function exportNameFor(card: ScryfallCard): string {
  if (card.layout === 'split' || !card.name.includes(' // ')) return card.name;
  return card.card_faces?.[0]?.name ?? card.name.split(' // ')[0]!;
}

/** Digital-only cards can't be scanned, so they are left out and this returns null. */
export function toPrinting(card: ScryfallCard): Printing | null {
  if (card.digital) return null;

  const front = card.card_faces?.[0];
  const exportName = exportNameFor(card);
  const image = card.image_uris?.normal ?? front?.image_uris?.normal;
  const typeLine = card.type_line ?? front?.type_line;
  const manaValue = card.cmc ?? front?.cmc;
  const multiverseId = card.multiverse_ids?.[0];

  const attrs: NonNullable<Printing['attrs']> = {};
  if (card.rarity) attrs.rarity = card.rarity;
  if (typeLine) attrs.typeLine = typeLine;
  if (card.color_identity) attrs.colorIdentity = card.color_identity;
  if (manaValue !== undefined) attrs.manaValue = manaValue;
  if (multiverseId !== undefined) attrs.multiverseId = multiverseId;

  const printedName = card.flavor_name ?? front?.flavor_name ?? card.printed_name ?? front?.printed_name;
  return {
    id: card.id,
    name: card.name,
    ...(exportName !== card.name ? { exportName } : {}),
    ...(printedName && printedName !== card.name && printedName !== exportName ? { printedName } : {}),
    set: card.set,
    setName: card.set_name,
    number: card.collector_number,
    finishes: card.finishes,
    lang: card.lang,
    ...(image ? { image } : {}),
    ...(card.released_at ? { released: card.released_at } : {}),
    attrs,
  };
}

type NameSource = Pick<ScryfallCard, 'name' | 'card_faces' | 'flavor_name' | 'printed_name'>;

function addTo(map: Map<string, Set<string>>, key: string, fullName: string): void {
  const fullNames = map.get(key) ?? new Set<string>();
  fullNames.add(fullName);
  map.set(key, fullNames);
}

function sortedRecord(map: Map<string, Set<string>>): Record<string, string[]> {
  return Object.fromEntries(
    [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, full]) => [key, [...full].sort()]),
  );
}

export function buildNameDictionary(cards: NameSource[]): NameDictionary {
  const names = new Set<string>();
  const faces = new Map<string, Set<string>>();
  const aliases = new Map<string, Set<string>>();
  for (const card of cards) {
    names.add(card.name);
    // Whatever is printed on the card is what OCR and people will read.
    for (const printed of [card.flavor_name, card.printed_name]) {
      if (printed && printed !== card.name) addTo(aliases, printed, card.name);
    }
    for (const face of card.card_faces ?? []) {
      if (face.name !== card.name) addTo(faces, face.name, card.name);
      for (const printed of [face.flavor_name, face.printed_name]) {
        if (printed && printed !== face.name && printed !== card.name) addTo(aliases, printed, card.name);
      }
    }
  }
  return { names: [...names].sort(), faces: sortedRecord(faces), aliases: sortedRecord(aliases) };
}

export async function* readJsonLines<T>(stream: ReadableType): AsyncGenerator<T> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) yield JSON.parse(trimmed) as T;
  }
}

function openJsonLines(path: string): ReadableType {
  const file = createReadStream(path);
  return path.endsWith('.gz') ? file.pipe(createGunzip()) : file;
}

interface BulkEntry {
  type: string;
  updated_at: string;
  jsonl_download_uri?: string;
}

/** Downloads the bulk file once per Scryfall update. Bulk files are meant for this, unlike per-card API calls. */
async function fetchBulkFile(cacheDir: string): Promise<{ path: string; updatedAt: string }> {
  const { data } = await fetchJson<{ data: BulkEntry[] }>('https://api.scryfall.com/bulk-data', { headers: SCRYFALL_HEADERS });

  const entry = data.find((candidate) => candidate.type === BULK_TYPE);
  if (!entry?.jsonl_download_uri) throw new Error(`Scryfall bulk listing has no JSONL file for ${BULK_TYPE}`);

  await mkdir(cacheDir, { recursive: true });
  const stamp = entry.updated_at.replace(/\W/g, '');
  const path = join(cacheDir, `${BULK_TYPE}-${stamp}.jsonl.gz`);
  if (existsSync(path)) return { path, updatedAt: entry.updated_at };

  await downloadToFile(entry.jsonl_download_uri, path, { headers: SCRYFALL_HEADERS });
  return { path, updatedAt: entry.updated_at };
}

async function buildIndex(options: BuildOptions): Promise<BuiltGameData> {
  const { path, updatedAt } = options.sourceFile
    ? { path: options.sourceFile, updatedAt: 'local file' }
    : await fetchBulkFile(options.cacheDir);

  const printings: Printing[] = [];
  const physicalCards: NameSource[] = [];
  for await (const card of readJsonLines<ScryfallCard>(openJsonLines(path))) {
    const printing = toPrinting(card);
    if (!printing) continue;
    printings.push(printing);
    physicalCards.push({
      name: card.name,
      card_faces: card.card_faces,
      flavor_name: card.flavor_name,
      printed_name: card.printed_name,
    });
  }

  return {
    source: { name: `Scryfall ${BULK_TYPE}`, updatedAt },
    printings,
    names: buildNameDictionary(physicalCards),
  };
}

export const mtgIndexBuilder: GameIndexBuilder = {
  id: 'mtg',
  // About 0.2 MB (30 KB gzipped) per shard, so a nightly build changes only the shards its new
  // cards fall in: 16 to 18 Nov 2026 was 4.0 MB to download, against 8.3 MB with 64 shards. The app
  // reads the count from the manifest (one fingerprint shard per printings shard), so any count works
  // with any version of it; file names stay printings.mtg.<n>.json, n unpadded past 99.
  shardCount: 256,
  buildIndex,
};
