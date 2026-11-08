/**
 * Printings are sharded by a hash of the card name, so that choosing a name
 * downloads one small shard, and all printings of a card always share a shard.
 * The hash must never change without a manifest schema bump: the app and the
 * builder have to agree on it.
 */
export function printingShardIndex(name: string, shardCount: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % shardCount;
}

export function printingShardFile(game: string, shard: number): string {
  return `printings.${game}.${String(shard).padStart(2, '0')}.json`;
}
