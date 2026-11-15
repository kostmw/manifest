import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { FrameOutcome, ScanResult } from '../recognize/recognize.worker';
import { useRecognizer } from '../recognize/useRecognizer';
import { printingCode } from '../review/explain';
import { ReviewCard } from '../review/ReviewCard';
import { intake, UNREADABLE_BELOW } from '../session/intake';
import { getReview, discardReview } from '../session/reviews';
import { logEvent, logFlashlight, logGone, logQuiet, testLogEnabled, type TestLogLive, type TestLogSettings } from '../session/testLog';
import { logOutcome, recordRead } from '../session/testLogRecord';
import type { Batch, ReviewItem } from '../session/types';
import { cameraResolution, debugEnabled, formatTimings, setCameraResolution, setDebugEnabled } from '../ui/debug';
import {
  canVibrate,
  cue,
  dismissSoundTip,
  setSoundMode,
  silentSwitchMatters,
  soundMode,
  soundTipDismissed,
  unlockAudio,
  type SoundMode,
} from '../ui/feedback';
import { BUTTON_SECONDARY } from '../ui/styles';
import { ADVICE_HINTS, QUALITY_HINTS } from '../vision/quality';
import { CameraPreview } from './CameraPreview';
import { countCopiesEnabled, setCountCopiesEnabled } from './copies';
import { copyRecent, pushRecent, removeRecent, undoRecent, useRecentScans, type RecentScan } from './recentScans';
import { ScanSettings } from './ScanSettings';
import { TestLogPanel } from './TestLogPanel';
import { useCamera, type Torch } from './useCamera';
import { useWakeLock } from './useWakeLock';

/** Time between live frames. Detection takes a fraction of it; OCR runs only on steady frames. */
const FRAME_INTERVAL_MS = 120;
/** How long the last card's name stays in the big status line before the live hint returns. */
const LAST_CARD_MS = 4000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function liveHint(frame: FrameOutcome | null, torch: Torch, canCopy = false): string {
  // No outline, or one that holds no card (an empty box's floor).
  if (!frame?.corners || frame.phase === 'empty') return 'Slide a card into view. A plain background that contrasts with the cards works best.';
  const issue = frame.issues[0];
  if (issue === 'too-dark' && torch.supported && !torch.on) return 'Too dark: turn on the flashlight, or add light.';
  // Seen at a steep angle, the far edge is stretched when the card is straightened: it looks
  // blurry however still the phone is.
  if (issue === 'blurry' && frame.advice.includes('tilted')) return ADVICE_HINTS.tilted;
  if (issue) return QUALITY_HINTS[issue];
  // A reflection doesn't stop the read, but it costs the artwork match: say what causes it while
  // the card is lined up (not after, or it would nag on every card when the flashlight is needed).
  if (frame.advice.includes('hotspot') && frame.phase !== 'read') {
    return torch.on ? 'Glare from the flashlight: turn it off, or light the cards from the side.' : ADVICE_HINTS.hotspot;
  }
  // An identical copy put straight on top looks like the same card, so say how to count one.
  if (frame.phase === 'read') {
    return canCopy
      ? 'Next card: put it on top. Another copy of this one: take it away first, or tap +1.'
      : 'Next card: put it on top. Another copy of this one: take it away first.';
  }
  if (frame.advice.includes('tilted')) return ADVICE_HINTS.tilted;
  if (frame.phase !== 'reading') return 'Hold still…';
  return frame.advice.includes('dim') && torch.supported && !torch.on ? 'Reading… More light would help: try the flashlight.' : 'Reading…';
}

/** Frames per second, smoothed. */
function useFrameRate(frame: FrameOutcome | null): number {
  const last = useRef<number | null>(null);
  const [rate, setRate] = useState(0);
  useEffect(() => {
    if (!frame) return;
    const now = performance.now();
    if (last.current !== null) {
      const instant = 1000 / Math.max(1, now - last.current);
      setRate((previous) => (previous ? previous * 0.8 + instant * 0.2 : instant));
    }
    last.current = now;
  }, [frame]);
  return rate;
}

/** Cards per minute over the last few scans, for the debug readout. */
function scanRate(recent: readonly RecentScan[]): number | null {
  if (recent.length < 3) return null;
  const span = recent[0]!.at - recent[recent.length - 1]!.at;
  return span > 0 ? ((recent.length - 1) / span) * 60_000 : null;
}

function LiveDebug({
  frame,
  rate,
  read,
  recent,
  repeats,
}: {
  frame: FrameOutcome | null;
  rate: number;
  read: Record<string, number> | null;
  recent: readonly RecentScan[];
  /** Reads that found the card already counted (glare, shimmer), so counted nothing. */
  repeats: number;
}) {
  if (!frame) return null;
  const metrics = frame.metrics;
  const perMinute = scanRate(recent);
  return (
    <div data-testid="debug-live" className="font-mono text-xs break-words text-zinc-500">
      <p>
        {frame.frame.width}×{frame.frame.height} · {rate.toFixed(1)} fps · {formatTimings(frame.timings)} ms
        {metrics &&
          ` · tilt ${Math.round(metrics.tilt)}° · light ${Math.round(metrics.brightness)} · noise ${metrics.noise.toFixed(1)} · sharp ${Math.round(metrics.sharpness)}` +
            (metrics.hotspot ? ` · glare ${(metrics.hotspot * 100).toFixed(1)}%` : '')}
        {` · ${frame.phase}`}
      </p>
      {read && <p data-testid="debug-read">last read: {formatTimings(read)} ms{perMinute ? ` · ${perMinute.toFixed(0)} cards/min` : ''}</p>}
      {repeats > 0 && <p data-testid="debug-repeats">same card read again, not counted: {repeats}×</p>}
    </div>
  );
}

function Outline({ frame }: { frame: FrameOutcome | null }) {
  if (!frame?.corners) return null;
  const good = frame.issues.length === 0;
  return (
    // Same scaling as the video's object-contain, so the outline sits on the card.
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox={`0 0 ${frame.frame.width} ${frame.frame.height}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <polygon
        points={frame.corners.map((p) => `${p.x},${p.y}`).join(' ')}
        fill="none"
        stroke={frame.phase === 'read' ? '#a1a1aa' : good ? '#34d399' : '#fbbf24'}
        strokeWidth={Math.max(frame.frame.width, frame.frame.height) / 200}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A coloured ring that flashes over the camera: green when a card is added, amber when it needs review. */
function Flash({ flash }: { flash: { kind: RecentScan['kind']; key: number } | null }) {
  if (!flash) return null;
  return (
    <div
      key={flash.key}
      aria-hidden="true"
      data-testid="scan-flash"
      className={`scan-flash pointer-events-none absolute inset-0 rounded-xl ring-[10px] ring-inset ${flash.kind === 'added' ? 'ring-emerald-400' : 'ring-amber-400'}`}
    />
  );
}

function RecentStrip({
  recent,
  onUndo,
  onCopy,
  onOpenReview,
}: {
  recent: readonly RecentScan[];
  onUndo: (entry: RecentScan) => void;
  /** One more copy of the newest card, when it was added. */
  onCopy: (entry: RecentScan) => void;
  onOpenReview: (reviewId?: string) => void;
}) {
  if (recent.length === 0) return null;
  return (
    <ol aria-label="Last cards scanned" className="grid grid-cols-5 gap-2">
      {recent.map((entry, index) => {
        const label = entry.name ?? 'Unreadable card';
        const copyable = index === 0 && entry.kind === 'added' && Boolean(entry.itemId);
        return (
          <li key={entry.id} className="flex min-w-0 flex-col gap-1">
            <button
              type="button"
              onClick={entry.kind === 'review' ? () => onOpenReview(entry.reviewId) : undefined}
              aria-label={entry.kind === 'review' ? `Review ${label}` : `${label}${entry.code ? `, ${entry.code}` : ''}, added`}
              className={`relative overflow-hidden rounded-md ring-2 ${entry.kind === 'added' ? 'ring-emerald-500/70' : 'ring-amber-400/80'}`}
            >
              {entry.thumb ? (
                <img src={entry.thumb} alt="" className="aspect-[488/680] w-full bg-zinc-800 object-cover" />
              ) : (
                <span className="block aspect-[488/680] w-full bg-zinc-800" />
              )}
              <span
                className={`absolute top-1 right-1 flex size-5 items-center justify-center rounded-full text-xs font-bold ${
                  entry.kind === 'added' ? 'bg-emerald-400 text-zinc-950' : 'bg-amber-400 text-zinc-950'
                }`}
              >
                {entry.kind === 'added' ? '✓' : '?'}
              </span>
            </button>
            <p className="truncate text-[11px] leading-tight text-zinc-300" title={label}>
              {label}
            </p>
            <div className="flex gap-1">
              <button
                type="button"
                aria-label={`Undo ${label}`}
                onClick={() => onUndo(entry)}
                className="min-h-9 flex-1 rounded-md bg-zinc-800 text-xs text-zinc-300 hover:bg-zinc-700"
              >
                Undo
              </button>
              {copyable && (
                <button
                  type="button"
                  aria-label={`One more ${label}`}
                  onClick={() => onCopy(entry)}
                  className="min-h-9 flex-1 rounded-md bg-emerald-900/70 text-xs font-semibold text-emerald-100 hover:bg-emerald-800"
                >
                  +1
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const SOUND_LABELS: Record<SoundMode, string> = { off: 'Sound off', on: 'Sound on', always: 'Sound on, even in silent mode' };

export function Scanner({
  batch,
  cardCount,
  reviewCount,
  onOpenReview,
}: {
  batch: Batch | null;
  /** Cards in the batch, for the counter. */
  cardCount: number;
  /** Scanned cards in the batch waiting for review. */
  reviewCount: number;
  /** Go to the review queue, at this card when given. */
  onOpenReview: (reviewId?: string) => void;
}) {
  const [copies, setCopies] = useState(() => countCopiesEnabled());
  const recognizer = useRecognizer(batch?.game ?? 'mtg', batch?.settings.lockSets ?? [], copies);
  const { cameraChanged } = recognizer;
  // The camera re-exposes when the flashlight switches: live mode holds the card in view meanwhile.
  const camera = useCamera(
    useCallback(
      (on: boolean, done: boolean) => {
        cameraChanged();
        if (done) logFlashlight(on);
      },
      [cameraChanged],
    ),
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const [frame, setFrame] = useState<FrameOutcome | null>(null);
  const [lastRead, setLastRead] = useState<Record<string, number> | null>(null);
  const [repeats, setRepeats] = useState(0);
  const [last, setLast] = useState<{ entry: RecentScan } | null>(null);
  const [flash, setFlash] = useState<{ kind: RecentScan['kind']; key: number } | null>(null);
  const [photoReview, setPhotoReview] = useState<{ review: ReviewItem; debug: string } | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [debug, setDebug] = useState(() => debugEnabled());
  const [sharper, setSharper] = useState(() => cameraResolution() === 1080);
  const [sound, setSound] = useState<SoundMode>(() => soundMode());
  const [tipDismissed, setTipDismissed] = useState(() => soundTipDismissed());
  // Bumped when the last card's line should give way to the live hint again.
  const [, setTick] = useState(0);
  const rate = useFrameRate(frame);
  const recent = useRecentScans(batch?.id ?? null);
  const [photoState, setPhotoState] = useState<'idle' | 'reading' | 'no-card' | 'failed'>('idle');
  const streaming = camera.state.status === 'live';
  useWakeLock(streaming);
  const { live, photo, again } = recognizer;
  const photoReviewRef = useRef<HTMLElement>(null);
  const photoReviewId = photoReview?.review.id;
  // Bring a photo's review into view once, when it appears.
  useEffect(() => {
    if (photoReviewId) photoReviewRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [photoReviewId]);
  // The loop outlives renders; it reads the batch (and its settings) from here.
  const batchRef = useRef(batch);
  batchRef.current = batch;

  // The camera's flashlight, for the test log's settings.
  const torchRef = useRef(camera.torch.on);
  torchRef.current = camera.torch.on;
  /** The settings a scan was made with, for the test log. */
  const logSettings = useCallback((target: Batch): TestLogSettings => ({
    camera: cameraResolution(),
    flashlight: torchRef.current,
    lockSets: target.settings.lockSets ?? [],
    foil: target.settings.foil === true,
    lang: target.settings.defaultLang,
    condition: target.settings.defaultCondition,
    sound: soundMode(),
  }), []);

  /** A read of the card already counted (glare, shimmer): nothing is filed, but the test log keeps it. */
  const logRepeat = useCallback((repeat: { result: ScanResult; why: string }, timings: Record<string, number>, live: TestLogLive | null) => {
    const target = batchRef.current;
    if (!target || !testLogEnabled()) return;
    void recordRead({
      id: crypto.randomUUID(),
      source: 'live',
      scan: repeat.result,
      outcome: logOutcome({ kind: 'same-card', why: repeat.why }),
      settings: logSettings(target),
      timings,
      live,
    });
  }, [logSettings]);

  /** The last card live mode filed: a much surer re-read of it may stand in for it. */
  const lastLiveRef = useRef<RecentScan | null>(null);

  /**
   * Files a scanned card: into the batch or the review queue, with sound,
   * vibration and a flash. `replaces`: the scan id of the read it stands in for.
   */
  const file = useCallback(async (scan: ScanResult, source: 'live' | 'photo', timings: Record<string, number>, live: TestLogLive | null = null, replaces?: string) => {
    const target = batchRef.current;
    if (!target) return null;
    try {
      const scanId = crypto.randomUUID();
      const outcome = await intake(target, scan, source, scanId);
      if (testLogEnabled()) void recordRead({ id: scanId, source, scan, outcome: logOutcome(outcome), settings: logSettings(target), timings, live });
      if (replaces) logEvent({ type: 'replaced', readIds: [replaces, scanId] });
      const best = scan.printings[0]?.printing;
      const sure = scan.nameConfidence >= UNREADABLE_BELOW;
      const entry = pushRecent({
        batchId: target.id,
        kind: outcome.kind === 'added' ? 'added' : 'review',
        source,
        name: outcome.kind === 'added' ? (outcome.printing.exportName ?? outcome.printing.name) : sure ? (scan.names[0] ?? null) : null,
        code: outcome.kind === 'added' ? printingCode(outcome.printing) : best && sure ? printingCode(best) : null,
        ...(outcome.kind === 'added' ? { itemId: outcome.itemId } : { reviewId: outcome.review.id }),
        scanId,
        card: scan.card,
      });
      if (source === 'live') lastLiveRef.current = entry;
      setLast({ entry });
      setFlash((previous) => ({ kind: entry.kind, key: (previous?.key ?? 0) + 1 }));
      setSaveFailed(false);
      cue(entry.kind);
      return outcome;
    } catch {
      setSaveFailed(true);
      return null;
    }
  }, [logSettings]);

  /**
   * The card already counted, read again much more surely than the read it was
   * counted as (round 10: a foil Constable Odo stayed a junk review while a
   * re-read named it at 0.90): that review, if it still waits, is taken out and
   * the new read filed in its place, added if it clears the bar.
   */
  const upgrade = useCallback(async (repeat: { result: ScanResult; why: string }, timings: Record<string, number>, live: TestLogLive | null) => {
    const previous = lastLiveRef.current;
    const target = batchRef.current;
    const waiting = previous?.kind === 'review' && previous.reviewId && previous.batchId === target?.id ? await getReview(previous.reviewId) : undefined;
    if (!previous || !waiting) {
      logRepeat(repeat, timings, live);
      return;
    }
    await discardReview(waiting.id);
    removeRecent(previous.id);
    await file(repeat.result, 'live', timings, live, previous.scanId);
  }, [file, logRepeat]);

  // The frame the worker is working on, if any: a loop started while it is still being read waits for it.
  const inFlightRef = useRef<Promise<unknown> | null>(null);
  useEffect(() => {
    if (recognizer.status !== 'ready' || !streaming || photoState === 'reading') return;
    let stopped = false;
    void (async () => {
      // A loop stopped by a re-render may still have a frame being read: never read two at once.
      await inFlightRef.current;
      while (!stopped) {
        const started = performance.now();
        const video = videoRef.current;
        try {
          const call = video ? live(video) : Promise.resolve(null);
          inFlightRef.current = call.catch(() => null);
          const outcome = await call;
          // A read card is filed even when this loop has been stopped meanwhile: the worker has counted it.
          if (outcome?.result) {
            setLastRead(outcome.timings);
            void file(outcome.result, 'live', outcome.timings, outcome.liveRead ?? null);
          } else if (outcome?.sameCard) {
            setLastRead(outcome.timings);
            setRepeats((count) => count + 1);
            if (outcome.repeat && outcome.upgrade) void upgrade(outcome.repeat, outcome.timings, outcome.liveRead ?? null);
            else if (outcome.repeat) logRepeat(outcome.repeat, outcome.timings, outcome.liveRead ?? null);
          }
          if (outcome?.quiet) logQuiet(outcome.quiet.ms, outcome.quiet.frames, outcome.quiet.summary);
          if (outcome?.gone) logGone(outcome.gone.card, outcome.gone.moved, outcome.gone.frames);
          if (stopped) break;
          // A dropped frame (another was still being read) has nothing to show.
          if (outcome && !outcome.busy) setFrame(outcome);
        } catch {
          // A dropped frame is harmless: the next one is a fresh try.
        }
        await sleep(Math.max(0, FRAME_INTERVAL_MS - (performance.now() - started)));
      }
    })();
    return () => {
      stopped = true;
    };
  }, [recognizer.status, streaming, photoState, live, file, logRepeat, upgrade]);

  // The big status line shows the last card for a few seconds, then the live hint again.
  useEffect(() => {
    if (!last) return;
    const timer = setTimeout(() => setTick((tick) => tick + 1), LAST_CARD_MS + 50);
    return () => clearTimeout(timer);
  }, [last]);

  const onPhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (!chosen) return;
    unlockAudio();
    setPhotoReview(null);
    setPhotoState('reading');
    try {
      const outcome = await photo(chosen);
      if (outcome?.result) {
        setLastRead(outcome.timings);
        const filed = await file(outcome.result, 'photo', outcome.timings);
        if (filed?.kind === 'review') {
          setPhotoReview({
            review: filed.review,
            debug: `${formatTimings(outcome.timings)} ms · confidence ${outcome.result.confidence.toFixed(2)} (name ${outcome.result.nameConfidence.toFixed(2)})`,
          });
        }
        setPhotoState('idle');
      } else {
        setPhotoState('no-card');
      }
    } catch {
      setPhotoState('failed');
    }
  };

  const undo = (entry: RecentScan) => {
    if (photoReview && entry.reviewId === photoReview.review.id) setPhotoReview(null);
    if (last?.entry.id === entry.id) setLast(null);
    void undoRecent(entry).catch(() => setSaveFailed(true));
  };

  /** "+1": one more copy of the card just added, with the same sound and flash as a scan. */
  const copy = (entry: RecentScan) => {
    void copyRecent(entry).then(
      (added) => {
        if (!added) return;
        setLast({ entry: added });
        setFlash((previous) => ({ kind: 'added', key: (previous?.key ?? 0) + 1 }));
        cue('added');
      },
      () => setSaveFailed(true),
    );
  };

  /** "Wrong? Read again": take the last live card back out and read the card in view afresh. */
  const readAgain = () => {
    const newest = recent[0];
    if (newest?.source === 'live') undo(newest);
    again();
  };

  const showingLast = last && last.entry.batchId === batch?.id && performance.now() - last.entry.at < LAST_CARD_MS;
  const total = cardCount + reviewCount;
  const newestLive = recent[0]?.source === 'live' ? recent[0] : null;

  return (
    // Any tap here may unlock sound: browsers only allow audio that a tap started. A touch counts
    // as one when it ends (pointerup), not when it starts.
    <div className="flex flex-col gap-3" onPointerUp={unlockAudio} onKeyDown={unlockAudio}>
      {recognizer.status === 'loading' && (
        <p role="status" className="text-sm text-zinc-400">
          Getting the card reader ready. The first time, this downloads about 3 MB.
        </p>
      )}
      {recognizer.status === 'error' && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-amber-300">
          <p>The card reader couldn't start. Check your connection and try again.</p>
          <button type="button" onClick={recognizer.retry} className={BUTTON_SECONDARY}>
            Try again
          </button>
        </div>
      )}

      {batch && <ScanSettings batch={batch} />}

      <div className="flex items-end gap-3">
        <p className="flex items-baseline gap-2">
          <span data-testid="scan-counter" className={`text-5xl font-bold tabular-nums ${flash ? 'scan-bump' : ''}`} key={flash?.key}>
            {total}
          </span>
          <span className="text-sm text-zinc-400">
            card{total === 1 ? '' : 's'} in {batch?.name ?? 'this batch'}
          </span>
        </p>
        {reviewCount > 0 && (
          <button type="button" onClick={() => onOpenReview()} className="ml-auto min-h-11 rounded-lg bg-amber-400/15 px-3 text-sm font-medium text-amber-300 hover:bg-amber-400/25">
            {reviewCount} to review ›
          </button>
        )}
      </div>

      <CameraPreview
        camera={camera}
        videoRef={videoRef}
        onStart={unlockAudio}
        overlay={
          <>
            <Outline frame={frame} />
            <Flash flash={flash} />
          </>
        }
        controls={
          <button
            type="button"
            aria-label={SOUND_LABELS[sound]}
            onClick={() => {
              const next: SoundMode = sound === 'off' ? 'on' : 'off';
              setSoundMode(next);
              setSound(next);
              unlockAudio();
            }}
            className={`${BUTTON_SECONDARY}`}
          >
            {sound === 'off' ? 'Sound off' : 'Sound on'}
          </button>
        }
      />

      {/* Once, after the first card: the silent switch mutes the beeps, and the way round it is tucked away. */}
      {streaming && recent.length > 0 && sound === 'on' && !tipDismissed && silentSwitchMatters() && (
        <aside aria-label="Sound tip" className="flex flex-col gap-2 rounded-xl bg-zinc-800/60 p-3 text-sm text-zinc-200">
          <p>No beep? Your phone’s silent switch may be on. Manifest can beep anyway, though that pauses music.</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setSoundMode('always');
                setSound('always');
                unlockAudio();
                dismissSoundTip();
                setTipDismissed(true);
              }}
              className={BUTTON_SECONDARY}
            >
              Beep even in silent mode
            </button>
            <button
              type="button"
              onClick={() => {
                dismissSoundTip();
                setTipDismissed(true);
              }}
              className={BUTTON_SECONDARY}
            >
              I hear it
            </button>
          </div>
        </aside>
      )}

      <div className="flex min-h-16 flex-col gap-1" role="status" aria-live="polite">
        {showingLast ? (
          <p className={`text-xl font-semibold ${last.entry.kind === 'added' ? 'text-emerald-300' : 'text-amber-300'}`}>
            {last.entry.kind === 'added'
              ? `Added ${last.entry.name}${last.entry.code ? ` · ${last.entry.code}` : ''}`
              : last.entry.name
                ? `Check later: ${last.entry.name}?`
                : "Couldn't read that one: it's waiting in Review"}
          </p>
        ) : (
          streaming && recognizer.status === 'ready' && <p className="text-base text-zinc-200">{liveHint(frame, camera.torch, recent[0]?.kind === 'added')}</p>
        )}
        {showingLast && streaming && <p className="text-sm text-zinc-400">{liveHint(frame, camera.torch, recent[0]?.kind === 'added')}</p>}
      </div>
      {saveFailed && (
        <p role="alert" className="text-sm text-amber-300">
          Couldn't save the last card. Your browser's storage may be full or blocked.
        </p>
      )}
      {!batch && <p className="text-sm text-amber-300">Cards can't be saved until on-device storage works.</p>}

      <RecentStrip recent={recent} onUndo={undo} onCopy={copy} onOpenReview={onOpenReview} />
      {streaming && newestLive && frame?.phase === 'read' && (
        <button type="button" onClick={readAgain} className={`${BUTTON_SECONDARY} self-start`}>
          Wrong? Read this card again
        </button>
      )}
      {streaming && debug && <LiveDebug frame={frame} rate={rate} read={lastRead} recent={recent} repeats={repeats} />}

      <div className="flex flex-col gap-2">
        <label className={`${BUTTON_SECONDARY} self-start ${recognizer.status === 'ready' ? 'cursor-pointer' : 'pointer-events-none opacity-60'}`}>
          Scan a photo
          <input
            type="file"
            accept="image/*"
            aria-label="Scan a photo"
            className="sr-only"
            disabled={recognizer.status !== 'ready'}
            onChange={(event) => void onPhoto(event)}
          />
        </label>
        {photoState === 'reading' && <p className="text-sm text-zinc-400">Reading the photo…</p>}
        {photoState === 'no-card' && (
          <p role="alert" className="text-sm text-amber-300">
            Couldn't find a card in that photo. Its edges need to stand out: photograph one card on a plain background
            that contrasts with it, with the card in the middle and a little space around it.
          </p>
        )}
        {photoState === 'failed' && (
          <p role="alert" className="text-sm text-amber-300">
            That file couldn't be read as an image.
          </p>
        )}
        {!photoReview && debug && lastRead && !streaming && (
          <p data-testid="debug-result" className="font-mono text-xs break-words text-zinc-500">
            {formatTimings(lastRead)} ms
          </p>
        )}
      </div>

      {photoReview && batch && (
        <section
          aria-label="Scan result"
          ref={photoReviewRef}
          className="flex scroll-mt-16 flex-col gap-3 rounded-xl bg-zinc-800/40 p-3"
        >
          <ReviewCard
            batch={batch}
            review={photoReview.review}
            pending={[]}
            keyboard={false}
            onResolved={() => {
              const entry = recent.find((candidate) => candidate.reviewId === photoReview.review.id);
              if (entry) removeRecent(entry.id);
              setPhotoReview(null);
            }}
          />
          <button type="button" onClick={() => setPhotoReview(null)} className={`${BUTTON_SECONDARY} self-start`}>
            Later: keep it in Review
          </button>
          {debug && (
            <p data-testid="debug-result" className="font-mono text-xs break-words text-zinc-500">
              {photoReview.debug}
            </p>
          )}
        </section>
      )}

      <section aria-label="Sound" className="flex flex-col gap-1 text-xs text-zinc-500">
        <label className="flex min-h-11 items-center gap-2">
          Sound
          <select
            value={sound}
            onChange={(event) => {
              const next = event.target.value as SoundMode;
              setSoundMode(next);
              setSound(next);
              unlockAudio();
            }}
            className="min-h-9 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100"
          >
            <option value="on">On (the silent switch mutes it)</option>
            <option value="always">On, even in silent mode (pauses music)</option>
            <option value="off">Off</option>
          </select>
        </label>
        <p>
          A high beep means the card was added; two lower notes mean it waits for review.
          {canVibrate() ? ' The phone also vibrates.' : ' This browser can’t vibrate (iPhones can’t from a web page), so the frame flashes instead.'}
        </p>
      </section>

      <section aria-label="Counting" className="flex flex-col gap-1 text-xs text-zinc-500">
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={copies}
            onChange={(event) => {
              setCountCopiesEnabled(event.target.checked);
              setCopies(event.target.checked);
            }}
          />
          Count a copy put straight on top (testing)
        </label>
        <p>
          Off: an identical copy counts once the card under it was taken away or covered by your hand for a moment, or
          with +1. On: putting it straight on top counts too, but nudging a card may then count it again.
        </p>
      </section>

      {/* For phone tests: a home-screen app has no address bar for ?debug=1. */}
      <details className="text-xs text-zinc-500">
        <summary className="flex min-h-11 cursor-pointer items-center select-none">Debugging</summary>
        <div className="mt-1 flex flex-col gap-2">
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              checked={debug}
              onChange={(event) => {
                setDebugEnabled(event.target.checked);
                setDebug(event.target.checked);
              }}
            />
            Show timings
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              checked={sharper}
              onChange={(event) => {
                setCameraResolution(event.target.checked ? 1080 : 720);
                setSharper(event.target.checked);
              }}
            />
            Sharper camera (1080p; slower, applies when the camera next starts)
          </label>
          <TestLogPanel />
        </div>
      </details>
    </div>
  );
}
