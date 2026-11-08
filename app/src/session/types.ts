import type { GameId, Printing } from '../games/types';

export interface BatchSettings {
  defaultLang: string;
  defaultCondition: string;
}

export interface Batch {
  id: string;
  game: GameId;
  name: string;
  location?: string;
  /** ISO timestamp. */
  createdAt: string;
  settings: BatchSettings;
}

export interface BatchItem {
  id: string;
  batchId: string;
  /** A copy, so that a batch still exports correctly after the index changes or while offline. */
  printing: Printing;
  finish: string;
  lang: string;
  condition: string;
  qty: number;
  /** ISO timestamp. */
  addedAt: string;
  /** Printing + finish + language + condition. Adding a card with the same key raises its quantity. */
  mergeKey: string;
}
