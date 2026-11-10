import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { PrintingCandidate } from '../recognize/identify';
import type { FrameOutcome, ScanResult } from '../recognize/recognize.worker';
import { useRecognizer } from '../recognize/useRecognizer';
import { PrintingList, PrintingRow, usePrintings, type Message } from '../search/printings';
import type { Batch } from '../session/types';
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from '../ui/styles';
import { QUALITY_HINTS } from '../vision/quality';
import { CameraPreview } from './CameraPreview';
import { useCamera } from './useCamera';

/** Time between live frames. Detection takes a fraction of it; OCR runs only on steady frames. */
const FRAME_INTERVAL_MS = 120;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function liveHint(frame: FrameOutcome | null): string {
  if (!frame?.corners) return 'Place one card flat in view. A plain background that contrasts with the card works best.';
  const issue = frame.issues[0];
  if (issue) return QUALITY_HINTS[issue];
  return frame.steadyFrames >= 3 ? 'Reading…' : 'Hold still…';
}

function Outline({ frame }: { frame: FrameOutcome | null }) {
  if (!frame?.corners) return null;
  const good = frame.issues.length === 0;
  return (
    // Same scaling as the video's object-cover, so the outline sits on the card.
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox={`0 0 ${frame.frame.width} ${frame.frame.height}`}
      preserveAspectRatio="xMidYMid slice"
    >
      <polygon
        points={frame.corners.map((p) => `${p.x},${p.y}`).join(' ')}
        fill="none"
        stroke={good ? '#34d399' : '#fbbf24'}
        strokeWidth={Math.max(frame.frame.width, frame.frame.height) / 200}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Why a printing was picked, in a few words. */
function matchNote(candidate: PrintingCandidate): string {
  const parts: string[] = [];
  const collector = candidate.collector;
  if (collector?.number === 'exact' && (collector.set === 'exact' || collector.set === 'close')) parts.push('collector number and set match');
  else if (collector?.number === 'exact') parts.push('collector number matches');
  else if (collector?.set === 'exact') parts.push('set matches');
  if (candidate.hashDistance !== null && candidate.hashDistance <= 14) parts.push('artwork matches');
  if (parts.length === 0 && candidate.title >= 0.8) parts.push('name matches');
  return parts.join(', ');
}

function ResultPanel({
  result,
  batch,
  onDone,
  onReadAgain,
  onSearchInstead,
}: {
  result: ScanResult;
  batch: Batch | null;
  onDone: () => void;
  onReadAgain?: () => void;
  onSearchInstead: () => void;
}) {
  const printings = usePrintings(batch?.game ?? 'mtg');
  const [message, setMessage] = useState<Message | null>(null);
  const [cardUrl, setCardUrl] = useState<string | null>(null);
  const top = result.names[0];
  const sure = result.decision === 'accept';
  const identified = result.printings.length > 0;

  useEffect(() => {
    if (!result.card) return;
    const url = URL.createObjectURL(result.card);
    setCardUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [result.card]);

  // Without exact printings, a confident read goes straight to all printings of its name.
  useEffect(() => {
    if (sure && top && !identified) printings.load(top);
  }, [result]); // Once per result, not on every change of the lookup it starts.

  const status = identified
    ? sure
      ? 'Recognized'
      : result.nameConfidence >= 0.9
        ? 'Recognized the card. Which printing is it?'
        : 'Not sure. Is it one of these?'
    : top
      ? sure
        ? 'Recognized'
        : 'Not sure. Is it one of these?'
      : "Couldn't read this card.";

  return (
    <section aria-label="Scan result" className="flex flex-col gap-3 rounded-xl bg-zinc-800/40 p-3">
      <div className="flex gap-3">
        {cardUrl && (
          <img src={cardUrl} alt="The card as scanned" width={122} height={170} className="h-[170px] w-[122px] flex-none rounded-md" />
        )}
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-sm text-zinc-400">
            <span>{status}</span>
            {top && <span className="ml-2 text-xs text-zinc-500">{Math.round(result.confidence * 100)}%</span>}
          </p>
          {result.titleText && (
            <p className="text-xs text-zinc-500">
              Title read as <span className="font-mono">“{result.titleText}”</span>
            </p>
          )}
          {result.collectorText && (
            <p className="text-xs break-all text-zinc-500">
              Collector line read as <span className="font-mono">“{result.collectorText}”</span>
            </p>
          )}
          <ul aria-label="Candidates" className="flex flex-col gap-1">
            {/* A sure printing needs no list of other names; its printings are below. */}
            {(identified && sure ? result.names.slice(0, 1) : result.names).map((name) => (
              <li key={name}>
                <button
                  type="button"
                  aria-label={`Choose ${name}`}
                  onClick={() => printings.load(name)}
                  className={`min-h-11 w-full rounded-lg px-3 py-2 text-left text-sm ${
                    printings.state.status !== 'idle' && printings.state.name === name
                      ? 'bg-zinc-100 text-zinc-900'
                      : 'bg-zinc-800 hover:bg-zinc-700'
                  }`}
                >
                  {name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p aria-live="polite" className={`min-h-5 text-sm ${message?.failed ? 'text-amber-300' : 'text-emerald-300'}`}>
        {message?.text}
      </p>
      {identified && batch && printings.state.status === 'idle' && (
        <div className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">{sure ? 'Best match' : 'Closest printings'}</h2>
          <ul aria-label="Printing candidates" className="flex flex-col gap-2">
            {result.printings.map((candidate, index) => (
              <PrintingRow
                key={candidate.printing.id}
                printing={candidate.printing}
                batch={batch}
                onAdded={setMessage}
                note={matchNote(candidate)}
                highlighted={index === 0 && sure}
              />
            ))}
          </ul>
          <p className="text-xs text-zinc-500">Not here? Choose a name above to see all its printings.</p>
        </div>
      )}
      <PrintingList
        key={printings.state.status === 'idle' ? '' : printings.state.name}
        printings={printings}
        batch={batch}
        onAdded={setMessage}
      />
      <div className="flex flex-wrap gap-2">
        {identified && printings.state.status !== 'idle' && (
          <button type="button" onClick={printings.clear} className={BUTTON_SECONDARY}>
            Back to closest printings
          </button>
        )}
        <button type="button" onClick={onDone} className={BUTTON_PRIMARY}>
          Scan next card
        </button>
        {onReadAgain && (
          <button type="button" onClick={onReadAgain} className={BUTTON_SECONDARY}>
            Read again
          </button>
        )}
        <button type="button" onClick={onSearchInstead} className={BUTTON_SECONDARY}>
          Search by name instead
        </button>
      </div>
    </section>
  );
}

export function Scanner({ batch, onSearchInstead }: { batch: Batch | null; onSearchInstead: () => void }) {
  const recognizer = useRecognizer(batch?.game ?? 'mtg');
  const camera = useCamera();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [frame, setFrame] = useState<FrameOutcome | null>(null);
  const [result, setResult] = useState<{ scan: ScanResult; source: 'live' | 'photo' } | null>(null);
  const [photoState, setPhotoState] = useState<'idle' | 'reading' | 'no-card' | 'failed'>('idle');
  const streaming = camera.state.status === 'live';
  const { live, photo, again } = recognizer;

  useEffect(() => {
    if (recognizer.status !== 'ready' || !streaming || result || photoState === 'reading') return;
    let stopped = false;
    void (async () => {
      while (!stopped) {
        const started = performance.now();
        const video = videoRef.current;
        try {
          const outcome = video ? await live(video) : null;
          if (stopped) break;
          if (outcome) {
            setFrame(outcome);
            if (outcome.result) {
              setResult({ scan: outcome.result, source: 'live' });
              break;
            }
          }
        } catch {
          // A dropped frame is harmless: the next one is a fresh try.
        }
        await sleep(Math.max(0, FRAME_INTERVAL_MS - (performance.now() - started)));
      }
    })();
    return () => {
      stopped = true;
    };
  }, [recognizer.status, streaming, result, photoState, live]);

  const onPhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setResult(null);
    setPhotoState('reading');
    try {
      const outcome = await photo(file);
      if (outcome?.result) {
        setResult({ scan: outcome.result, source: 'photo' });
        setPhotoState('idle');
      } else {
        setPhotoState('no-card');
      }
    } catch {
      setPhotoState('failed');
    }
  };

  return (
    <div className="flex flex-col gap-4">
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

      {result ? (
        <ResultPanel
          result={result.scan}
          batch={batch}
          onDone={() => {
            setResult(null);
            setFrame(null);
          }}
          onReadAgain={
            result.source === 'live'
              ? () => {
                  again();
                  setResult(null);
                }
              : undefined
          }
          onSearchInstead={onSearchInstead}
        />
      ) : (
        <>
          <CameraPreview camera={camera} videoRef={videoRef} overlay={<Outline frame={frame} />} />
          {streaming && recognizer.status === 'ready' && (
            <p role="status" aria-live="polite" className="min-h-5 text-sm text-zinc-300">
              {liveHint(frame)}
            </p>
          )}
        </>
      )}

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
            No card found in that photo. Try one card on a plain background, filling most of the picture.
          </p>
        )}
        {photoState === 'failed' && (
          <p role="alert" className="text-sm text-amber-300">
            That file couldn't be read as an image.
          </p>
        )}
      </div>
    </div>
  );
}
