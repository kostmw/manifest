import type { GameId, NameDictionary, Printing } from '../../app/src/games/types';

export interface BuiltGameData {
  source: { name: string; updatedAt: string };
  printings: Printing[];
  names: NameDictionary;
}

export interface BuildOptions {
  /** Read this local file instead of downloading the source data. */
  sourceFile?: string;
  cacheDir: string;
}

/**
 * The offline half of a game adapter. It is separate from the client adapter
 * in app/src/games because it needs Node APIs and must never reach the bundle.
 */
export interface GameIndexBuilder {
  id: GameId;
  shardCount: number;
  buildIndex(options: BuildOptions): Promise<BuiltGameData>;
}
