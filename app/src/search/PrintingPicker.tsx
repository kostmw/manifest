/**
 * Choose a printing: all printings of a name, or of another card found by
 * name. Used to settle a review and to change a batch row's printing.
 */
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import type { Printing } from '../games/types';
import type { Batch } from '../session/types';
import { BUTTON_SECONDARY, FIELD } from '../ui/styles';
import { PrintingList, usePrintings } from './printings';
import { useNameSearch } from './useNameSearch';

export function PrintingPicker({
  batch,
  name,
  searchFirst = false,
  onChoose,
  onCancel,
}: {
  batch: Batch;
  /** Start with this card's printings. */
  name?: string;
  /** Start in the search box instead. */
  searchFirst?: boolean;
  onChoose: (printing: Printing) => void;
  onCancel: () => void;
}) {
  const printings = usePrintings(batch.game);
  const search = useNameSearch(batch.game);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const listId = useId();
  const showResults = printings.state.status === 'idle' && query.trim() !== '';

  useEffect(() => {
    if (name && !searchFirst) printings.load(name);
  }, [name]); // Once per name: load() is a fresh function every render.

  useEffect(() => {
    void search.search(query);
    setHighlight(0);
  }, [query, search.search, search.status]);

  const pick = (picked: string) => {
    setQuery(picked);
    printings.load(picked);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // The review queue's single-key shortcuts must not fire while typing.
    event.stopPropagation();
    if (!showResults) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((value) => Math.min(value + 1, search.results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((value) => Math.max(value - 1, 0));
    } else if (event.key === 'Enter') {
      const chosen = search.results[highlight];
      if (chosen) {
        event.preventDefault();
        pick(chosen.name);
      }
    } else if (event.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <section aria-label="Choose a printing" className="flex flex-col gap-3 rounded-xl bg-zinc-800/40 p-3">
      <div className="flex gap-2">
        <input
          aria-label="Search another card"
          role="combobox"
          aria-expanded={showResults && search.results.length > 0}
          aria-controls={listId}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={searchFirst}
          disabled={search.status !== 'ready'}
          value={query}
          placeholder={search.status === 'loading' ? 'Loading card names…' : 'Another card name'}
          onChange={(event) => {
            printings.clear();
            setQuery(event.target.value);
          }}
          onKeyDown={onKeyDown}
          className={`${FIELD} w-full min-w-0 flex-1 disabled:opacity-60`}
        />
        <button type="button" onClick={onCancel} className={BUTTON_SECONDARY}>
          Cancel
        </button>
      </div>
      {showResults && (
        <ul id={listId} role="listbox" aria-label="Matching cards" className="flex flex-col gap-1">
          {search.results.map((hit, index) => (
            <li
              key={hit.name}
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
          {search.status === 'ready' && search.results.length === 0 && (
            <li className="px-3 py-2 text-sm text-zinc-400">No cards match that name.</li>
          )}
        </ul>
      )}
      <PrintingList
        key={printings.state.status === 'idle' ? '' : printings.state.name}
        printings={printings}
        batch={batch}
        onChoose={onChoose}
      />
    </section>
  );
}
