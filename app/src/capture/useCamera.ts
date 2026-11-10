import { useCallback, useEffect, useRef, useState } from 'react';
import { cameraResolution } from '../ui/debug';
import { cameraConstraints, checkCameraAvailability, classifyCameraError, type CameraFailure } from './camera';

export type CameraState =
  | { status: 'idle' }
  | { status: 'requesting' }
  | { status: 'live'; stream: MediaStream }
  | { status: 'failed'; failure: CameraFailure };

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/** The flashlight, where the browser exposes it (Chrome on Android; Safari on iOS 17.4 and later). */
export interface Torch {
  supported: boolean;
  on: boolean;
}

const NO_TORCH: Torch = { supported: false, on: false };

function hasTorch(track: MediaStreamTrack | undefined): boolean {
  const capabilities = track?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
  return capabilities?.torch === true;
}

export function useCamera() {
  const [state, setState] = useState<CameraState>({ status: 'idle' });
  const [torch, setTorch] = useState<Torch>(NO_TORCH);
  const streamRef = useRef<MediaStream | null>(null);
  // Bumped by every start and stop, so a slow permission prompt that resolves
  // after the user stopped or left can't turn the camera back on.
  const requestRef = useRef(0);

  const release = useCallback(() => {
    requestRef.current += 1;
    if (streamRef.current) stopStream(streamRef.current);
    streamRef.current = null;
    setTorch(NO_TORCH);
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
      const stream = await navigator.mediaDevices.getUserMedia(cameraConstraints(cameraResolution()));
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
      // Some phones only report the flashlight once the camera is running.
      const track = stream.getVideoTracks()[0];
      setTorch({ supported: hasTorch(track), on: false });
      setTimeout(() => {
        if (streamRef.current === stream && hasTorch(track)) setTorch((current) => ({ ...current, supported: true }));
      }, 1000);
    } catch (error) {
      if (request === requestRef.current) setState({ status: 'failed', failure: classifyCameraError(error) });
    }
  }, [release]);

  const stop = useCallback(() => {
    release();
    setState({ status: 'idle' });
  }, [release]);

  /**
   * Turns the flashlight on or off. The state shown is the one asked for:
   * iOS 18's getSettings() reports the torch off even while it is on.
   */
  const setTorchOn = useCallback(async (on: boolean) => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      setTorch({ supported: true, on });
    } catch {
      setTorch((current) => ({ ...current, on: false }));
    }
  }, []);

  useEffect(() => release, [release]);

  return { state, start, stop, torch, setTorchOn };
}
