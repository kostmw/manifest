/**
 * Plain pixel buffers. They are laid out like ImageData, so canvases in the
 * browser and decoders in Node can hand pixels over without copying, and every
 * vision function stays pure and runs the same in a worker and in the eval.
 */

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  readonly data: Uint8ClampedArray | Uint8Array;
}

/** One channel, 0–255 floats, row-major. */
export interface GrayImage {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function createRgba(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function createGray(width: number, height: number): GrayImage {
  return { width, height, data: new Float32Array(width * height) };
}

/** BT.601 luma. */
export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function toGray(image: RgbaImage): GrayImage {
  const out = createGray(image.width, image.height);
  const { data } = image;
  for (let i = 0, p = 0; i < out.data.length; i++, p += 4) {
    out.data[i] = luma(data[p]!, data[p + 1]!, data[p + 2]!);
  }
  return out;
}

/**
 * Grayscale at a reduced size, averaging every source pixel that falls in each
 * output pixel. Returns the scale used (output / input), which is 1 when the
 * image is already small enough.
 */
export function grayDownscaled(image: RgbaImage, maxSide: number): { gray: GrayImage; scale: number } {
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  if (scale === 1) return { gray: toGray(image), scale };

  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const sums = new Float32Array(width * height);
  const counts = new Uint16Array(width * height);
  const { data } = image;
  const xMap = new Int32Array(image.width);
  for (let x = 0; x < image.width; x++) xMap[x] = Math.min(width - 1, Math.floor((x * width) / image.width));

  for (let y = 0; y < image.height; y++) {
    const row = Math.min(height - 1, Math.floor((y * height) / image.height)) * width;
    let p = y * image.width * 4;
    for (let x = 0; x < image.width; x++, p += 4) {
      const index = row + xMap[x]!;
      sums[index]! += luma(data[p]!, data[p + 1]!, data[p + 2]!);
      counts[index]! += 1;
    }
  }
  const gray = createGray(width, height);
  for (let i = 0; i < gray.data.length; i++) gray.data[i] = sums[i]! / Math.max(1, counts[i]!);
  return { gray, scale: width / image.width };
}

/** Averages k×k blocks. Used before warping a card that is much larger than its canonical size. */
export function shrinkRgba(image: RgbaImage, factor: number): RgbaImage {
  const k = Math.max(1, Math.floor(factor));
  if (k === 1) return image;
  const width = Math.floor(image.width / k);
  const height = Math.floor(image.height / k);
  const out = createRgba(width, height);
  const area = k * k;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < k; dy++) {
        let p = ((y * k + dy) * image.width + x * k) * 4;
        for (let dx = 0; dx < k; dx++, p += 4) {
          r += image.data[p]!;
          g += image.data[p + 1]!;
          b += image.data[p + 2]!;
          a += image.data[p + 3]!;
        }
      }
      const o = (y * width + x) * 4;
      out.data[o] = r / area;
      out.data[o + 1] = g / area;
      out.data[o + 2] = b / area;
      out.data[o + 3] = a / area;
    }
  }
  return out;
}

export function cropRgba(image: RgbaImage, box: Box): RgbaImage {
  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(image.width, Math.round(box.x + box.width));
  const y1 = Math.min(image.height, Math.round(box.y + box.height));
  const out = createRgba(Math.max(0, x1 - x0), Math.max(0, y1 - y0));
  for (let y = y0; y < y1; y++) {
    const start = (y * image.width + x0) * 4;
    out.data.set(image.data.subarray(start, start + out.width * 4), (y - y0) * out.width * 4);
  }
  return out;
}

export function cropGray(image: GrayImage, box: Box): GrayImage {
  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(image.width, Math.round(box.x + box.width));
  const y1 = Math.min(image.height, Math.round(box.y + box.height));
  const out = createGray(Math.max(0, x1 - x0), Math.max(0, y1 - y0));
  for (let y = y0; y < y1; y++) {
    const start = y * image.width + x0;
    out.data.set(image.data.subarray(start, start + out.width), (y - y0) * out.width);
  }
  return out;
}

export function rotateRgba180(image: RgbaImage): RgbaImage {
  const out = createRgba(image.width, image.height);
  const pixels = image.width * image.height;
  for (let i = 0; i < pixels; i++) {
    const from = i * 4;
    const to = (pixels - 1 - i) * 4;
    out.data[to] = image.data[from]!;
    out.data[to + 1] = image.data[from + 1]!;
    out.data[to + 2] = image.data[from + 2]!;
    out.data[to + 3] = image.data[from + 3]!;
  }
  return out;
}

/** Bilinear resize, for scaling a small crop up before OCR. */
export function resizeGray(image: GrayImage, width: number, height: number): GrayImage {
  const out = createGray(width, height);
  const sx = image.width / width;
  const sy = image.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(image.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(image.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const wx = fx - x0;
      const top = image.data[y0 * image.width + x0]! * (1 - wx) + image.data[y0 * image.width + x1]! * wx;
      const bottom = image.data[y1 * image.width + x0]! * (1 - wx) + image.data[y1 * image.width + x1]! * wx;
      out.data[y * width + x] = top * (1 - wy) + bottom * wy;
    }
  }
  return out;
}

export function grayToRgba(image: GrayImage): RgbaImage {
  const out = createRgba(image.width, image.height);
  for (let i = 0, p = 0; i < image.data.length; i++, p += 4) {
    const value = image.data[i]!;
    out.data[p] = value;
    out.data[p + 1] = value;
    out.data[p + 2] = value;
    out.data[p + 3] = 255;
  }
  return out;
}

/** Binary PGM. Tesseract's image reader takes it directly, so no PNG encoder is needed. */
export function encodePgm(image: GrayImage): Uint8Array {
  const header = new TextEncoder().encode(`P5\n${image.width} ${image.height}\n255\n`);
  const out = new Uint8Array(header.length + image.data.length);
  out.set(header);
  for (let i = 0; i < image.data.length; i++) {
    out[header.length + i] = Math.max(0, Math.min(255, Math.round(image.data[i]!)));
  }
  return out;
}

/** Scales a box given in one canonical size to another image size. */
export function scaleBox(box: Box, from: { width: number; height: number }, to: { width: number; height: number }): Box {
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  return { x: box.x * sx, y: box.y * sy, width: box.width * sx, height: box.height * sy };
}
