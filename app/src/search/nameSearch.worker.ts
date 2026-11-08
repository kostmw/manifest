import { expose } from 'comlink';
import { loadNameDictionary } from '../games/indexClient';
import type { GameId } from '../games/types';
import { NameIndex, type NameHit } from '../recognize/nameSearch';

let index: NameIndex | null = null;

const api = {
  async load(game: GameId): Promise<number> {
    const dictionary = await loadNameDictionary(game);
    index = new NameIndex(dictionary);
    return dictionary.names.length;
  },
  search(query: string, limit: number): NameHit[] {
    if (!index) throw new Error('Name search is not loaded yet');
    return index.search(query, limit);
  },
};

export type NameSearchWorker = typeof api;

expose(api);
