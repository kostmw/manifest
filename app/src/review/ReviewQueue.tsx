/**
 * The Review tab: the batch's scanned cards that wait for the user's say, in
 * two lists. Those whose top guess looks right ("quick confirm", see
 * quickConfirm.ts) are added together with one tap, unless marked wrong; those
 * that need a look can be ticked to join them (their guesses are often right
 * too), or opened and looked at one at a time.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { getGame } from '../games/registry';
import type { Printing } from '../games/types';
import { acceptReviewGroup, getReviews, reviewFinish, undoAcceptedGroup, updateReview, type AcceptedGroup } from '../session/reviews';
import { knownIds, logEvent, logPrinting } from '../session/testLog';
import type { Batch, ReviewItem } from '../session/types';
import { cue } from '../ui/feedback';
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from '../ui/styles';
import { printingCode } from './explain';
import { bannerTargets, groupReviews, LOOKS_RIGHT_NAME, type PlacedReview } from './quickConfirm';
import { ReviewCard } from './ReviewCard';
import { QuickConfirmRow } from './QuickConfirmRow';

/** How long "Added N cards" offers its Undo before it gives way (the group stays undoable from the top of the tab). */
const TOAST_MS = 9000;

/** The last group added with "Add N cards", undoable until the next one (or the app reloads), wherever the user went meanwhile. */
let lastGroup: { group: AcceptedGroup; count: number } | null = null;
const groupListeners = new Set<() => void>();
function setLastGroup(next: typeof lastGroup): void {
  lastGroup = next;
  for (const listener of groupListeners) listener();
}
function useLastGroup(batchId: string) {
  const value = useSyncExternalStore(
    (listener) => {
      groupListeners.add(listener);
      return () => groupListeners.delete(listener);
    },
    () => lastGroup,
  );
  return value?.group.batchId === batchId ? value : null;
}

/**
 * Rows marked on screen and not yet sent, per batch: guesses that look right
 * marked wrong, and guesses that need a look ticked for adding. Kept while
 * the app runs, so that leaving the tab and coming back keeps them (QA M6).
 */
type MarkKind = 'wrong' | 'ticked';
let marks: Readonly<Record<MarkKind, ReadonlyMap<string, ReadonlySet<string>>>> = { wrong: new Map(), ticked: new Map() };
const markListeners = new Set<() => void>();
function setMarks(kind: MarkKind, batchId: string, ids: ReadonlySet<string>): void {
  const next = new Map(marks[kind]);
  next.set(batchId, ids);
  marks = { ...marks, [kind]: next };
  for (const listener of markListeners) listener();
}
const EMPTY: ReadonlySet<string> = new Set();
function useMarks(batchId: string) {
  const current = useSyncExternalStore(
    (listener) => {
      markListeners.add(listener);
      return () => markListeners.delete(listener);
    },
    () => marks,
  );
  return { wrong: current.wrong.get(batchId) ?? EMPTY, ticked: current.ticked.get(batchId) ?? EMPTY };
}
function toggleMark(kind: MarkKind, batchId: string, id: string): void {
  const next = new Set(marks[kind].get(batchId) ?? EMPTY);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  setMarks(kind, batchId, next);
}

type View = { kind: 'list' } | { kind: 'one'; order: string[]; currentId: string };

export function ReviewQueue({ batch, startAt, onScan }: { batch: Batch; startAt?: string | null; onScan: () => void }) {
  const reviews = useLiveQuery(() => getReviews(batch.id), [batch.id]);
  const game = getGame(batch.game);
  const [view, setView] = useState<View | null>(startAt ? { kind: 'one', order: [startAt], currentId: startAt } : null);
  const [done, setDone] = useState(0);
  /** Rows of "looks right" marked wrong (they become `markedWrong` when the rest are added), and rows of "needs a look" ticked for adding. */
  const { wrong: marked, ticked } = useMarks(batch.id);
  const [adding, setAdding] = useState(false);
  /** Printings the user just chose for a name, offered for the other reviews of it ("use … for all"). */
  const [choices, setChoices] = useState<Map<string, Printing>>(new Map());
  const [toast, setToast] = useState<{ count: number; key: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const undoable = useLastGroup(batch.id);

  const grouped = useMemo(() => {
    if (!reviews) return null;
    const lockedFor = (review: ReviewItem) => {
      const codes = (review.lockSets ?? batch.settings.lockSets ?? []).map((code) => code.toLowerCase());
      return new Set(game.lockedSets?.(codes) ?? codes);
    };
    return groupReviews(reviews, lockedFor);
  }, [reviews, batch.settings.lockSets, game]);

  // Opening the tab: the lists (both can be added from), or the card the scanner sent here.
  const effective: View | null = (() => {
    if (!grouped || !reviews) return null;
    if (view?.kind === 'one' && reviews.some((review) => review.id === view.currentId)) return view;
    if (view?.kind === 'one') {
      // The card was resolved: on to the next in the order that still waits.
      const next = view.order.find((id) => reviews.some((review) => review.id === id));
      if (next) return { ...view, currentId: next };
    }
    return { kind: 'list' };
  })();

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  if (!reviews || !grouped || !effective) return <p className="text-sm text-zinc-400">Opening the review queue…</p>;

  const banners = [...choices]
    .map(([name, printing]) => ({ name, printing, targets: bannerTargets(reviews, name, printing, marked) }))
    .filter((banner) => banner.targets.length > 0);
  const applyBanner = async (name: string, printing: Printing, targets: readonly ReviewItem[]) => {
    try {
      await Promise.all(targets.map((review) => updateReview(review.id, { chosen: printing })));
      setChoices((current) => {
        const next = new Map(current);
        next.delete(name);
        return next;
      });
    } catch {
      setFailed(true);
    }
  };
  const bannerList = banners.length > 0 && (
    <ul aria-label="Use one printing for all" className="flex flex-col gap-2">
      {banners.map(({ name, printing, targets }) => (
        <li key={name} className="flex flex-wrap items-center gap-2 rounded-xl bg-sky-950/60 p-2 text-sm">
          <button type="button" onClick={() => void applyBanner(name, printing, targets)} className={BUTTON_SECONDARY}>
            Use {printingCode(printing)} for all {targets.length} {printing.exportName ?? printing.name}
          </button>
          <button
            type="button"
            aria-label={`No, keep each ${name} as it is`}
            onClick={() =>
              setChoices((current) => {
                const next = new Map(current);
                next.delete(name);
                return next;
              })
            }
            className="ml-auto size-11 rounded-md text-zinc-400 hover:bg-zinc-800"
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );

  const undoGroup = async () => {
    const current = lastGroup;
    if (!current) return;
    try {
      await undoAcceptedGroup(current.group);
      logEvent({ type: 'bulk-undone', readIds: knownIds(...current.group.entries.map((entry) => entry.review.scanId)) });
      setLastGroup(null);
      setToast(null);
    } catch {
      setFailed(true);
    }
  };
  const addBarShown = effective.kind === 'list' && (grouped.looksRight.length > 0 || grouped.needsLook.some((entry) => ticked.has(entry.review.id)));
  const undoLink = undoable && !toast && (
    <button type="button" onClick={() => void undoGroup()} className={`${BUTTON_SECONDARY} self-start`}>
      Undo adding {undoable.count} {undoable.count === 1 ? 'card' : 'cards'}
    </button>
  );
  const undoBar = toast ? (
    <div
      role="status"
      className={`fixed inset-x-0 z-30 px-4 ${addBarShown || effective.kind === 'one' ? 'bottom-[calc(env(safe-area-inset-bottom)+4.75rem)]' : 'bottom-[calc(env(safe-area-inset-bottom)+0.75rem)]'}`}
    >
      <div className="mx-auto flex max-w-3xl items-center gap-3 rounded-xl bg-zinc-100 p-3 text-sm text-zinc-900 shadow-lg">
        <span className="flex-1">
          Added {toast.count} {toast.count === 1 ? 'card' : 'cards'}
        </span>
        <button type="button" onClick={() => void undoGroup()} className="min-h-11 rounded-lg px-3 font-semibold text-sky-800 hover:bg-zinc-200">
          Undo
        </button>
      </div>
    </div>
  ) : null;

  if (effective.kind === 'one') {
    const current = reviews.find((review) => review.id === effective.currentId)!;
    const order = effective.order.filter((id) => reviews.some((review) => review.id === id));
    const index = Math.max(0, order.indexOf(current.id));
    const go = (id: string) => setView({ kind: 'one', order: effective.order, currentId: id });
    return (
      <div className="flex flex-col gap-3">
        <OneByOneKeys order={order} index={index} go={go} />
        {undoLink}
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setView({ kind: 'list' })} className={BUTTON_SECONDARY}>
            ‹ List
          </button>
          <h2 className="flex-1 text-base font-semibold" data-testid="review-position">
            {index + 1} of {order.length} to review
          </h2>
          <button type="button" aria-label="Previous card" disabled={index === 0} onClick={() => go(order[index - 1]!)} className={BUTTON_SECONDARY}>
            ‹
          </button>
          <button
            type="button"
            aria-label="Next card"
            disabled={index >= order.length - 1}
            onClick={() => go(order[index + 1]!)}
            className={BUTTON_SECONDARY}
          >
            ›
          </button>
        </div>
        {bannerList}
        <ReviewCard
          key={current.id}
          batch={batch}
          review={current}
          stickyActions
          // "Use … for all" never changes a row the user marked wrong.
          pending={reviews.filter((review) => !review.markedWrong && !marked.has(review.id) && review.nameConfidence >= 0.5)}
          onResolved={(_outcome, printing) => {
            setDone((value) => value + 1);
            if (printing) setChoices((choicesNow) => new Map(choicesNow).set(printing.name, printing));
            // Stay at this place in the order: the next card slides into it.
            const rest = order.filter((id) => id !== current.id);
            const next = rest[index] ?? rest[index - 1];
            setView(next ? { kind: 'one', order: rest, currentId: next } : { kind: 'list' });
          }}
        />
        <p className="hidden text-xs text-zinc-500 sm:block">
          Keys: 1–5 pick · Enter add · X discard · F foil · +/− quantity · S search · ←/→ previous and next
        </p>
        {undoBar}
      </div>
    );
  }

  const { looksRight, needsLook } = grouped;
  const tickedRows = needsLook.filter((entry) => ticked.has(entry.review.id) && entry.placement.printing);
  const toAdd = [...looksRight.filter((entry) => !marked.has(entry.review.id)), ...tickedRows];
  const lockLabel = (batch.settings.lockSets ?? []).map((code) => code.toUpperCase()).join(', ');
  const closeMatches = needsLook.filter((entry) => entry.placement.quick && entry.placement.printing);

  const addAll = async () => {
    // A second tap while the first is saving adds nothing, and never replaces the group to undo (QA L-a).
    if (adding || toAdd.length === 0) return;
    const rejected = looksRight.filter((entry) => marked.has(entry.review.id));
    const viaOf = new Map(toAdd.map((entry) => [entry.review.id, ticked.has(entry.review.id) ? 'bulk-ticked' : 'bulk']));
    setAdding(true);
    try {
      setFailed(false);
      const group = await acceptReviewGroup(
        batch,
        toAdd.map(({ review, placement }) => ({
          review,
          resolution: { printing: placement.printing!, finish: reviewFinish(batch, review, placement.printing!), qty: review.qty },
        })),
      );
      await Promise.all(rejected.map(({ review }) => updateReview(review.id, { markedWrong: true })));
      // Only what was really added (a review handled meanwhile, in another tab say, isn't).
      const placed = new Map(toAdd.map((entry) => [entry.review.id, entry.placement]));
      for (const { review } of group.entries) {
        const printing = placed.get(review.id)!.printing!;
        logEvent({
          type: 'review-accepted',
          readIds: knownIds(review.scanId),
          printing: logPrinting(printing),
          finish: reviewFinish(batch, review, printing),
          qty: review.qty,
          via: viaOf.get(review.id)!,
          ...(viaOf.get(review.id) === 'bulk' ? { cutoff: LOOKS_RIGHT_NAME } : {}),
        });
      }
      for (const { review, placement } of rejected) {
        logEvent({ type: 'bulk-rejected', readIds: knownIds(review.scanId), ...(placement.printing ? { printing: logPrinting(placement.printing) } : {}), cutoff: LOOKS_RIGHT_NAME });
      }
      setMarks('wrong', batch.id, EMPTY);
      setMarks('ticked', batch.id, EMPTY);
      if (group.entries.length > 0) {
        const count = group.entries.reduce((sum, entry) => sum + entry.qty, 0);
        setLastGroup({ group, count });
        setToast({ count, key: Date.now() });
        setDone((value) => value + group.entries.length);
        cue('added');
      }
      // Stay on the list, where the cards marked wrong now wait under "needs a look".
      setView({ kind: 'list' });
    } catch {
      setFailed(true);
    } finally {
      setAdding(false);
    }
  };

  const open = (entry: PlacedReview) => setView({ kind: 'one', order: [entry.review.id], currentId: entry.review.id });
  const cardsToAdd = toAdd.reduce((sum, entry) => sum + entry.review.qty, 0);

  if (looksRight.length === 0 && needsLook.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2 rounded-xl bg-zinc-800/40 p-4">
        <p className="text-sm text-zinc-300">{done > 0 ? 'All done: nothing left to review.' : 'Nothing to review.'}</p>
        <p className="text-sm text-zinc-400">Cards the scanner wasn't sure of wait here for you to check.</p>
        {undoLink}
        <button type="button" onClick={onScan} className={BUTTON_SECONDARY}>
          Scan cards
        </button>
        {undoBar}
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-4 ${addBarShown ? 'pb-28' : ''}`}>
      {undoLink}
      {bannerList}
      {failed && (
        <p role="alert" className="text-sm text-amber-300">
          Couldn't save that. Your browser's storage may be full.
        </p>
      )}

      {looksRight.length > 0 && (
        <section aria-label="Looks right" className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">Looks right ({looksRight.length})</h2>
          <p className="text-xs text-zinc-400">Check each guess against your scan. Tap ✗ Wrong on any guess that's wrong, then Add. Tap a card to look closer.</p>
          <ul className="flex flex-col gap-2">
            {looksRight.map((entry) => (
              <QuickConfirmRow
                key={entry.review.id}
                entry={entry}
                lockLabel={lockLabel}
                control={{ kind: 'wrong', pressed: marked.has(entry.review.id) }}
                onToggle={() => toggleMark('wrong', batch.id, entry.review.id)}
                onOpen={() => open(entry)}
              />
            ))}
          </ul>
        </section>
      )}

      {needsLook.length > 0 && (
        <section aria-label="Needs a look" className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">Needs a look ({needsLook.length})</h2>
          <p className="text-xs text-zinc-400">Tick Add on each guess that matches your scan, or tap a card to choose another printing or search.</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setView({ kind: 'one', order: needsLook.map((entry) => entry.review.id), currentId: needsLook[0]!.review.id })}
              className={BUTTON_SECONDARY}
            >
              Check them one by one
            </button>
            {closeMatches.length > 0 && (
              <button
                type="button"
                onClick={() => setMarks('ticked', batch.id, new Set([...ticked, ...closeMatches.map((entry) => entry.review.id)]))}
                className={BUTTON_SECONDARY}
              >
                Tick all close matches ({closeMatches.length})
              </button>
            )}
          </div>
          <ul className="flex flex-col gap-2">
            {needsLook.map((entry) => (
              <QuickConfirmRow
                key={entry.review.id}
                entry={entry}
                lockLabel={lockLabel}
                {...(entry.placement.printing ? { control: { kind: 'tick' as const, pressed: ticked.has(entry.review.id) }, onToggle: () => toggleMark('ticked', batch.id, entry.review.id) } : {})}
                onOpen={() => open(entry)}
              />
            ))}
          </ul>
        </section>
      )}

      {addBarShown && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-zinc-800 bg-zinc-900/95 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
          <div className="mx-auto flex max-w-3xl">
            <button type="button" disabled={toAdd.length === 0 || adding} onClick={() => void addAll()} className={`${BUTTON_PRIMARY} min-h-12 flex-1`}>
              {toAdd.length === 0 ? 'Nothing to add' : `Add ${cardsToAdd} ${cardsToAdd === 1 ? 'card' : 'cards'}`}
            </button>
          </div>
        </div>
      )}
      {undoBar}
    </div>
  );
}

/** Left and right arrows step through the cards looked at one by one. */
function OneByOneKeys({ order, index, go }: { order: readonly string[]; index: number; go: (id: string) => void }) {
  useEffect(() => {
    if (order.length < 2) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.closest('input, textarea, select')) return;
      if (event.key === 'ArrowRight') go(order[Math.min(order.length - 1, index + 1)]!);
      else if (event.key === 'ArrowLeft') go(order[Math.max(0, index - 1)]!);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [order, index, go]);
  return null;
}
