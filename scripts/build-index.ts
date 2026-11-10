/**
 * Builds the index artifacts that the app downloads.
 *
 *   npm run index:build                    # latest Scryfall bulk data, into data/
 *   npm run index:build -- --source f.jsonl --out dir   # local file, for tests
 *
 * Fingerprints (visual hashes) need every card's image. They are cached in
 * --fingerprint-cache with the image version they came from, so only new or
 * changed cards are downloaded. --fingerprints cache-only builds from the
 * cache without downloading; --fingerprints none leaves them out (tests).
 * --images dir keeps the downloaded images too.
 */
import { parseArgs } from 'node:util';
import { mtg } from '../app/src/games/mtg/adapter';
import { FINGERPRINT_BYTES, FINGERPRINT_VERSION } from '../app/src/recognize/fingerprint';
import { buildFingerprints, type FingerprintMode } from './fingerprints';
import { mtgIndexBuilder } from './games/mtg';
import { writeGameIndex, writeManifest, type FingerprintData } from './writeIndex';

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    out: { type: 'string', default: 'data' },
    cache: { type: 'string', default: '.cache/bulk' },
    fingerprints: { type: 'string', default: 'fetch' },
    'fingerprint-cache': { type: 'string', default: '.cache/fingerprints/mtg.json' },
    images: { type: 'string' },
  },
});

const mode = values.fingerprints as FingerprintMode;
if (!['fetch', 'cache-only', 'none'].includes(mode)) throw new Error(`--fingerprints must be fetch, cache-only or none`);

const builder = mtgIndexBuilder;
const started = Date.now();
const data = await builder.buildIndex({ sourceFile: values.source, cacheDir: values.cache! });

let fingerprints: FingerprintData | undefined;
if (mode !== 'none') {
  const result = await buildFingerprints(data.printings, {
    mode,
    regions: mtg.regions,
    cacheFile: values['fingerprint-cache']!,
    imageDir: values.images ?? null,
    log: console.log,
  });
  fingerprints = { version: FINGERPRINT_VERSION, rowBytes: FINGERPRINT_BYTES, imageSize: 'small', byId: result.fingerprints };
}

const index = await writeGameIndex(builder.id, data, builder.shardCount, values.out!, fingerprints);
await writeManifest(values.out!, { [builder.id]: index }, new Date().toISOString());

const total = (files: { bytes: number }[] = []) => files.reduce((sum, file) => sum + file.bytes, 0);
const shardBytes = index.shards.map((shard) => shard.bytes);
console.log(`${builder.id}: ${index.counts.printings} printings, ${index.counts.names} names (${index.source.updatedAt})`);
console.log(`names: ${(index.names.bytes / 1e6).toFixed(2)} MB, collectors: ${(total(index.collectors ? [index.collectors] : []) / 1e6).toFixed(2)} MB`);
console.log(
  `shards: ${shardBytes.length}, largest ${(Math.max(...shardBytes) / 1e6).toFixed(2)} MB, ` +
    `total ${(total(index.shards) / 1e6).toFixed(1)} MB`,
);
console.log(
  index.hashes
    ? `fingerprints: ${fingerprints!.byId.size} of ${data.printings.length} printings, ${(total(index.hashes) / 1e6).toFixed(2)} MB`
    : 'fingerprints: none',
);
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
