/** Image files to and from RgbaImage, for the Node eval only. The app decodes with createImageBitmap. */
import { readFile, writeFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import type { RgbaImage } from '../../app/src/vision/image';

export async function readImage(path: string): Promise<RgbaImage> {
  const bytes = await readFile(path);
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    const png = PNG.sync.read(bytes);
    return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
    return { width: decoded.width, height: decoded.height, data: new Uint8ClampedArray(decoded.data) };
  }
  throw new Error(`${path}: only JPEG and PNG are supported (convert HEIC first)`);
}

export function encodeJpeg(image: RgbaImage, quality: number): Uint8Array {
  const encoded = jpeg.encode({ width: image.width, height: image.height, data: Buffer.from(image.data) }, quality);
  return new Uint8Array(encoded.data);
}

export async function writeJpeg(path: string, image: RgbaImage, quality = 88): Promise<void> {
  await writeFile(path, encodeJpeg(image, quality));
}

export function decodeJpeg(bytes: Uint8Array): RgbaImage {
  const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  return { width: decoded.width, height: decoded.height, data: new Uint8ClampedArray(decoded.data) };
}
