/**
 * The source of build B of the e2e card index: the sample plus what a later
 * nightly build would bring, a new printing of Sol Ring (set TST) and a new
 * card. Made-up cards, named as such. playwright.config.ts builds it into
 * .cache/e2e-index-b; tests/e2e/indexUpdates.spec.ts serves it after build A.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const lines = readFileSync('tests/fixtures/scryfall-sample.jsonl', 'utf8').trim().split('\n');
const solRing = JSON.parse(lines.find((line) => (JSON.parse(line) as { name: string }).name === 'Sol Ring')!) as Record<string, unknown>;
const testSet = { set: 'tst', set_name: 'Manifest Test Set', released_at: '2026-11-18', multiverse_ids: [] };
const image = (id: string) => ({ normal: `https://cards.scryfall.io/normal/front/0/0/${id}.jpg` });

const added = [
  { ...solRing, ...testSet, id: '00000000-0000-4000-8000-0000000000b1', collector_number: '1', image_uris: image('00000000-0000-4000-8000-0000000000b1') },
  { ...solRing, ...testSet, id: '00000000-0000-4000-8000-0000000000b2', name: 'Manifest Test Card', collector_number: '2', image_uris: image('00000000-0000-4000-8000-0000000000b2') },
];

mkdirSync('.cache', { recursive: true });
writeFileSync('.cache/e2e-sample-b.jsonl', `${[...lines, ...added.map((card) => JSON.stringify(card))].join('\n')}\n`);
