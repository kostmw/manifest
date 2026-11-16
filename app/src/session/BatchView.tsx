import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { canShare, downloadText, shareText } from '../export/deliver';
import { ExportPanel } from '../export/ExportPanel';
import { getGame } from '../games/registry';
import { PrintingPicker } from '../search/PrintingPicker';
import { BUTTON_DANGER, BUTTON_SECONDARY, FIELD, LABEL } from '../ui/styles';
import { backupFileName, BackupError, createBackup, parseBackup, restoreBackup } from './backup';
import {
  changeItemPrinting,
  changeQuantity,
  createBatch,
  deleteBatch,
  mergeBatches,
  removeItem,
  restoreItem,
  updateBatch,
  updateBatchSettings,
  updateItem,
} from './batches';
import { logEvent, logPrinting } from './testLog';
import type { Batch, BatchItem } from './types';
import type { BatchesState } from './useBatches';

// 16 px on phones: iOS zooms in on fields with smaller text.
const SMALL_FIELD = 'min-h-11 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-base text-zinc-100 sm:text-sm';
const STEPPER = 'flex size-11 items-center justify-center rounded-md bg-zinc-700 text-lg hover:bg-zinc-600';

/**
 * One batch row, compact: name, set and number, and the quantity. Finish,
 * language, condition, Change printing and Remove open with Edit (each row
 * was about 200 px tall, so Export was 25 screens down a 95-card batch).
 * Removing a row, or its last copy, can be undone (`onRemoved`).
 */
function ItemRow({ item, batch, onRemoved }: { item: BatchItem; batch: Batch; onRemoved: (item: BatchItem) => void }) {
  const game = batch.game;
  const adapter = getGame(game);
  const [changing, setChanging] = useState(false);
  const [editing, setEditing] = useState(false);
  const { printing } = item;
  const name = printing.exportName ?? printing.name;
  // The name printed on the card, when it isn't its own (exports keep its own).
  const shown = printing.printedName ?? name;
  const code = `${printing.set.toUpperCase()} ${printing.number}`;

  return (
    <li className="flex flex-col gap-2 rounded-xl bg-zinc-800/60 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={editing}
          aria-label={`Edit ${name}`}
          onClick={() => setEditing((open) => !open)}
          className="flex min-w-0 flex-1 flex-col items-start text-left"
        >
          <span className="line-clamp-2 text-sm leading-tight font-medium">{shown}</span>
          {shown !== name && <span className="truncate text-[11px] text-zinc-400">{name}</span>}
          <span className="flex w-full min-w-0 items-baseline gap-1 text-xs text-zinc-400">
            <span className="truncate">
              <span className="whitespace-nowrap">{code}</span> · {printing.setName}
              {item.finish !== 'nonfoil' ? ` · ${adapter.finishes.find((choice) => choice.code === item.finish)?.label ?? item.finish}` : ''}
            </span>
            <span aria-hidden="true" className="ml-auto flex-none text-zinc-300">
              Edit {editing ? '▾' : '▸'}
            </span>
          </span>
        </button>
        <div className="flex flex-none items-center gap-1">
          <button
            type="button"
            aria-label={`One fewer ${name}`}
            onClick={() => void changeQuantity(item.id, -1).then(() => (item.qty <= 1 ? onRemoved(item) : undefined))}
            className={STEPPER}
          >
            −
          </button>
          <span aria-label={`Quantity of ${name}`} className="w-8 text-center text-sm tabular-nums">
            {item.qty}
          </span>
          <button
            type="button"
            aria-label={`One more ${name}`}
            onClick={() => void changeQuantity(item.id, 1)}
            className={STEPPER}
          >
            +
          </button>
        </div>
      </div>
      {editing && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={`Finish of ${name}`}
            value={item.finish}
            onChange={(event) => void updateItem(item.id, { finish: event.target.value })}
            className={SMALL_FIELD}
          >
            {adapter.finishes
              .filter((choice) => printing.finishes.includes(choice.code) || choice.code === item.finish)
              .map((choice) => (
                <option key={choice.code} value={choice.code}>
                  {choice.label}
                </option>
              ))}
          </select>
          <select
            aria-label={`Language of ${name}`}
            value={item.lang}
            onChange={(event) => void updateItem(item.id, { lang: event.target.value })}
            className={SMALL_FIELD}
          >
            {/* A printing's own rare language, such as Phyrexian, stays selectable. */}
            {!adapter.languages.some((choice) => choice.code === item.lang) && (
              <option value={item.lang}>{item.lang}</option>
            )}
            {adapter.languages.map((choice) => (
              <option key={choice.code} value={choice.code}>
                {choice.label}
              </option>
            ))}
          </select>
          <select
            aria-label={`Condition of ${name}`}
            value={item.condition}
            onChange={(event) => void updateItem(item.id, { condition: event.target.value })}
            className={SMALL_FIELD}
          >
            {adapter.conditions.map((choice) => (
              <option key={choice.code} value={choice.code}>
                {choice.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label={`Change printing of ${name}`}
            aria-expanded={changing}
            onClick={() => setChanging((open) => !open)}
            className="ml-auto min-h-11 rounded-md px-2 text-sm text-zinc-300 hover:text-zinc-100"
          >
            Change printing
          </button>
          <button
            type="button"
            aria-label={`Remove ${name}`}
            onClick={() => void removeItem(item.id).then(() => onRemoved(item))}
            className="min-h-11 rounded-md px-2 text-sm text-zinc-400 hover:text-red-300"
          >
            Remove
          </button>
        </div>
      )}
      {changing && (
        <PrintingPicker
          batch={batch}
          name={printing.name}
          onChoose={(chosen) => {
            setChanging(false);
            void changeItemPrinting(item, chosen, game).then(() =>
              logEvent({ type: 'printing-changed', readIds: item.scanIds ?? [], printing: logPrinting(chosen), from: logPrinting(item.printing) }),
            );
          }}
          onCancel={() => setChanging(false)}
        />
      )}
    </li>
  );
}

/** Merge, back up and restore: housekeeping for all batches. */
function ManageBatches({ state, batch }: { state: BatchesState; batch: Batch }) {
  const others = state.batches.filter((candidate) => candidate.id !== batch.id);
  const [mergeFrom, setMergeFrom] = useState('');
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const source = others.find((candidate) => candidate.id === mergeFrom) ?? others[0];

  const merge = async () => {
    if (!source) return;
    if (!window.confirm(`Move every card from “${source.name}” into “${batch.name}”, and delete “${source.name}”?`)) return;
    try {
      await mergeBatches(source.id, batch.id);
      setMergeFrom('');
      setMessage({ text: `Merged “${source.name}” into “${batch.name}”.`, failed: false });
    } catch {
      setMessage({ text: "Couldn't merge the batches.", failed: true });
    }
  };

  const backup = async (share: boolean) => {
    try {
      const text = JSON.stringify(await createBackup());
      const fileName = backupFileName();
      if (share) {
        if (await shareText(fileName, text, 'application/json')) setMessage({ text: 'Backup shared.', failed: false });
      } else {
        downloadText(fileName, text, 'application/json');
        setMessage({ text: `Saved ${fileName}.`, failed: false });
      }
    } catch {
      setMessage({ text: "Couldn't make the backup.", failed: true });
    }
  };

  const restore = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const parsed = parseBackup(await file.text());
      const cards = parsed.batches.reduce((sum, b) => sum + b.items.reduce((n, item) => n + item.qty, 0), 0);
      const what = `${parsed.batches.length} batch${parsed.batches.length === 1 ? '' : 'es'} with ${cards} card${cards === 1 ? '' : 's'}`;
      if (!window.confirm(`Restore ${what} from ${file.name}? Nothing here is overwritten.`)) return;
      const summary = await restoreBackup(parsed);
      setMessage({
        text:
          `Restored ${summary.batches} batch${summary.batches === 1 ? '' : 'es'}, ${summary.cards} card${summary.cards === 1 ? '' : 's'} and ${summary.reviews} to review.` +
          (summary.copies ? ` ${summary.copies} already existed, so they were added as copies marked “(restored)”.` : ''),
        failed: false,
      });
    } catch (error) {
      setMessage({ text: error instanceof BackupError ? error.message : "Couldn't restore that backup.", failed: true });
    }
  };

  return (
    <details className="rounded-xl bg-zinc-800/40">
      <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">Merge, back up, restore</summary>
      <div className="flex flex-col gap-4 p-3 pt-1">
        {others.length > 0 && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
              <span className={LABEL}>Merge another batch into this one</span>
              <select value={source?.id ?? ''} onChange={(event) => setMergeFrom(event.target.value)} className={FIELD}>
                {others.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={() => void merge()} className={BUTTON_SECONDARY}>
              Merge
            </button>
          </div>
        )}
        <div className="flex flex-col gap-2">
          <p className="text-sm text-zinc-300">
            Your batches live only in this browser. A backup file keeps every batch, its cards and the cards waiting for
            review, so nothing is lost if the browser's storage is cleared.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void backup(false)} className={BUTTON_SECONDARY}>
              Download backup
            </button>
            {canShare() && (
              <button type="button" onClick={() => void backup(true)} className={BUTTON_SECONDARY}>
                Share backup
              </button>
            )}
            <label className={`${BUTTON_SECONDARY} cursor-pointer`}>
              Restore from backup
              <input type="file" accept="application/json,.json" aria-label="Restore from backup" className="sr-only" onChange={(event) => void restore(event)} />
            </label>
          </div>
        </div>
        {message && (
          <p role={message.failed ? 'alert' : 'status'} className={`text-sm ${message.failed ? 'text-amber-300' : 'text-emerald-300'}`}>
            {message.text}
          </p>
        )}
      </div>
    </details>
  );
}

function BatchHeader({ state, batch }: { state: BatchesState; batch: Batch }) {
  const game = getGame(batch.game);
  const [name, setName] = useState(batch.name);
  const [location, setLocation] = useState(batch.location ?? '');

  useEffect(() => {
    setName(batch.name);
    setLocation(batch.location ?? '');
  }, [batch.id, batch.name, batch.location]);

  const saveName = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== batch.name) void updateBatch(batch.id, { name: trimmed });
    else setName(batch.name);
  };

  const saveLocation = () => {
    const trimmed = location.trim();
    if (trimmed !== (batch.location ?? '')) void updateBatch(batch.id, { location: trimmed });
  };

  const addBatch = async () => {
    const created = await createBatch(`Batch ${state.batches.length + 1}`, batch.game);
    state.selectBatch(created.id);
  };

  const removeBatch = () => {
    if (!window.confirm(`Delete “${batch.name}” and all its cards? This can't be undone.`)) return;
    void deleteBatch(batch.id);
  };

  return (
    <section aria-label="Batch details" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
          <span className={LABEL}>Current batch</span>
          <select value={batch.id} onChange={(event) => state.selectBatch(event.target.value)} className={FIELD}>
            {state.batches.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => void addBatch()} className={BUTTON_SECONDARY}>
          New batch
        </button>
      </div>
      {/* Collapsed so that the cards, not the settings, fill a phone screen. */}
      <details className="rounded-xl bg-zinc-800/40">
        <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">
          Batch settings
        </summary>
        <div className="flex flex-col gap-3 p-3 pt-1">
          <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Batch name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={saveName}
            className={FIELD}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Location (optional)</span>
          <input
            value={location}
            placeholder="Box 3 – Rares"
            onChange={(event) => setLocation(event.target.value)}
            onBlur={saveLocation}
            className={FIELD}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Language for new cards</span>
          <select
            value={batch.settings.defaultLang}
            onChange={(event) => void updateBatchSettings(batch.id, { defaultLang: event.target.value })}
            className={FIELD}
          >
            {game.languages.map((choice) => (
              <option key={choice.code} value={choice.code}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Condition for new cards</span>
          <select
            value={batch.settings.defaultCondition}
            onChange={(event) => void updateBatchSettings(batch.id, { defaultCondition: event.target.value })}
            className={FIELD}
          >
            {game.conditions.map((choice) => (
              <option key={choice.code} value={choice.code}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
          </div>
          <button type="button" onClick={removeBatch} className={`${BUTTON_DANGER} self-start`}>
            Delete batch
          </button>
        </div>
      </details>
      <ManageBatches state={state} batch={batch} />
    </section>
  );
}

/** How long "Removed X · Undo" offers to put a batch row back. */
const REMOVED_MS = 6000;

export function BatchView({ state, onAddCards }: { state: BatchesState; onAddCards: () => void }) {
  const { active, items, storageFailed } = state;
  const exportRef = useRef<HTMLDivElement>(null);
  const [removed, setRemoved] = useState<{ item: BatchItem; key: number } | null>(null);
  useEffect(() => {
    if (!removed) return;
    const timer = setTimeout(() => setRemoved(null), REMOVED_MS);
    return () => clearTimeout(timer);
  }, [removed]);
  if (!active) return storageFailed ? null : <p className="text-sm text-zinc-400">Opening your batches…</p>;

  const total = items.reduce((sum, item) => sum + item.qty, 0);

  return (
    <div className="flex flex-col gap-4">
      <BatchHeader state={state} batch={active} />
      <section aria-label="Cards in batch" className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-base font-semibold" data-testid="batch-total">
            {total} card{total === 1 ? '' : 's'}
          </h2>
          {items.length > 0 && (
            <button type="button" onClick={() => exportRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} className={BUTTON_SECONDARY}>
              Export ↓
            </button>
          )}
        </div>
        {items.length === 0 ? (
          <div className="flex flex-col items-start gap-2 rounded-xl bg-zinc-800/40 p-4">
            <p className="text-sm text-zinc-300">This batch is empty.</p>
            <button type="button" onClick={onAddCards} className={BUTTON_SECONDARY}>
              Add cards
            </button>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <ItemRow key={item.id} item={item} batch={active} onRemoved={(item) => setRemoved({ item, key: Date.now() })} />
            ))}
          </ul>
        )}
      </section>
      <div ref={exportRef} className="scroll-mt-16">
        {items.length > 0 && <ExportPanel batch={active} items={items} />}
      </div>
      {removed && (
        <div role="status" className="fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-30 px-4">
          <div className="mx-auto flex max-w-3xl items-center gap-3 rounded-xl bg-zinc-100 p-3 text-sm text-zinc-900 shadow-lg">
            <span className="min-w-0 flex-1 truncate">
              Removed {removed.item.qty > 1 ? `${removed.item.qty} × ` : ''}
              {removed.item.printing.exportName ?? removed.item.printing.name}
            </span>
            <button
              type="button"
              onClick={() => {
                const { item } = removed;
                setRemoved(null);
                void restoreItem(item);
              }}
              className="min-h-11 rounded-lg px-3 font-semibold text-sky-800 hover:bg-zinc-200"
            >
              Undo
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
