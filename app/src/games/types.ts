/** Shared by the app and the offline index builders, so it must stay free of browser and Node APIs. */

export type GameId = 'mtg';

/** One printing as stored in the index. Game-specific fields live in `attrs`, read only by that game's adapter. */
export interface Printing {
  id: string;
  /** Full name as the data source spells it, e.g. "Delver of Secrets // Insectile Aberration". */
  name: string;
  /** Shorter name for plain lists, when it differs from `name`. */
  exportName?: string;
  set: string;
  setName: string;
  number: string;
  finishes: string[];
  lang: string;
  image?: string;
  /** ISO date. */
  released?: string;
  attrs?: Record<string, string | number | string[]>;
}

export interface NameDictionary {
  /** Unique full names, sorted. */
  names: string[];
  /** Each face of a multi-face card, mapped to the full names it belongs to. */
  faces: Record<string, string[]>;
}

export interface IndexFile {
  file: string;
  bytes: number;
  sha256: string;
}

export interface GameIndex {
  source: { name: string; updatedAt: string };
  counts: { names: number; printings: number };
  names: IndexFile;
  shards: IndexFile[];
}

export interface IndexManifest {
  schema: 1;
  buildDate: string;
  games: Partial<Record<GameId, GameIndex>>;
}

/** Hosting limit for one static file. Index builds fail rather than exceed it. */
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;
