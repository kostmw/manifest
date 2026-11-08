import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { getGame } from '../games/registry';
import { loadManifest, loadPrintings, thumbnailUrl } from '../games/indexClient';
import type { Printing } from '../games/types';
import { addCard } from '../session/batches';
import type { Batch } from '../session/types';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, FIELD, LABEL } from '../ui/styles';
import { useNameSearch } from './useNameSearch';

const SET_FILTER_THRESHOLD = 8;

interface Message {
  text: string;
  failed: boolean;
}

type PrintingsState =
  | { status: 'idle' }
  | { status: 'loading'; name: string }
  | { status: 'ready'; name: string; printings: Printing[] }
  | { status: 'error'; name: string };

function usePrintings(game: Batch['game']) {
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

export function AddCards({ batch }: { batch: Batch | null }) {
  const gameId = batch?.game ?? 'mtg';
  const { status, results, search, retry } = useNameSearch(gameId);
  const printings = usePrintings(gameId);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [setFilter, setSetFilter] = useState('');
  const [message, setMessage] = useState<Message | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const listId = useId();
  const showResults = printings.state.status === 'idle' && query.trim() !== '';

  useEffect(() => {
    void search(query);
    setHighlight(0);
  }, [query, search, status]);

  useEffect(() => {
    loadManifest().then(
      (manifest) => setUpdatedAt(manifest.buildDate.slice(0, 10)),
      () => setUpdatedAt(null),
    );
  }, [status]);

  const pick = (name: string) => {
    setQuery(name);
    setSetFilter('');
    printings.load(name);
  };

  const startOver = () => {
    printings.clear();
    setQuery('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!showResults) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((value) => Math.min(value + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((value) => Math.max(value - 1, 0));
    } else if (event.key === 'Enter') {
      const chosen = results[highlight];
      if (chosen) {
        event.preventDefault();
        pick(chosen.name);
      }
    }
  };

  const shown =
    printings.state.status === 'ready'
      ? printings.state.printings.filter((printing) => {
          const filter = setFilter.trim().toLowerCase();
          return !filter || printing.setName.toLowerCase().includes(filter) || printing.set.startsWith(filter);
        })
      : [];

  return (
    <section aria-label="Add cards" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={`${listId}-input`} className={LABEL}>
          Card name
        </label>
        <div className="flex gap-2">
          <input
            id={`${listId}-input`}
            role="combobox"
            aria-expanded={showResults && results.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={showResults && results[highlight] ? `${listId}-${highlight}` : undefined}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={status !== 'ready'}
            value={query}
            placeholder={status === 'loading' ? 'Loading card names…' : 'Sol Ring'}
            onChange={(event) => {
              printings.clear();
              setQuery(event.target.value);
            }}
            onKeyDown={onKeyDown}
            className={`${FIELD} w-full min-w-0 flex-1 disabled:opacity-60`}
          />
          {printings.state.status !== 'idle' && (
            <button type="button" onClick={startOver} className={BUTTON_SECONDARY}>
              New search
            </button>
          )}
        </div>
        {updatedAt && <p className="text-xs text-zinc-500">Card data from Scryfall, updated {updatedAt}.</p>}
      </div>

      {status === 'error' && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-amber-300">
          <p>Couldn't load the card list. Check your connection and try again.</p>
          <button type="button" onClick={retry} className={BUTTON_SECONDARY}>
            Try again
          </button>
        </div>
      )}

      <p aria-live="polite" className={`min-h-5 text-sm ${message?.failed ? 'text-amber-300' : 'text-emerald-300'}`}>
        {message?.text}
      </p>

      {showResults && (
        <ul id={listId} role="listbox" aria-label="Matching cards" className="flex flex-col gap-1">
          {results.map((hit, index) => (
            <li
              key={hit.name}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === highlight}
              onClick={() => pick(hit.name)}
              className={`min-h-11 cursor-pointer rounded-lg px-3 py-2.5 text-sm ${
                index === highlight ? 'bg-zinc-700' : 'bg-zinc-800/60 hover:bg-zinc-700'
              }`}
            >
              {hit.name}
            </li>
          ))}
          {status === 'ready' && results.length === 0 && (
            <li className="px-3 py-2 text-sm text-zinc-400">No cards match that name.</li>
          )}
        </ul>
      )}

      {printings.state.status === 'loading' && <p className="text-sm text-zinc-400">Loading printings…</p>}

      {printings.state.status === 'error' && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-amber-300">
          <p>Couldn't load the printings of {printings.state.name}.</p>
          <button
            type="button"
            onClick={() => printings.state.status === 'error' && printings.load(printings.state.name)}
            className={BUTTON_SECONDARY}
          >
            Try again
          </button>
        </div>
      )}

      {printings.state.status === 'ready' && batch && (
        <div className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">
            {printings.state.name}{' '}
            <span className="font-normal text-zinc-400">
              · {printings.state.printings.length} printing{printings.state.printings.length === 1 ? '' : 's'}
            </span>
          </h2>
          {printings.state.printings.length > SET_FILTER_THRESHOLD && (
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
              <PrintingRow key={printing.id} printing={printing} batch={batch} onAdded={setMessage} />
            ))}
          </ul>
          {shown.length === 0 && <p className="text-sm text-zinc-400">No printings match that filter.</p>}
        </div>
      )}
    </section>
  );
}
