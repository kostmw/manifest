/**
 * What a detected outline says about how the card lies relative to the camera.
 * A card seen at an angle looks shorter (or narrower) than it is, so its
 * outline's width:height ratio is not the card's. Knowing the camera's field
 * of view, the true ratio and the angle can be recovered from the four corners
 * (Zhang & He, "Whiteboard scanning and image enhancement", 2007), assuming
 * the optical centre is the middle of the frame, as it is for uncropped
 * photos and video.
 */
import type { Point, Quad } from './geometry';

/**
 * Focal length as a share of the frame's long side. A phone's main camera
 * (26 mm equivalent) sees about 69° across the long side: f = 0.5 / tan(34.7°).
 */
export const PHONE_FOCAL_SHARE = 0.72;

export interface CardPose {
  /** The card's own width ÷ height, perspective removed. */
  aspect: number;
  /** Degrees between the card's face and the camera's view: 0 when the phone is straight above it. */
  tilt: number;
}

type Vec3 = [number, number, number];

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3) => Math.sqrt(dot(a, a));

/**
 * The card's pose from its corners in reading order (top-left, top-right,
 * bottom-right, bottom-left), in a frame of the given size. Null when the
 * corners are degenerate.
 */
export function cardPose(corners: Quad, frame: { width: number; height: number }, focalShare = PHONE_FOCAL_SHARE): CardPose | null {
  const focal = focalShare * Math.max(frame.width, frame.height);
  const cx = frame.width / 2;
  const cy = frame.height / 2;
  // Centred on the optical axis and scaled by the focal length: rays through each corner.
  const ray = (p: Point): Vec3 => [(p.x - cx) / focal, (p.y - cy) / focal, 1];
  const m1 = ray(corners[0]);
  const m2 = ray(corners[1]);
  const m4 = ray(corners[2]);
  const m3 = ray(corners[3]);

  const m14 = cross(m1, m4);
  const d2 = dot(cross(m2, m4), m3);
  const d3 = dot(cross(m3, m4), m2);
  if (Math.abs(d2) < 1e-12 || Math.abs(d3) < 1e-12) return null;
  const k2 = dot(m14, m3) / d2;
  const k3 = dot(m14, m2) / d3;
  // Proportional to the card's top edge and left edge as 3D directions in front of the camera.
  const across: Vec3 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const down: Vec3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  const width = norm(across);
  const height = norm(down);
  if (!(width > 0 && height > 0) || !Number.isFinite(width / height)) return null;

  const normal = cross(across, down);
  const length = norm(normal);
  if (!(length > 0)) return null;
  const tilt = (Math.acos(Math.min(1, Math.abs(normal[2]) / length)) * 180) / Math.PI;
  return { aspect: width / height, tilt };
}
