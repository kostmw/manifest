/**
 * Files for a bulk import: which ones are pictures, a key that recognises the
 * same photo picked again, and the files in a folder dropped on the page.
 */

/** Bytes from the start of a file that go into its key. A photo's first 64 KB hold its EXIF data: its time and camera. */
const KEY_BYTES = 64 * 1024;

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'jfif', 'png', 'webp', 'heic', 'heif', 'avif', 'gif', 'bmp', 'tif', 'tiff']);

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** FNV-1a, for pages without crypto.subtle (plain http on a LAN while developing). */
function fnv1a(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

/**
 * The same photo, picked again, gets the same key: its size plus a hash of
 * its first 64 KB. Names aren't used, since the iPhone's photo picker doesn't
 * keep them the same between picks.
 */
export async function fileKey(file: Blob): Promise<string> {
  const head = new Uint8Array(await file.slice(0, KEY_BYTES).arrayBuffer());
  const subtle = globalThis.crypto?.subtle;
  const digest = subtle ? hex(new Uint8Array(await subtle.digest('SHA-256', head))).slice(0, 32) : fnv1a(head);
  return `${file.size}:${digest}`;
}

const extension = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';

/** A picture, going by its type, or by its name when the browser gives no type (HEIC in Chrome). */
export function isImageFile(file: { name: string; type: string }): boolean {
  if (file.type) return file.type.startsWith('image/');
  return IMAGE_EXTENSIONS.has(extension(file.name));
}

/** Files nobody means to import: a Mac's .DS_Store and other hidden files, Windows' Thumbs.db. */
export function isClutter(file: { name: string }): boolean {
  return file.name.startsWith('.') || file.name.toLowerCase() === 'thumbs.db' || file.name.toLowerCase() === 'desktop.ini';
}

/** The files to import, in a stable order: by folder and name, as a scanner numbers its pages. */
export function importable(files: Iterable<File>): File[] {
  const path = (file: File) => (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  return [...files].filter((file) => !isClutter(file)).sort((a, b) => path(a).localeCompare(path(b), undefined, { numeric: true }));
}

interface EntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?(success: (file: File) => void, failure: (error: unknown) => void): void;
  createReader?(): { readEntries(success: (entries: EntryLike[]) => void, failure: (error: unknown) => void): void };
}

async function entryFiles(entry: EntryLike, into: File[]): Promise<void> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File | null>((resolve) => entry.file!(resolve, () => resolve(null)));
    if (file) into.push(file);
    return;
  }
  if (!entry.isDirectory || !entry.createReader) return;
  const reader = entry.createReader();
  // readEntries hands a folder over in pieces (100 at a time in Chrome) until it returns none.
  for (;;) {
    const batch = await new Promise<EntryLike[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
    if (batch.length === 0) break;
    for (const child of batch) await entryFiles(child, into);
  }
}

/** Every file dropped on the page, the files inside dropped folders included. */
export async function filesFromDrop(transfer: DataTransfer): Promise<File[]> {
  const entries = [...transfer.items]
    .filter((item) => item.kind === 'file')
    .map((item) => (item as DataTransferItem & { webkitGetAsEntry?(): EntryLike | null }).webkitGetAsEntry?.() ?? null);
  if (entries.length === 0 || entries.some((entry) => entry === null)) return [...transfer.files];
  const files: File[] = [];
  for (const entry of entries) await entryFiles(entry!, files);
  return files;
}
