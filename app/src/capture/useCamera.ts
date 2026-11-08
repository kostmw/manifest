import { useCallback, useEffect, useRef, useState } from 'react';
import { CAMERA_CONSTRAINTS, checkCameraAvailability, classifyCameraError, type CameraFailure } from './camera';

export type CameraState =
  | { status: 'idle' }
  | { status: 'requesting' }
  | { status: 'live'; stream: MediaStream }
  | { status: 'failed'; failure: CameraFailure };

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

export function useCamera() {
  const [state, setState] = useState<CameraState>({ status: 'idle' });
  const streamRef = useRef<MediaStream | null>(null);
  // Bumped by every start and stop, so a slow permission prompt that resolves
  // after the user stopped or left can't turn the camera back on.
  const requestRef = useRef(0);

  const release = useCallback(() => {
    requestRef.current += 1;
    if (streamRef.current) stopStream(streamRef.current);
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    release();
    const request = requestRef.current;

    const unavailable = checkCameraAvailability({
      isSecureContext: window.isSecureContext,
      hasGetUserMedia: typeof navigator.mediaDevices?.getUserMedia === 'function',
    });
    if (unavailable) {
      setState({ status: 'failed', failure: unavailable });
      return;
    }

    setState({ status: 'requesting' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
      if (request !== requestRef.current) {
        stopStream(stream);
        return;
      }
      streamRef.current = stream;
      // A revoked permission or an unplugged camera ends the track.
      for (const track of stream.getVideoTracks()) {
        track.addEventListener('ended', () => {
          if (streamRef.current !== stream) return;
          release();
          setState({ status: 'failed', failure: 'unknown' });
        });
      }
      setState({ status: 'live', stream });
    } catch (error) {
      if (request === requestRef.current) setState({ status: 'failed', failure: classifyCameraError(error) });
    }
  }, [release]);

  const stop = useCallback(() => {
    release();
    setState({ status: 'idle' });
  }, [release]);

  useEffect(() => release, [release]);

  return { state, start, stop };
}
