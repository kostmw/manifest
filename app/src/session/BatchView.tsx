import { useEffect, useState } from 'react';
import { ExportPanel } from '../export/ExportPanel';
import { getGame } from '../games/registry';
import { BUTTON_DANGER, BUTTON_SECONDARY, FIELD, LABEL } from '../ui/styles';
import { changeQuantity, createBatch, deleteBatch, removeItem, updateBatch, updateBatchSettings, updateItem } from './batches';
import type { Batch, BatchItem } from './types';
import type { BatchesState } from './useBatches';

const SMALL_FIELD = 'min-h-9 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100';
const STEPPER = 'flex size-9 items-center justify-center rounded-md bg-zinc-700 text-lg hover:bg-zinc-600';

function ItemRow({ item, game }: { item: BatchItem; game: Batch['game'] }) {
  const adapter = getGame(game);
  const { printing } = item;
  const name = printing.exportName ?? printing.name;
  const code = `${printing.set.toUpperCase()} ${printing.number}`;

  return (
    <li className="flex flex-col gap-2 rounded-xl bg-zinc-800/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="truncate text-xs text-zinc-400">
            {code} · {printing.setName}
          </p>
        </div>
        <div className="flex flex-none items-center gap-1">
          <button
            type="button"
            aria-label={`One fewer ${name}`}
            onClick={() => void changeQuantity(item.id, -1)}
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
          aria-label={`Remove ${name}`}
          onClick={() => void removeItem(item.id)}
          className="ml-auto min-h-9 rounded-md px-2 text-sm text-zinc-400 hover:text-red-300"
        >
          Remove
        </button>
      </div>
    </li>
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
    </section>
  );
}

export function BatchView({ state, onAddCards }: { state: BatchesState; onAddCards: () => void }) {
  const { active, items, storageFailed } = state;
  if (!active) return storageFailed ? null : <p className="text-sm text-zinc-400">Opening your batches…</p>;

  const total = items.reduce((sum, item) => sum + item.qty, 0);

  return (
    <div className="flex flex-col gap-4">
      <BatchHeader state={state} batch={active} />
      <section aria-label="Cards in batch" className="flex flex-col gap-2">
        <h2 className="text-base font-semibold" data-testid="batch-total">
          {total} card{total === 1 ? '' : 's'}
        </h2>
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
              <ItemRow key={item.id} item={item} game={active.game} />
            ))}
          </ul>
        )}
      </section>
      {items.length > 0 && <ExportPanel batch={active} items={items} />}
    </div>
  );
}
