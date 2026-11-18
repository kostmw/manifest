import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { db } from '../session/db';
import { BUTTON_SECONDARY } from '../ui/styles';
import { filesDone, wasInterrupted, type ImportFailureView, type ImportView } from './importQueue';
import { failureText, headline, nextStep, skippedText, tally, timeLeft } from './importText';
import { imports } from './useImport';

/** Failures listed before "Show all". */
const FAILURES_SHOWN = 30;

function FailureRow({ failure, live }: { failure: ImportFailureView; live: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-zinc-200" title={failure.name}>
          {failure.name}
        </span>
        <span className="block text-xs text-zinc-400">
          {failure.failure === 'repeat'
            ? `${failure.count} of its cards were also in ${failure.other}: the same page twice? They were added again.`
            : `${failure.failure === 'unread' && failure.count ? `${failure.count} ${failure.count === 1 ? 'outline' : 'outlines'}: ` : ''}${failureText(failure.failure, failure.name)}`}
        </span>
      </span>
      {failure.failure === 'repeat' && (
        <>
          <button
            type="button"
            disabled={busy}
            aria-label={`Take the cards of ${failure.name} out`}
            onClick={() => {
              setBusy(true);
              void imports.takeOut(failure.key).finally(() => setBusy(false));
            }}
            className={BUTTON_SECONDARY}
          >
            Take them out
          </button>
          <button
            type="button"
            disabled={busy}
            aria-label={`Keep the cards of ${failure.name}`}
            onClick={() => {
              setBusy(true);
              void imports.keepRepeat(failure.key).finally(() => setBusy(false));
            }}
            className={BUTTON_SECONDARY}
          >
            Keep them
          </button>
        </>
      )}
      {live && failure.canRetry && (
        <button type="button" onClick={() => imports.retry(failure.key)} aria-label={`Retry ${failure.name}`} className={BUTTON_SECONDARY}>
          Retry
        </button>
      )}
      {failure.canReview && (
        <button
          type="button"
          disabled={busy}
          aria-label={`Review ${failure.failure === 'unread' ? `the unread outlines of ${failure.name}` : failure.name} anyway`}
          onClick={() => {
            setBusy(true);
            void imports.reviewAnyway(failure.key).finally(() => setBusy(false));
          }}
          className={BUTTON_SECONDARY}
        >
          {failure.failure === 'unread' && (failure.count ?? 1) > 1 ? 'Review them anyway' : 'Review it anyway'}
        </button>
      )}
    </li>
  );
}

function Failures({ view }: { view: ImportView }) {
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const { failures } = view;
  if (failures.length === 0) return null;
  const reviewable = failures.filter((failure) => failure.canReview).length;
  const shown = all ? failures : failures.slice(0, FAILURES_SHOWN);
  return (
    // Open to begin with; React leaves it as the user sets it after that, since `open` never changes.
    <details className="rounded-lg bg-zinc-900/60 px-3 py-1" open>
      <summary className="flex min-h-11 cursor-pointer items-center text-sm text-amber-300 select-none">
        {failures.length === 1 ? '1 photo to look at' : `${failures.length.toLocaleString('en-US')} photos to look at`}
      </summary>
      <p className="text-xs text-zinc-400">
        No card from these is in the batch, apart from the ones already read from photos of several.
        {reviewable > 0 ? ' “Review it anyway” puts the picture in Review, to name the card by search.' : ''}
      </p>
      {reviewable > 1 && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void imports.reviewAllAnyway().finally(() => setBusy(false));
          }}
          className={`${BUTTON_SECONDARY} mt-2`}
        >
          Review all {reviewable.toLocaleString('en-US')} anyway
        </button>
      )}
      <ul aria-label="Photos to look at" className="divide-y divide-zinc-800">
        {shown.map((failure) => (
          <FailureRow key={failure.key} failure={failure} live={view.live} />
        ))}
      </ul>
      {!all && failures.length > FAILURES_SHOWN && (
        <button type="button" onClick={() => setAll(true)} className={`${BUTTON_SECONDARY} mb-2`}>
          Show all {failures.length.toLocaleString('en-US')}
        </button>
      )}
    </details>
  );
}

/**
 * The bulk import's progress and controls on the Scan tab: what's been read,
 * pause, resume and cancel, the photos that gave no card, and after a reload
 * what finished and how to pick up the rest.
 */
export function ImportPanel({
  view,
  activeBatchId,
  onPickAgain,
  onOpenReview,
}: {
  view: ImportView;
  activeBatchId: string | null;
  /** Opens the photo picker, to pick the photos of a cut-short import again; null while it can't open. */
  onPickAgain: (() => void) | null;
  onOpenReview: () => void;
}) {
  const { job } = view;
  const batch = useLiveQuery(() => db.batches.get(job.batchId), [job.batchId]);
  const ref = useRef<HTMLElement>(null);
  // Into view once, when an import starts: the buttons that start one are further down the page.
  useEffect(() => {
    if (view.live) ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [job.id, view.live]);

  const open = job.state === 'running' || job.state === 'paused';
  const interrupted = wasInterrupted(view);
  const otherBatch = job.batchId !== activeBatchId;
  const done = filesDone(job);
  const step = nextStep(view);
  const left = view.live && job.state === 'running' ? timeLeft(view.remainingMs) : null;

  return (
    <section ref={ref} aria-label="Import" className="flex scroll-mt-16 flex-col gap-2 rounded-xl bg-zinc-800/40 p-3">
      <div role="status" aria-live="polite" className="flex flex-col gap-1">
        <p className="font-semibold text-zinc-100">{headline(view)}</p>
        {otherBatch && batch && <p className="text-sm text-zinc-400">Into {batch.name}</p>}
        <p data-testid="import-tally" className="text-sm text-zinc-300">
          {tally(job)}
        </p>
      </div>
      {open && (
        <progress
          aria-label="Photos read"
          max={Math.max(1, job.total)}
          value={done}
          className="h-2 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-emerald-400 [&::-webkit-progress-bar]:bg-zinc-700 [&::-webkit-progress-value]:bg-emerald-400"
        />
      )}
      {view.live && job.state === 'running' && (
        <p className="truncate text-xs text-zinc-400">
          {view.current ? `Reading ${view.current}` : 'Starting…'}
          {view.perMinute ? ` · ${Math.round(view.perMinute)} a minute` : ''}
          {left ? ` · ${left}` : ''}
        </p>
      )}
      {view.live && view.last && (
        <p className={`truncate text-sm ${view.last.kind === 'added' ? 'text-emerald-300' : 'text-amber-300'}`}>
          {view.last.kind === 'added' ? 'Added' : 'To review:'} {view.last.name ?? 'a card it couldn’t read'}
          {view.last.code ? ` · ${view.last.code}` : ''}
        </p>
      )}
      {view.saveFailed && (
        <p role="alert" className="text-sm text-amber-300">
          Couldn’t save the last card: your browser’s storage may be full. Resume tries that photo again.
        </p>
      )}
      {step && <p className="text-xs text-zinc-400">{step}</p>}

      {view.skippedAtHand > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-300">
          <p className="min-w-0 flex-1">{skippedText(view.skippedAtHand)}</p>
          <button type="button" onClick={() => imports.readSkippedAgain()} className={BUTTON_SECONDARY}>
            Read them again
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {view.live && job.state === 'running' && (
          <button type="button" onClick={() => imports.pause()} className={BUTTON_SECONDARY}>
            Pause
          </button>
        )}
        {view.live && job.state === 'paused' && (
          <button type="button" onClick={() => imports.resume()} className={BUTTON_SECONDARY}>
            Resume
          </button>
        )}
        {view.live && open && (
          <button type="button" onClick={() => imports.cancel()} className={BUTTON_SECONDARY}>
            Cancel import
          </button>
        )}
        {interrupted && !otherBatch && (
          <button type="button" onClick={onPickAgain ?? undefined} disabled={!onPickAgain} className={BUTTON_SECONDARY}>
            Pick the photos again
          </button>
        )}
        {job.cards.review > 0 && !otherBatch && (
          <button type="button" onClick={onOpenReview} className={BUTTON_SECONDARY}>
            Review ›
          </button>
        )}
        {!(view.live && open) && (
          <button type="button" onClick={() => void imports.dismiss()} className={BUTTON_SECONDARY}>
            {interrupted ? 'Forget it' : 'Close'}
          </button>
        )}
      </div>

      <Failures view={view} />
    </section>
  );
}
