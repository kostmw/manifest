import type { GameAdapter } from './adapter';
import { mtg } from './mtg/adapter';
import type { GameId } from './types';

const GAMES: Record<GameId, GameAdapter> = { mtg };

export function getGame(id: GameId): GameAdapter {
  return GAMES[id];
}
