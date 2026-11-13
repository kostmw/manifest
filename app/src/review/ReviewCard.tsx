/**
 * One scanned card waiting for review: the user's crop beside the chosen
 * candidate, the candidates ranked below, and keyboard shortcuts
 * (1–5 pick, Enter accept, X discard, F foil, +/- quantity, S search).
 */
import { useEffect, useRef, useState } from 'react';
import { thumbnailUrl } from '../games/indexClient';
import { getGame } from '../games/registry';
import type { Printing } from '../games/types';
import { PrintingPicker } from '../search/PrintingPicker';
import { acceptReview, acceptReviews, discardReview, similarReviews } from '../session/reviews';
import { knownIds, logEvent, logPrinting } from '../session/testLog';
import type { Batch, ReviewItem } from '../session/types';
import { UNREADABLE_BELOW } from '../session/intake';
import { BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY } from '../ui/styles';
import { matchNote, printingCode, unreadableHint } from './explain';

const STEPPER = 'flex size-11 items-center justify-center rounded-md bg-zinc-700 text-lg hover:bg-zinc-600';
const KEY = 'hidden rounded border border-zinc-600 px-1 font-mono text-[10px] text-zinc-400 sm:inline';

export type ReviewOutcome = 'accepted' | 'discarded';

/** An object URL for a review's crop, made once per review (the queue hands over fresh copies whenever it changes). */
function useCropUrl(review: ReviewItem): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const bytes = review.crop;
  useEffect(() => {
    if (!bytes) return;
    const next = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [review.id]); // The bytes of a review never change.
  return url;
}

function status(review: ReviewItem, batch: Batch): string {
  switch (review.reason) {
    case 'unreadable':
      return "Couldn't read this card.";
    case 'unsure-name':
      return review.nameConfidence < UNREADABLE_BELOW ? "Couldn't read this card." : 'Not sure. Is it one of these?';
    case 'unsure-printing':
      return 'Recognized the card. Which printing is it?';
    case 'outside-lock': {
      const sets = (batch.settings.lockSets ?? []).map((code) => code.toUpperCase()).join(', ');
      return sets ? `This card isn't from the locked sets (${sets}). Is it one of these?` : 'Is it one of these?';
    }
    case 'check':
      return 'Probably right, but the photo was unclear. Check it.';
  }
}

/** Whether a key press belongs to a text field, so single-key shortcuts must leave it alone. */
function typing(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return Boolean(target?.closest('input:not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"]'));
}

export function ReviewCard({
  batch,
  review,
  pending,
  keyboard = true,
  onResolved,
}: {
  batch: Batch;
  review: ReviewItem;
  /** Every review waiting in the batch, for "apply to all similar". */
  pending: readonly ReviewItem[];
  /** Answer the review queue's single-key shortcuts. */
  keyboard?: boolean;
  onResolved: (outcome: ReviewOutcome) => void;
}) {
  const game = getGame(batch.game);
  const crop = useCropUrl(review);
  const candidates = review.candidates.slice(0, 5);
  const [selected, setSelected] = useState<number | null>(candidates.length > 0 ? 0 : null);
  const [custom, setCustom] = useState<Printing | null>(null);
  /** How the custom printing was found, for the test log: all printings of a name, or a search. */
  const [customVia, setCustomVia] = useState<'printings' | 'search'>('printings');
  const [picking, setPicking] = useState<{ name?: string; searchFirst?: boolean } | null>(null);
  const [foil, setFoil] = useState(review.foil);
  const [qty, setQty] = useState(review.qty);
  const [failed, setFailed] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const chosen = custom ?? (selected !== null ? candidates[selected]?.printing ?? null : null);
  const finish = chosen ? game.defaultFinish(chosen, foil) : null;
  const finishLabel = finish ? (game.finishes.find((choice) => choice.code === finish)?.label ?? finish) : null;
  const similar = chosen ? similarReviews(pending, review, chosen.name) : [];
  const candidateNames = new Set(candidates.map((candidate) => candidate.printing.name));
  // When the name is sure, the title's runners-up are noise: only the printing is in question.
  const otherNames = review.nameConfidence >= 0.9 && review.reason !== 'outside-lock' ? [] : review.names.filter((name) => !candidateNames.has(name));
  const unreadable = review.reason === 'unreadable' || (review.reason === 'unsure-name' && review.nameConfidence < UNREADABLE_BELOW);

  const run = async (action: () => Promise<unknown>, outcome: ReviewOutcome) => {
    try {
      setFailed(false);
      await action();
      onResolved(outcome);
    } catch {
      setFailed(true);
    }
  };
  /** How the chosen printing was found, for the test log. */
  const via = custom ? customVia : `candidate-${(selected ?? 0) + 1}`;
  const accept = () => {
    if (!chosen || !finish) return;
    void run(async () => {
      await acceptReview(batch, review, { printing: chosen, finish, qty });
      logEvent({ type: 'review-accepted', readIds: knownIds(review.scanId), printing: logPrinting(chosen), finish, qty, via });
    }, 'accepted');
  };
  const acceptSimilar = () => {
    if (!chosen) return;
    const all = [review, ...similar];
    void run(
      () =>
        acceptReviews(
          batch,
          all.map((item) => ({
            review: item,
            resolution: {
              printing: chosen,
              finish: game.defaultFinish(chosen, item === review ? foil : item.foil),
              qty: item === review ? qty : item.qty,
            },
          })),
        ),
      'accepted',
    );
    logEvent({
      type: 'review-accepted',
      readIds: knownIds(review.scanId, ...similar.map((item) => item.scanId)),
      printing: logPrinting(chosen),
      via: `${via}, all similar`,
    });
  };
  const discard = () =>
    void run(async () => {
      await discardReview(review.id);
      logEvent({ type: 'review-discarded', readIds: knownIds(review.scanId) });
    }, 'discarded');

  // Enter on one of this card's own buttons (Discard, say) presses that button, as it always does.
  // Anywhere else, a candidate included, it adds the chosen printing.
  const ownButton = (event: KeyboardEvent) => {
    const button = (event.target as HTMLElement | null)?.closest('button, a, summary, label');
    return Boolean(button && sectionRef.current?.contains(button) && !button.hasAttribute('data-candidate'));
  };

  useEffect(() => {
    if (!keyboard || picking) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || typing(event)) return;
      const key = event.key.toLowerCase();
      if (/^[1-5]$/.test(key) && candidates[Number(key) - 1]) {
        setSelected(Number(key) - 1);
        setCustom(null);
      } else if (key === 'enter' && !ownButton(event)) accept();
      else if (key === 'x') discard();
      else if (key === 'f') setFoil((value) => !value);
      else if (key === '+' || key === '=') setQty((value) => value + 1);
      else if (key === '-' || key === '_') setQty((value) => Math.max(1, value - 1));
      else if (key === 's') setPicking({ searchFirst: true });
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <section ref={sectionRef} aria-label="Card to review" className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <figure className="flex flex-col gap-1">
          {crop ? (
            <img src={crop} alt="The card as scanned" className="aspect-[488/680] w-full rounded-lg bg-zinc-800 object-cover" />
          ) : (
            <div className="aspect-[488/680] w-full rounded-lg bg-zinc-800" />
          )}
          <figcaption className="text-xs text-zinc-400">Your scan</figcaption>
        </figure>
        <figure className="flex flex-col gap-1">
          {chosen?.image ? (
            <img
              src={chosen.image}
              alt={`${chosen.name}, ${printingCode(chosen)}`}
              className="aspect-[488/680] w-full rounded-lg bg-zinc-800 object-cover"
            />
          ) : (
            <div className="flex aspect-[488/680] w-full items-center justify-center rounded-lg bg-zinc-800 p-3 text-center text-xs text-zinc-500">
              {chosen ? 'No picture of this printing' : 'Pick a card below'}
            </div>
          )}
          <figcaption className="truncate text-xs text-zinc-400">
            {chosen ? `${chosen.exportName ?? chosen.name} · ${printingCode(chosen)}` : 'Nothing chosen yet'}
          </figcaption>
        </figure>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-sm text-zinc-300">{status(review, batch)}</p>
        {unreadable && (
          <p role="alert" className="text-sm text-amber-300">
            {unreadableHint(review.advice)}
          </p>
        )}
        {review.titleText && (
          <p className="text-xs text-zinc-500">
            Title read as <span className="font-mono">“{review.titleText}”</span>
          </p>
        )}
        {review.collectorText && (
          <p className="text-xs break-all text-zinc-500">
            Collector line read as <span className="font-mono">“{review.collectorText}”</span>
          </p>
        )}
      </div>

      {picking ? (
        <PrintingPicker
          batch={batch}
          name={picking.name}
          searchFirst={picking.searchFirst}
          onChoose={(printing) => {
            setCustom(printing);
            setCustomVia(picking.searchFirst ? 'search' : 'printings');
            setSelected(null);
            setPicking(null);
          }}
          onCancel={() => setPicking(null)}
        />
      ) : (
        <>
          {candidates.length > 0 && (
            <ol aria-label="Candidates" className="flex flex-col gap-2">
              {candidates.map((candidate, index) => {
                const { printing } = candidate;
                const active = !custom && selected === index;
                const note = matchNote(candidate);
                return (
                  <li key={printing.id}>
                    <button
                      type="button"
                      data-candidate
                      aria-pressed={active}
                      aria-label={`Pick ${printing.exportName ?? printing.name}, ${printingCode(printing)}`}
                      onClick={() => {
                        setSelected(index);
                        setCustom(null);
                      }}
                      className={`flex w-full gap-3 rounded-xl p-2 text-left ${active ? 'bg-zinc-700 ring-1 ring-emerald-400/70' : 'bg-zinc-800/60 hover:bg-zinc-700/70'}`}
                    >
                      {printing.image ? (
                        <img src={thumbnailUrl(printing.image)} alt="" loading="lazy" width={52} height={73} className="h-[73px] w-[52px] flex-none rounded bg-zinc-800 object-cover" />
                      ) : (
                        <span className="h-[73px] w-[52px] flex-none rounded bg-zinc-800" />
                      )}
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{printing.exportName ?? printing.name}</span>
                          <span className={KEY}>{index + 1}</span>
                        </span>
                        <span className="truncate text-xs text-zinc-300">{printing.setName}</span>
                        <span className="text-xs text-zinc-400">
                          {printingCode(printing)}
                          {printing.released ? ` · ${printing.released.slice(0, 4)}` : ''}
                        </span>
                        {note && <span className="text-xs text-zinc-500">{note}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          {custom && (
            <p className="text-sm text-emerald-300">
              Chosen: {custom.exportName ?? custom.name} ({printingCode(custom)})
            </p>
          )}
          {otherNames.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-xs text-zinc-500">{unreadable ? 'Closest guesses:' : 'Other names it could be:'}</p>
              <ul aria-label="Other names" className="flex flex-wrap gap-2">
                {otherNames.map((name) => (
                  <li key={name}>
                    <button type="button" onClick={() => setPicking({ name })} className={BUTTON_SECONDARY}>
                      {name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {chosen && (
              <button type="button" onClick={() => setPicking({ name: chosen.name })} className={BUTTON_SECONDARY}>
                All printings of {chosen.exportName ?? chosen.name}
              </button>
            )}
            <button type="button" onClick={() => setPicking({ searchFirst: true })} className={BUTTON_SECONDARY}>
              Search by name <span className={`${KEY} ml-2`}>S</span>
            </button>
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={foil} onChange={(event) => setFoil(event.target.checked)} className="size-5 accent-amber-400" />
          Foil <span className={KEY}>F</span>
        </label>
        {chosen && finishLabel && foil !== game.isFoil(finish!) && (
          <span className="text-xs text-zinc-500">This printing only comes as {finishLabel.toLowerCase()}.</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button type="button" aria-label="One fewer" onClick={() => setQty((value) => Math.max(1, value - 1))} className={STEPPER}>
            −
          </button>
          <span aria-label="Quantity" className="w-8 text-center text-sm tabular-nums">
            {qty}
          </span>
          <button type="button" aria-label="One more" onClick={() => setQty((value) => value + 1)} className={STEPPER}>
            +
          </button>
        </div>
      </div>

      {failed && (
        <p role="alert" className="text-sm text-amber-300">
          Couldn't save that. Your browser's storage may be full.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!chosen} onClick={accept} className={BUTTON_PRIMARY}>
          {chosen ? `Add ${qty > 1 ? `${qty} × ` : ''}${printingCode(chosen)}${finish && finish !== 'nonfoil' ? ` ${finishLabel?.toLowerCase()}` : ''}` : 'Add'}
          <span className={`${KEY} ml-2 border-zinc-800 text-zinc-800`}>Enter</span>
        </button>
        <button type="button" onClick={discard} className={BUTTON_DANGER}>
          Discard <span className={`${KEY} ml-2`}>X</span>
        </button>
        {chosen && similar.length > 0 && (
          <button type="button" onClick={acceptSimilar} className={BUTTON_SECONDARY}>
            Use {printingCode(chosen)} for all {similar.length + 1} {chosen.exportName ?? chosen.name}
          </button>
        )}
      </div>
    </section>
  );
}
