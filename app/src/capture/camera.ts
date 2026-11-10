/** Pure camera helpers: what to request, and how to explain a failure. */

export type CameraFailure = 'insecure' | 'unsupported' | 'denied' | 'no-camera' | 'in-use' | 'unknown';

export const CAMERA_FAILURE_MESSAGES: Record<CameraFailure, string> = {
  insecure: 'The camera only works over HTTPS. Open this page from its https:// address.',
  unsupported: "This browser doesn't support camera access. You can still search for cards by name.",
  denied: 'Camera access is blocked. Allow the camera for this site in your browser settings, then try again.',
  'no-camera': "No camera was found on this device. You can still search for cards by name.",
  'in-use': 'The camera is being used by another app. Close that app, then try again.',
  unknown: "The camera couldn't start. Try again, or reload the page.",
};

/**
 * Ideal rather than exact constraints: phones get the rear camera, and laptops
 * with only a front camera still work. Resolution is capped for throughput
 * (720p unless a phone test asks for 1080p, see ui/debug.ts).
 */
export function cameraConstraints(resolution: 720 | 1080 = 720): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: resolution === 1080 ? 1920 : 1280 },
      height: { ideal: resolution },
      frameRate: { ideal: 30, max: 30 },
    },
  };
}

export function classifyCameraError(error: unknown): CameraFailure {
  const name = (error as { name?: unknown } | null)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'no-camera';
    case 'NotReadableError':
    case 'AbortError':
      return 'in-use';
    default:
      return 'unknown';
  }
}

/** Checked before prompting, so that a dead end gets a specific explanation. */
export function checkCameraAvailability(env: {
  isSecureContext: boolean;
  hasGetUserMedia: boolean;
}): CameraFailure | null {
  if (!env.isSecureContext) return 'insecure';
  if (!env.hasGetUserMedia) return 'unsupported';
  return null;
}
