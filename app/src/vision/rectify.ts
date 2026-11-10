import { applyHomography, distance, homography, type Point, type Quad } from './geometry';
import { createRgba, cropRgba, shrinkRgba, type RgbaImage } from './image';

export interface Size {
  width: number;
  height: number;
}

/** Bilinear sample at a pixel-centre coordinate. Outside the image reads as transparent black. */
function sample(image: RgbaImage, x: number, y: number, out: Uint8ClampedArray, offset: number): void {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const wx = fx - x0;
  const wy = fy - y0;
  const { width, height, data } = image;
  for (let c = 0; c < 4; c++) {
    let value = 0;
    for (let dy = 0; dy <= 1; dy++) {
      const sy = Math.min(height - 1, Math.max(0, y0 + dy));
      const weightY = dy ? wy : 1 - wy;
      for (let dx = 0; dx <= 1; dx++) {
        const sx = Math.min(width - 1, Math.max(0, x0 + dx));
        const weight = weightY * (dx ? wx : 1 - wx);
        value += data[(sy * width + sx) * 4 + c]! * weight;
      }
    }
    out[offset + c] = value;
  }
}

/**
 * Perspective-warps the quadrilateral `corners` of `image` onto an upright
 * `size` rectangle. A card much bigger than `size` is first shrunk by block
 * averaging, so the warp samples an image of about the right scale and
 * doesn't alias.
 */
export function warpQuad(image: RgbaImage, corners: Quad, size: Size): RgbaImage {
  const across = (distance(corners[0], corners[1]) + distance(corners[3], corners[2])) / 2;
  const down = (distance(corners[0], corners[3]) + distance(corners[1], corners[2])) / 2;
  const factor = Math.floor(Math.min(across / size.width, down / size.height));

  let source = image;
  let points: Point[] = corners;
  if (factor >= 2) {
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    const x0 = Math.max(0, Math.floor(Math.min(...xs)) - factor);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)) - factor);
    const x1 = Math.min(image.width, Math.ceil(Math.max(...xs)) + factor);
    const y1 = Math.min(image.height, Math.ceil(Math.max(...ys)) + factor);
    source = shrinkRgba(cropRgba(image, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }), factor);
    points = corners.map((p) => ({ x: (p.x - x0 + 0.5) / factor - 0.5, y: (p.y - y0 + 0.5) / factor - 0.5 }));
  }

  const target: Point[] = [
    { x: 0, y: 0 },
    { x: size.width, y: 0 },
    { x: size.width, y: size.height },
    { x: 0, y: size.height },
  ];
  // Corners are pixel centres; the target rectangle runs along pixel edges.
  const from = points.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
  const h = homography(target, from);
  const out = createRgba(size.width, size.height);
  if (!h) return out;
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const p = applyHomography(h, x + 0.5, y + 0.5);
      sample(source, p.x, p.y, out.data as Uint8ClampedArray, (y * size.width + x) * 4);
    }
  }
  return out;
}
