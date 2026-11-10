/** Choosing a printing of a known card name and adding it to the batch. Shared by search and the scanner. */
import { useState } from 'react';
import { getGame } from '../games/registry';
import { loadPrintings, thumbnailUrl } from '../games/indexClient';
import type { Printing } from '../games/types';
import { addCard } from '../session/batches';
import type { Batch } from '../session/types';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, FIELD } from '../ui/styles';

const SET_FILTER_THRESHOLD = 8;

export interface Message {
  text: string;
  failed: boolean;
}

export type PrintingsState =
  | { status: 'idle' }
  | { status: 'loading'; name: string }
  | { status: 'ready'; name: string; printings: Printing[] }
  | { status: 'error'; name: string };

export function usePrintings(game: Batch['game']) {
  const [state, setState] = useState<PrintingsState>({ status: 'idle' });

  const load = (name: string) => {
    setState({ status: 'loading', name });
    loadPrintings(game, name).then(
      (printings) =>
        setState((current) =>
          current.status === 'loading' && current.name === name ? { status: 'ready', name, printings } : current,
        ),
      () =>
        setState((current) =>
          current.status === 'loading' && current.name === name ? { status: 'error', name } : current,
        ),
    );
  };

  return { state, load, clear: () => setState({ status: 'idle' }) };
}

function PrintingRow({
  printing,
  batch,
  onAdded,
}: {
  printing: Printing;
  batch: Batch;
  onAdded: (message: Message) => void;
}) {
  const game = getGame(batch.game);
  const code = `${printing.set.toUpperCase()} ${printing.number}`;

  const add = async (finish: string, finishLabel: string) => {
    const name = printing.exportName ?? printing.name;
    try {
      await addCard(batch, printing, { finish });
      const suffix = finish === 'nonfoil' ? '' : ` ${finishLabel.toLowerCase()}`;
      onAdded({ text: `Added ${name} (${code})${suffix} to ${batch.name}`, failed: false });
    } catch {
      onAdded({ text: `Couldn't save ${name}. Your browser's storage may be full.`, failed: true });
    }
  };

  return (
    <li className="flex gap-3 rounded-xl bg-zinc-800/60 p-2">
      {printing.image ? (
        <img
          src={thumbnailUrl(printing.image)}
          alt=""
          loading="lazy"
          width={73}
          height={102}
          className="h-[102px] w-[73px] flex-none rounded-md bg-zinc-800 object-cover"
        />
      ) : (
        <div className="h-[102px] w-[73px] flex-none rounded-md bg-zinc-800" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div>
          <p className="truncate text-sm font-medium">{printing.setName}</p>
          <p className="text-xs text-zinc-400">
            {code}
            {printing.released ? ` · ${printing.released.slice(0, 4)}` : ''}
            {printing.lang !== 'en' ? ` · ${printing.lang}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {printing.finishes.map((finish) => {
            const label = game.finishes.find((choice) => choice.code === finish)?.label ?? finish;
            return (
              <button
                key={finish}
                type="button"
                aria-label={`Add ${code} ${label}`}
                onClick={() => void add(finish, label)}
                className={finish === 'nonfoil' ? BUTTON_PRIMARY : BUTTON_SECONDARY}
              >
                {finish === 'nonfoil' ? 'Add' : `Add ${label.toLowerCase()}`}
              </button>
            );
          })}
        </div>
      </div>
    </li>
  );
}

/** The loading, error and list states of a printing lookup. */
export function PrintingList({
  printings,
  batch,
  onAdded,
}: {
  printings: ReturnType<typeof usePrintings>;
  batch: Batch | null;
  onAdded: (message: Message) => void;
}) {
  const [setFilter, setSetFilter] = useState('');
  const { state } = printings;

  const shown =
    state.status === 'ready'
      ? state.printings.filter((printing) => {
          const filter = setFilter.trim().toLowerCase();
          return !filter || printing.setName.toLowerCase().includes(filter) || printing.set.startsWith(filter);
        })
      : [];

  return (
    <>
      {state.status === 'loading' && <p className="text-sm text-zinc-400">Loading printings…</p>}

      {state.status === 'error' && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-amber-300">
          <p>Couldn't load the printings of {state.name}.</p>
          <button type="button" onClick={() => printings.load(state.name)} className={BUTTON_SECONDARY}>
            Try again
          </button>
        </div>
      )}

      {state.status === 'ready' && batch && (
        <div className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">
            {state.name}{' '}
            <span className="font-normal text-zinc-400">
              · {state.printings.length} printing{state.printings.length === 1 ? '' : 's'}
            </span>
          </h2>
          {state.printings.length > SET_FILTER_THRESHOLD && (
            <input
              aria-label="Filter by set"
              value={setFilter}
              placeholder="Filter by set name or code"
              onChange={(event) => setSetFilter(event.target.value)}
              className={FIELD}
            />
          )}
          <ul aria-label="Printings" className="flex flex-col gap-2">
            {shown.map((printing) => (
              <PrintingRow key={printing.id} printing={printing} batch={batch} onAdded={onAdded} />
            ))}
          </ul>
          {shown.length === 0 && <p className="text-sm text-zinc-400">No printings match that filter.</p>}
        </div>
      )}
    </>
  );
}
