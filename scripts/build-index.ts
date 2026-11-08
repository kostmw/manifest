/**
 * Builds the index artifacts that the app downloads.
 *
 *   npm run index:build                    # latest Scryfall bulk data, into data/
 *   npm run index:build -- --source f.jsonl --out dir   # local file, for tests
 */
import { parseArgs } from 'node:util';
import { mtgIndexBuilder } from './games/mtg';
import { writeGameIndex, writeManifest } from './writeIndex';

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    out: { type: 'string', default: 'data' },
    cache: { type: 'string', default: '.cache/bulk' },
  },
});

const builder = mtgIndexBuilder;
const started = Date.now();
const data = await builder.buildIndex({ sourceFile: values.source, cacheDir: values.cache! });
const index = await writeGameIndex(builder.id, data, builder.shardCount, values.out!);
await writeManifest(values.out!, { [builder.id]: index }, new Date().toISOString());

const shardBytes = index.shards.map((shard) => shard.bytes);
console.log(`${builder.id}: ${index.counts.printings} printings, ${index.counts.names} names (${index.source.updatedAt})`);
console.log(`names: ${(index.names.bytes / 1e6).toFixed(2)} MB`);
console.log(
  `shards: ${shardBytes.length}, largest ${(Math.max(...shardBytes) / 1e6).toFixed(2)} MB, ` +
    `total ${(shardBytes.reduce((sum, bytes) => sum + bytes, 0) / 1e6).toFixed(1)} MB`,
);
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
