/**
 * Turns a phone's test log into real-scan fixtures:
 *
 *   npx tsx tests/eval/testlog-to-fixtures.ts manifest-testlog-20261113-0915.json
 *   npx tsx tests/eval/testlog-to-fixtures.ts log.json --out tests/fixtures/real-scans --dry-run
 *
 * Every read the user labelled (a review accepted as a printing, or a batch
 * row's printing changed), and that has a picture, becomes a padded JPEG in
 * the output folder (gitignored) and an entry in its labels.json. Entries
 * already there are kept; a file already there isn't overwritten. See TESTLOG.md.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseTestLog } from '../../app/src/session/testLog';
import { fixturesFromLog } from './testlogFixtures';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: 'tests/fixtures/real-scans' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const [logPath] = positionals;
if (!logPath) {
  console.error('Usage: npx tsx tests/eval/testlog-to-fixtures.ts <test log .json> [--out dir] [--dry-run]');
  process.exit(1);
}

const log = parseTestLog(await readFile(logPath, 'utf8'));
const fixtures = fixturesFromLog(log);
const labelsPath = join(values.out!, 'labels.json');
const labels = existsSync(labelsPath) ? (JSON.parse(await readFile(labelsPath, 'utf8')) as Record<string, unknown>) : {};
let added = 0;
for (const fixture of fixtures) {
  if (labels[fixture.file] || existsSync(join(values.out!, fixture.file))) {
    console.log(`skip ${fixture.file}: already there`);
    continue;
  }
  console.log(`${values['dry-run'] ? 'would add' : 'add'} ${fixture.file}: ${fixture.label.name} (${fixture.label.id}) [${fixture.label.tags.join(', ')}]`);
  if (!values['dry-run']) await writeFile(join(values.out!, fixture.file), fixture.bytes);
  labels[fixture.file] = fixture.label;
  added += 1;
}
if (!values['dry-run'] && added > 0) await writeFile(labelsPath, `${JSON.stringify(labels, null, 2)}\n`);
console.log(`${log.reads.length} reads, ${fixtures.length} labelled with a picture, ${added} ${values['dry-run'] ? 'would be ' : ''}added.`);
