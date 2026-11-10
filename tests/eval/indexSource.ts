/** The card index read from a local data directory, for the eval. The app fetches the same files over HTTP. */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IndexSource } from '../../app/src/games/catalog';
import type { GameId, IndexManifest } from '../../app/src/games/types';

export function fileIndexSource(dataDir: string, game: GameId): IndexSource {
  const manifest = JSON.parse(readFileSync(join(dataDir, 'manifest.json'), 'utf8')) as IndexManifest;
  const index = manifest.games[game];
  if (!index) throw new Error(`${dataDir}/manifest.json has no ${game} index`);
  return {
    gameIndex: async () => index,
    json: async (file) => JSON.parse(await readFile(join(dataDir, file.file), 'utf8')),
    bytes: async (file) => new Uint8Array(await readFile(join(dataDir, file.file))),
  };
}
