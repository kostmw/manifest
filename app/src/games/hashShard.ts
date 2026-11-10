/**
 * hashes.<game>.<shard>.bin: one visual fingerprint per printing, in exactly
 * the order of printings.<game>.<shard>.json, so a row number is all it takes
 * to find the printing. A header ties the file to the printings shard it was
 * built with, so a stale pair is detected instead of misread.
 *
 *   0  "MFP1"
 *   4  fingerprint version (u8)
 *   5  bytes per row (u8)
 *   6  reserved (2 bytes)
 *   8  row count (u32, little-endian)
 *   12 first 8 bytes of the printings shard's sha256
 *   20 rows; a row of zeros is a printing without an image
 *
 * Shared by the index builder and the app, so it must stay free of browser and Node APIs.
 */

const MAGIC = [0x4d, 0x46, 0x50, 0x31]; // "MFP1"
export const HASH_SHARD_HEADER_BYTES = 20;

export interface HashShard {
  version: number;
  rowBytes: number;
  rows: number;
  /** Hex, 16 characters: the start of the matching printings shard's sha256. */
  printingsSha: string;
  /** Rows as 32-bit words, rowBytes / 4 per row. */
  words: Uint32Array;
}

export function encodeHashShard(input: { version: number; rowBytes: number; printingsSha256: string; rows: (Uint8Array | null)[] }): Uint8Array {
  const { version, rowBytes, rows } = input;
  if (rowBytes % 4 !== 0) throw new Error('Rows must be whole 32-bit words');
  const out = new Uint8Array(HASH_SHARD_HEADER_BYTES + rows.length * rowBytes);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  out[4] = version;
  out[5] = rowBytes;
  view.setUint32(8, rows.length, true);
  for (let i = 0; i < 8; i++) out[12 + i] = parseInt(input.printingsSha256.slice(i * 2, i * 2 + 2), 16);
  rows.forEach((row, i) => {
    if (!row) return;
    if (row.length !== rowBytes) throw new Error(`Row ${i} has ${row.length} bytes, expected ${rowBytes}`);
    out.set(row, HASH_SHARD_HEADER_BYTES + i * rowBytes);
  });
  return out;
}

export function decodeHashShard(bytes: Uint8Array): HashShard {
  if (bytes.length < HASH_SHARD_HEADER_BYTES || MAGIC.some((value, i) => bytes[i] !== value)) {
    throw new Error('Not a fingerprint shard');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rowBytes = bytes[5]!;
  const rows = view.getUint32(8, true);
  if (rowBytes % 4 !== 0 || bytes.length !== HASH_SHARD_HEADER_BYTES + rows * rowBytes) {
    throw new Error('Fingerprint shard is truncated or malformed');
  }
  const printingsSha = Array.from(bytes.subarray(12, 20), (b) => b.toString(16).padStart(2, '0')).join('');
  // Copy, so the words are aligned whatever buffer the bytes came in.
  const body = bytes.slice(HASH_SHARD_HEADER_BYTES);
  return { version: bytes[4]!, rowBytes, rows, printingsSha, words: new Uint32Array(body.buffer, 0, (rows * rowBytes) / 4) };
}
