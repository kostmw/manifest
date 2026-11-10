import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { loadManifest } from '../games/indexClient';
import type { Batch } from '../session/types';
import { BUTTON_SECONDARY, FIELD, LABEL } from '../ui/styles';
import { PrintingList, usePrintings, type Message } from './printings';
import { useNameSearch } from './useNameSearch';

export function AddCards({ batch }: { batch: Batch | null }) {
  const gameId = batch?.game ?? 'mtg';
  const { status, results, search, retry } = useNameSearch(gameId);
  const printings = usePrintings(gameId);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
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

      <PrintingList
        key={printings.state.status === 'idle' ? '' : printings.state.name}
        printings={printings}
        batch={batch}
        onAdded={setMessage}
      />
    </section>
  );
}
