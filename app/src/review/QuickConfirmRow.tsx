/**
 * One waiting review in the Review tab's lists: the user's scan beside the
 * guess, its name, set and number, and (in "looks right") a ✓/✗ toggle on the
 * right edge, where a thumb holding the phone reaches. Tapping the rest opens
 * the card.
 */
import { thumbnailUrl } from '../games/indexClient';
import { printingCode } from './explain';
import type { PlacedReview } from './quickConfirm';
import { useCropUrl } from './ReviewCard';

export function QuickConfirmRow({
  entry,
  lockLabel,
  wrong,
  onToggle,
  onOpen,
}: {
  entry: PlacedReview;
  /** The batch's locked sets, for the "not in …" badge. */
  lockLabel: string;
  /** Marked wrong (only in "looks right", where `onToggle` is given). */
  wrong?: boolean;
  onToggle?: () => void;
  onOpen: () => void;
}) {
  const { review, placement } = entry;
  const crop = useCropUrl(review);
  const printing = placement.printing;
  const name = printing ? (printing.exportName ?? printing.name) : "Couldn't read this card";
  return (
    <li
      className={`flex h-[88px] items-center gap-2 rounded-xl pr-2 pl-1 ${wrong ? 'bg-red-950/70 ring-1 ring-red-500/70' : 'bg-zinc-800/60'}`}
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
          <span className={`truncate text-sm font-medium ${wrong ? 'text-red-200 line-through' : ''}`}>{name}</span>
          {printing && (
            // Where the printing was in doubt (basics, look-alikes), its set and number are what to check.
            <span className={placement.printingInDoubt ? 'font-mono text-base font-semibold text-zinc-100' : 'text-xs text-zinc-400'}>{printingCode(printing)}</span>
          )}
          <span className="flex flex-wrap gap-1">
            {placement.outsideLock && lockLabel && <span className="rounded bg-amber-900/70 px-1.5 text-[11px] text-amber-200">not in {lockLabel}</span>}
            {placement.settledBy === 'user' && <span className="rounded bg-sky-900/70 px-1.5 text-[11px] text-sky-200">you chose this printing</span>}
            {placement.quick && <span className="rounded bg-zinc-700 px-1.5 text-[11px] text-zinc-200">likely right: check first</span>}
            {review.markedWrong && <span className="rounded bg-red-900/70 px-1.5 text-[11px] text-red-200">you marked this guess wrong</span>}
          </span>
        </span>
      </button>
      {onToggle && (
        <button
          type="button"
          aria-pressed={wrong}
          aria-label={wrong ? `Marked wrong: ${name}. Tap to keep it` : `Looks right: ${name}. Tap to mark it wrong`}
          onClick={onToggle}
          className={`flex size-12 flex-none items-center justify-center rounded-full text-xl font-bold ${wrong ? 'bg-red-600 text-white' : 'bg-emerald-700/80 text-white'}`}
        >
          {wrong ? '✗' : '✓'}
        </button>
      )}
    </li>
  );
}
