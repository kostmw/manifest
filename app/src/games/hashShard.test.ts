import { describe, expect, it } from 'vitest';
import { decodeHashShard, encodeHashShard, HASH_SHARD_HEADER_BYTES } from './hashShard';

const sha = 'a1b2c3d4e5f60718' + '0'.repeat(48);

describe('hash shards', () => {
  it('round-trip rows in order, with empty rows for printings without an image', () => {
    const rows = [Uint8Array.from({ length: 16 }, (_, i) => i + 1), null, Uint8Array.from({ length: 16 }, () => 255)];
    const bytes = encodeHashShard({ version: 3, rowBytes: 16, printingsSha256: sha, rows });
    expect(bytes.length).toBe(HASH_SHARD_HEADER_BYTES + 48);

    const shard = decodeHashShard(bytes);
    expect(shard).toMatchObject({ version: 3, rowBytes: 16, rows: 3, printingsSha: 'a1b2c3d4e5f60718' });
    expect(shard.words.length).toBe(12);
    expect(shard.words[0]).toBe(0x04030201);
    expect(Array.from(shard.words.subarray(4, 8))).toEqual([0, 0, 0, 0]);
    expect(shard.words[8]).toBe(0xffffffff);
  });

  it('decodes from a buffer at any offset', () => {
    const bytes = encodeHashShard({ version: 1, rowBytes: 8, printingsSha256: sha, rows: [new Uint8Array(8).fill(7)] });
    const padded = new Uint8Array(bytes.length + 3);
    padded.set(bytes, 3);
    expect(decodeHashShard(padded.subarray(3)).words[1]).toBe(0x07070707);
  });

  it('rejects files that are not shards, or are cut short', () => {
    expect(() => decodeHashShard(new Uint8Array(40))).toThrow('Not a fingerprint shard');
    const bytes = encodeHashShard({ version: 1, rowBytes: 16, printingsSha256: sha, rows: [new Uint8Array(16)] });
    expect(() => decodeHashShard(bytes.subarray(0, bytes.length - 4))).toThrow('truncated');
  });

  it('refuses rows of the wrong size', () => {
    expect(() => encodeHashShard({ version: 1, rowBytes: 16, printingsSha256: sha, rows: [new Uint8Array(8)] })).toThrow();
  });
});
