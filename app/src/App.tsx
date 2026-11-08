import { useState } from 'react';
import { CameraPreview } from './capture/CameraPreview';
import { AddCards } from './search/AddCards';
import { BatchView } from './session/BatchView';
import { useBatches } from './session/useBatches';
import { LegalFooter } from './ui/LegalFooter';

type Tab = 'add' | 'batch' | 'scan';

export function App() {
  const [tab, setTab] = useState<Tab>('add');
  const batches = useBatches();
  const total = batches.items.reduce((sum, item) => sum + item.qty, 0);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'add', label: 'Add cards' },
    { id: 'batch', label: total > 0 ? `Batch (${total})` : 'Batch' },
    { id: 'scan', label: 'Camera' },
  ];

  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col pt-[env(safe-area-inset-top)]">
      <header className="flex items-baseline gap-3 px-4 pt-3 pb-2">
        <h1 className="text-xl font-semibold tracking-tight">Manifest</h1>
        <p className="truncate text-sm text-zinc-400">Scan a stack, get a list.</p>
      </header>
      <nav aria-label="Sections" className="sticky top-0 z-10 flex gap-1 bg-zinc-900 px-4 py-2">
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => setTab(id)}
            className={`min-h-11 flex-1 rounded-lg px-2 text-sm font-medium transition-colors ${
              tab === id ? 'bg-zinc-100 text-zinc-900' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>
      <main className="flex flex-1 flex-col gap-4 px-4 py-3">
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
        {/* The camera is mounted only while visible, so that leaving this tab turns it off. */}
        {tab === 'scan' && (
          <>
            <p className="text-sm text-zinc-400">
              Card recognition isn't built yet, so this is only a preview. For now, add cards by name.
            </p>
            <CameraPreview />
          </>
        )}
      </main>
      <LegalFooter />
    </div>
  );
}
