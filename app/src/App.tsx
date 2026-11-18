import { useState } from 'react';
import { Scanner } from './capture/Scanner';
import { ReviewQueue } from './review/ReviewQueue';
import { AddCards } from './search/AddCards';
import { BatchView } from './session/BatchView';
import { useBatches } from './session/useBatches';
import { LegalFooter } from './ui/LegalFooter';
import { OfflineNotice } from './ui/OfflineStatus';
import { UpdateBanner } from './ui/UpdateBanner';

type Tab = 'add' | 'batch' | 'review' | 'scan';

const TAB_KEY = 'manifest.tab';
/** The tab the app opens on: the last one used, else Scan (mass scanning is the main use). */
function initialTab(): Tab {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    if (saved === 'add' || saved === 'batch' || saved === 'review' || saved === 'scan') return saved;
  } catch {
    // Storage blocked: open on Scan.
  }
  return 'scan';
}

export function App() {
  const [tab, setTabState] = useState<Tab>(initialTab);
  const setTab = (next: Tab) => {
    setTabState(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      // Not remembered; harmless.
    }
  };
  /** The scanned card to show first when the review queue opens from the scanner. */
  const [reviewStart, setReviewStart] = useState<string | null>(null);
  const batches = useBatches();
  const total = batches.items.reduce((sum, item) => sum + item.qty, 0);

  // Short labels, the counts in a badge that is never cut off (a long label hid them: "Review (…").
  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'scan', label: 'Scan', count: 0 },
    { id: 'review', label: 'Review', count: batches.reviewCount },
    { id: 'batch', label: 'Batch', count: total },
    { id: 'add', label: 'Search', count: 0 },
  ];

  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col pt-[env(safe-area-inset-top)]">
      <header className="flex items-baseline gap-3 px-4 pt-3 pb-2">
        <h1 className="text-xl font-semibold tracking-tight">Manifest</h1>
        <p className="truncate text-sm text-zinc-400">Scan a stack, get a list.</p>
      </header>
      <nav aria-label="Sections" className="sticky top-0 z-10 flex gap-1 bg-zinc-900 px-4 py-2">
        {tabs.map(({ id, label, count }) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? 'page' : undefined}
            aria-label={count > 0 ? `${label} (${count})` : label}
            onClick={() => {
              setReviewStart(null);
              setTab(id);
            }}
            className={`flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg px-1 text-sm font-medium transition-colors ${
              tab === id ? 'bg-zinc-100 text-zinc-900' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
            }`}
          >
            <span className="truncate">{label}</span>
            {count > 0 && (
              <span className={`flex-none rounded-full px-1.5 text-xs tabular-nums ${tab === id ? 'bg-zinc-900 text-zinc-100' : 'bg-zinc-600 text-zinc-100'}`}>
                {count > 999 ? '999+' : count}
              </span>
            )}
          </button>
        ))}
      </nav>
      <main className="flex flex-1 flex-col gap-4 px-4 py-3">
        <UpdateBanner />
        <OfflineNotice />
        {batches.storageFailed && (
          <p role="alert" className="rounded-xl bg-amber-950 p-3 text-sm leading-relaxed text-amber-200">
            Your browser is blocking on-device storage, so Manifest can't save cards. Private windows can cause this.
            Try a normal window.
          </p>
        )}
        {/* These two stay mounted so that switching tabs keeps a search in progress. */}
        <div hidden={tab !== 'add'}>
          <AddCards batch={batches.active} />
        </div>
        <div hidden={tab !== 'batch'}>
          <BatchView state={batches} onAddCards={() => setTab('add')} />
        </div>
        {/* Mounted only while visible, so that its single-key shortcuts can't fire from another tab. */}
        {tab === 'review' && batches.active && <ReviewQueue batch={batches.active} startAt={reviewStart} onScan={() => setTab('scan')} />}
        {/* The scanner is mounted only while visible, so that leaving this tab turns the camera off. */}
        {tab === 'scan' && (
          <Scanner
            batch={batches.active}
            cardCount={total}
            reviewCount={batches.reviewCount}
            onOpenReview={(reviewId) => {
              setReviewStart(reviewId ?? null);
              setTab('review');
            }}
          />
        )}
      </main>
      <LegalFooter />
    </div>
  );
}
