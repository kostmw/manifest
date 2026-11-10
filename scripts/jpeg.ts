/** JPEG decoding for the Node index builders. The app decodes with createImageBitmap instead. */
import jpeg from 'jpeg-js';
import type { RgbaImage } from '../app/src/vision/image';

export function decodeJpeg(bytes: Uint8Array): RgbaImage {
  const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  return { width: decoded.width, height: decoded.height, data: new Uint8ClampedArray(decoded.data) };
}
