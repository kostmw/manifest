import { useEffect, type ReactNode, type RefObject } from 'react';
import { CAMERA_FAILURE_MESSAGES } from './camera';
import type { useCamera } from './useCamera';

const BUTTON = 'rounded-lg px-4 py-2.5 text-sm font-medium transition-colors';

export function CameraPreview({
  camera,
  videoRef,
  overlay,
}: {
  camera: ReturnType<typeof useCamera>;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Drawn over the live video, e.g. the outline of a detected card. */
  overlay?: ReactNode;
}) {
  const { state, start, stop } = camera;
  const stream = state.status === 'live' ? state.stream : null;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    return () => {
      video.srcObject = null;
    };
  }, [stream, videoRef]);

  return (
    <section aria-label="Camera" className="flex flex-col gap-3">
      <div className="relative aspect-[3/4] w-full overflow-hidden rounded-xl bg-black sm:aspect-video">
        <video
          ref={videoRef}
          data-testid="camera-video"
          autoPlay
          muted
          playsInline
          className={`h-full w-full object-cover ${stream ? '' : 'hidden'}`}
        />
        {stream && overlay}
        {!stream && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
            {state.status === 'failed' ? (
              <p role="alert" className="max-w-sm text-sm text-amber-300">
                {CAMERA_FAILURE_MESSAGES[state.failure]}
              </p>
            ) : (
              <p className="max-w-sm text-sm text-zinc-400">
                Video stays on this device. Nothing is uploaded.
              </p>
            )}
            <button
              type="button"
              onClick={() => void start()}
              disabled={state.status === 'requesting'}
              className={`${BUTTON} bg-amber-400 text-zinc-950 hover:bg-amber-300 disabled:opacity-60`}
            >
              {state.status === 'requesting'
                ? 'Waiting for permission…'
                : state.status === 'failed'
                  ? 'Try again'
                  : 'Start camera'}
            </button>
          </div>
        )}
      </div>
      {stream && (
        <button type="button" onClick={stop} className={`${BUTTON} self-start bg-zinc-800 hover:bg-zinc-700`}>
          Stop camera
        </button>
      )}
    </section>
  );
}
