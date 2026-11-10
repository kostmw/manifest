import { createGray, type GrayImage } from './image';

function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const value = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = value;
    sum += value;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i]! /= sum;
  return kernel;
}

/** Separable Gaussian blur with clamped edges. */
export function gaussianBlur(image: GrayImage, sigma: number): GrayImage {
  if (sigma <= 0) return image;
  const kernel = gaussianKernel(sigma);
  const radius = (kernel.length - 1) / 2;
  const { width, height } = image;
  const temp = new Float32Array(width * height);
  const out = createGray(width, height);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = Math.min(width - 1, Math.max(0, x + k));
        sum += image.data[row + sx]! * kernel[k + radius]!;
      }
      temp[row + x] = sum;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = Math.min(height - 1, Math.max(0, y + k));
        sum += temp[sy * width + x]! * kernel[k + radius]!;
      }
      out.data[y * width + x] = sum;
    }
  }
  return out;
}

export interface Gradients {
  gx: Float32Array;
  gy: Float32Array;
  magnitude: Float32Array;
}

/** 3×3 Sobel. Border pixels get zero gradient. */
export function sobel(image: GrayImage): Gradients {
  const { width, height, data } = image;
  const size = width * height;
  const gx = new Float32Array(size);
  const gy = new Float32Array(size);
  const magnitude = new Float32Array(size);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const tl = data[i - width - 1]!;
      const t = data[i - width]!;
      const tr = data[i - width + 1]!;
      const l = data[i - 1]!;
      const r = data[i + 1]!;
      const bl = data[i + width - 1]!;
      const b = data[i + width]!;
      const br = data[i + width + 1]!;
      const dx = tr + 2 * r + br - tl - 2 * l - bl;
      const dy = bl + 2 * b + br - tl - 2 * t - tr;
      gx[i] = dx;
      gy[i] = dy;
      magnitude[i] = Math.hypot(dx, dy);
    }
  }
  return { gx, gy, magnitude };
}

/** Value below which `fraction` of the samples fall, from a 1024-bin histogram. */
export function percentile(values: Float32Array, fraction: number): number {
  let max = 0;
  for (const value of values) if (value > max) max = value;
  if (max === 0) return 0;
  const bins = new Uint32Array(1024);
  for (const value of values) bins[Math.min(1023, Math.floor((value / max) * 1023))]! += 1;
  const target = values.length * fraction;
  let seen = 0;
  for (let i = 0; i < bins.length; i++) {
    seen += bins[i]!;
    if (seen >= target) return ((i + 1) / 1024) * max;
  }
  return max;
}

/** Sobel magnitude thinned to one-pixel ridges (non-maximum suppression). The first half of Canny. */
export function edgeRidges(image: GrayImage): Float32Array {
  const { width, height } = image;
  const { gx, gy, magnitude } = sobel(image);
  const thin = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const m = magnitude[i]!;
      if (m === 0) continue;
      const ax = Math.abs(gx[i]!);
      const ay = Math.abs(gy[i]!);
      let a: number;
      let b: number;
      if (ay <= ax * 0.4142) {
        a = magnitude[i - 1]!;
        b = magnitude[i + 1]!;
      } else if (ax <= ay * 0.4142) {
        a = magnitude[i - width]!;
        b = magnitude[i + width]!;
      } else if (gx[i]! * gy[i]! > 0) {
        a = magnitude[i - width - 1]!;
        b = magnitude[i + width + 1]!;
      } else {
        a = magnitude[i - width + 1]!;
        b = magnitude[i + width - 1]!;
      }
      if (m >= a && m > b) thin[i] = m;
    }
  }
  return thin;
}

/** The second half of Canny: ridges above `high`, grown through ridges above `low`. Returns a 0/1 mask. */
export function hysteresis(ridges: Float32Array, width: number, height: number, low: number, high: number): Uint8Array {
  const edges = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let top = 0;
  for (let i = 0; i < ridges.length; i++) {
    if (ridges[i]! < high || edges[i]) continue;
    edges[i] = 1;
    stack[top++] = i;
    while (top > 0) {
      const j = stack[--top]!;
      const x = j % width;
      const y = (j - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const k = ny * width + nx;
          if (!edges[k] && ridges[k]! >= low) {
            edges[k] = 1;
            stack[top++] = k;
          }
        }
      }
    }
  }
  return edges;
}

/** Canny edges on an already-blurred image, with a contrast-adaptive threshold unless one is given. */
export function canny(image: GrayImage, options: { low?: number; high?: number } = {}): Uint8Array {
  const ridges = edgeRidges(image);
  const high = options.high ?? Math.max(40, percentile(ridges, 0.9));
  return hysteresis(ridges, image.width, image.height, options.low ?? high * 0.4, high);
}

/** Like percentile(), over the non-zero values only. */
export function percentileNonZero(values: Float32Array, fraction: number): number {
  let count = 0;
  for (const value of values) if (value > 0) count++;
  if (count === 0) return 0;
  const nonZero = new Float32Array(count);
  let i = 0;
  for (const value of values) if (value > 0) nonZero[i++] = value;
  return percentile(nonZero, fraction);
}

/** Square dilation of a 0/1 mask. */
export function dilate(mask: Uint8Array, width: number, height: number, radius = 1): Uint8Array {
  const horizontal = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let on = 0;
      for (let dx = -radius; dx <= radius && !on; dx++) {
        const nx = x + dx;
        if (nx >= 0 && nx < width && mask[y * width + nx]) on = 1;
      }
      horizontal[y * width + x] = on;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let on = 0;
      for (let dy = -radius; dy <= radius && !on; dy++) {
        const ny = y + dy;
        if (ny >= 0 && ny < height && horizontal[ny * width + x]) on = 1;
      }
      out[y * width + x] = on;
    }
  }
  return out;
}

/** Variance of the 4-neighbour Laplacian: the usual focus measure. Higher is sharper. */
export function laplacianVariance(image: GrayImage): number {
  const { width, height, data } = image;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const value = data[i - 1]! + data[i + 1]! + data[i - width]! + data[i + width]! - 4 * data[i]!;
      sum += value;
      sumSq += value * value;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

/** Otsu's threshold over 0–255 values. */
export function otsuThreshold(values: Float32Array): number {
  const histogram = new Float64Array(256);
  for (const value of values) histogram[Math.max(0, Math.min(255, Math.round(value)))]! += 1;
  const total = values.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * histogram[i]!;

  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t]!;
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += t * histogram[t]!;
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sumAll - sumBackground) / weightForeground;
    const between = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold + 0.5;
}
