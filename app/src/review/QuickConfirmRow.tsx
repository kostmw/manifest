/**
 * One waiting review in the Review tab's lists: the user's scan beside the
 * guess, its name, set and number, and a control on the right edge, where a
 * thumb holding the phone reaches: in "looks right" a "✗ Wrong" button that
 * fills red when pressed (a green ✓ there read as "confirm" while it marked
 * the card wrong), in "needs a look" an "Add" box, unticked until the user
 * ticks it. Tapping the rest opens the card.
 */
import { thumbnailUrl } from '../games/indexClient';
import { ownNameNote, printingCode, shownName } from './explain';
import type { PlacedReview } from './quickConfirm';
import { useCropUrl } from './ReviewCard';

export function QuickConfirmRow({
  entry,
  lockLabel,
  control,
  onToggle,
  onOpen,
}: {
  entry: PlacedReview;
  /** The batch's locked sets, for the "not in …" badge. */
  lockLabel: string;
  /** The right-edge control: marking a guess that looks right wrong, or ticking one that needs a look for adding. None for a card that couldn't be read. */
  control?: { kind: 'wrong' | 'tick'; pressed: boolean };
  onToggle?: () => void;
  onOpen: () => void;
}) {
  const wrong = control?.kind === 'wrong' && control.pressed;
  const ticked = control?.kind === 'tick' && control.pressed;
  const { review, placement } = entry;
  const crop = useCropUrl(review);
  const printing = placement.printing;
  const name = printing ? shownName(printing) : "Couldn't read this card";
  const own = printing ? ownNameNote(printing) : null;
  return (
    <li
      className={`flex h-[88px] items-center gap-2 rounded-xl pr-2 pl-1 ${wrong ? 'bg-red-950/70 ring-1 ring-red-500/70' : ticked ? 'bg-emerald-950/60 ring-1 ring-emerald-500/60' : 'bg-zinc-800/60'}`}
      data-testid="review-row"
    >
      <button type="button" onClick={onOpen} aria-label={`Open ${name}${printing ? `, ${printingCode(printing)}` : ''}`} className="flex h-full min-w-0 flex-1 items-center gap-2 text-left">
        {crop ? (
          <img src={crop} alt="" className="h-[84px] w-[60px] flex-none rounded bg-zinc-800 object-cover" />
        ) : (
          <span className="h-[84px] w-[60px] flex-none rounded bg-zinc-800" />
        )}
        {printing?.image ? (
          <img src={thumbnailUrl(printing.image)} alt="" loading="lazy" className="h-[84px] w-[60px] flex-none rounded bg-zinc-800 object-cover" />
        ) : (
          <span className="h-[84px] w-[60px] flex-none rounded bg-zinc-800" />
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={`line-clamp-2 text-sm leading-tight font-medium ${wrong ? 'text-red-200 line-through' : ''}`}>{name}</span>
          {own && <span className="truncate text-[11px] text-zinc-400">{own}</span>}
          {printing && (
            // Where the printing was in doubt (basics, look-alikes), its set and number are what to check.
            <span className={`whitespace-nowrap ${placement.printingInDoubt ? 'font-mono text-base font-semibold text-zinc-100' : 'text-xs text-zinc-400'}`}>{printingCode(printing)}</span>
          )}
          <span className="flex flex-wrap gap-1">
            {placement.outsideLock && lockLabel && <span className="rounded bg-amber-900/70 px-1.5 text-[11px] text-amber-200">not in {lockLabel}</span>}
            {placement.settledBy === 'user' && <span className="rounded bg-sky-900/70 px-1.5 text-[11px] text-sky-200">you chose this printing</span>}
            {placement.quick && <span className="rounded bg-zinc-700 px-1.5 text-[11px] text-zinc-200">close match</span>}
            {review.markedWrong && <span className="rounded bg-red-900/70 px-1.5 text-[11px] text-red-200">you marked this guess wrong</span>}
          </span>
        </span>
      </button>
      {control && onToggle && control.kind === 'wrong' && (
        <button
          type="button"
          aria-pressed={wrong}
          aria-label={wrong ? `Marked wrong: ${name}. Tap to keep it` : `Mark ${name} wrong`}
          onClick={onToggle}
          className={`flex h-12 min-w-[4.5rem] flex-none items-center justify-center gap-1 rounded-lg border-2 px-2 text-sm font-semibold ${
            wrong ? 'border-red-500 bg-red-600 text-white' : 'border-zinc-500 text-zinc-200'
          }`}
        >
          ✗ Wrong
        </button>
      )}
      {control && onToggle && control.kind === 'tick' && (
        <button
          type="button"
          role="checkbox"
          aria-checked={ticked}
          aria-label={`Add ${name}${printing ? `, ${printingCode(printing)}` : ''}`}
          onClick={onToggle}
          className={`flex h-12 min-w-[4.5rem] flex-none items-center justify-center gap-1.5 rounded-lg border-2 px-2 text-sm font-semibold ${
            ticked ? 'border-emerald-500 bg-emerald-600 text-white' : 'border-zinc-500 text-zinc-200'
          }`}
        >
          <span aria-hidden="true" className={`flex size-5 items-center justify-center rounded border-2 text-xs ${ticked ? 'border-white' : 'border-zinc-400'}`}>
            {ticked ? '✓' : ''}
          </span>
          Add
        </button>
      )}
    </li>
  );
}
