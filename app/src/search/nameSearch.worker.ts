import { expose } from 'comlink';
import { loadNameDictionary, onBuildChange } from '../games/indexClient';
import type { GameId } from '../games/types';
import { NameIndex, type NameHit } from '../recognize/nameSearch';

let index: NameIndex | null = null;
let loaded: GameId | null = null;

// A new build of the card index is active: search its names from now on.
onBuildChange(() => {
  const game = loaded;
  if (game) void loadNameDictionary(game).then((dictionary) => (index = new NameIndex(dictionary)), () => {});
});

const api = {
  async load(game: GameId): Promise<number> {
    const dictionary = await loadNameDictionary(game);
    index = new NameIndex(dictionary);
    loaded = game;
    return dictionary.names.length;
  },
  search(query: string, limit: number): NameHit[] {
    if (!index) throw new Error('Name search is not loaded yet');
    return index.search(query, limit);
  },
};

export type NameSearchWorker = typeof api;

expose(api);
