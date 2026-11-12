/** The batch's settings for scanning: lock to sets, everything foil, language, condition. */
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { getGame } from '../games/registry';
import { loadSets } from '../games/indexClient';
import { searchSets, type SetInfo } from '../games/sets';
import type { GameId } from '../games/types';
import { updateBatchSettings } from '../session/batches';
import type { Batch } from '../session/types';
import { BUTTON_SECONDARY, FIELD } from '../ui/styles';

const CHIP = 'inline-flex min-h-11 items-center gap-2 rounded-lg bg-zinc-800 px-3 text-sm text-zinc-100';
const SELECT = 'min-h-11 rounded-lg border border-zinc-700 bg-zinc-800 px-2 text-sm text-zinc-100';
const SET_CODE = /^[a-z0-9]{2,6}$/;

type SetsState = { status: 'loading' } | { status: 'ready'; sets: SetInfo[] } | { status: 'missing' };

/** The index's set list; `missing` for an index built before it existed (codes are then typed). */
function useSets(game: GameId): SetsState {
  const [state, setState] = useState<SetsState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    loadSets(game).then(
      (sets) => !cancelled && setState(sets ? { status: 'ready', sets } : { status: 'missing' }),
      () => !cancelled && setState({ status: 'missing' }),
    );
    return () => {
      cancelled = true;
    };
  }, [game]);
  return state;
}

function SetLockEditor({ batch, onClose }: { batch: Batch; onClose: () => void }) {
  const sets = useSets(batch.game);
  const [query, setQuery] = useState('');
  const listId = useId();
  const locked = batch.settings.lockSets ?? [];
  const known = sets.status === 'ready' ? new Map(sets.sets.map((set) => [set.code, set])) : null;
  const matches = sets.status === 'ready' ? searchSets(sets.sets, query).filter((set) => !locked.includes(set.code)) : [];
  const typed = query.trim().toLowerCase();

  const save = (next: string[]) => void updateBatchSettings(batch.id, { lockSets: next });
  const lock = (code: string) => {
    if (!locked.includes(code)) save([...locked, code]);
    setQuery('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (matches[0]) lock(matches[0].code);
    else if (sets.status === 'missing' && SET_CODE.test(typed)) lock(typed);
  };

  return (
    <div className="flex w-full flex-col gap-2 rounded-xl bg-zinc-800/40 p-3">
      <p className="text-xs text-zinc-400">
        Only printings from these sets are considered, which settles look-alike printings. A card from another set waits
        for review instead of being added.
      </p>
      {locked.length > 0 && (
        <ul aria-label="Locked sets" className="flex flex-wrap gap-2">
          {locked.map((code) => (
            <li key={code} className="flex items-center gap-1 rounded-lg bg-zinc-700 py-1 pr-1 pl-3 text-sm">
              <span>
                <span className="font-mono">{code.toUpperCase()}</span>
                {known?.get(code) && <span className="text-zinc-300"> · {known.get(code)!.name}</span>}
              </span>
              <button
                type="button"
                aria-label={`Unlock ${code.toUpperCase()}`}
                onClick={() => save(locked.filter((other) => other !== code))}
                className="flex size-9 items-center justify-center rounded-md text-zinc-300 hover:bg-zinc-600"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        aria-label="Add a set"
        role="combobox"
        aria-expanded={matches.length > 0}
        aria-controls={listId}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        value={query}
        placeholder={sets.status === 'missing' ? 'Set code, e.g. LTR' : 'Set name or code'}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        className={FIELD}
      />
      {matches.length > 0 && (
        <ul id={listId} role="listbox" aria-label="Matching sets" className="flex flex-col gap-1">
          {matches.map((set) => (
            <li
              key={set.code}
              role="option"
              aria-selected={false}
              onClick={() => lock(set.code)}
              className="min-h-11 cursor-pointer rounded-lg bg-zinc-800/60 px-3 py-2.5 text-sm hover:bg-zinc-700"
            >
              <span className="font-mono">{set.code.toUpperCase()}</span> · {set.name}
              {set.released && <span className="text-zinc-400"> · {set.released.slice(0, 4)}</span>}
            </li>
          ))}
        </ul>
      )}
      {sets.status === 'missing' && (
        <p className="text-xs text-zinc-500">This card index has no set list yet: type a set code and press Enter.</p>
      )}
      <div className="flex flex-wrap gap-2">
        {locked.length > 0 && (
          <button type="button" onClick={() => save([])} className={BUTTON_SECONDARY}>
            Any set
          </button>
        )}
        <button type="button" onClick={onClose} className={BUTTON_SECONDARY}>
          Done
        </button>
      </div>
    </div>
  );
}

export function ScanSettings({ batch }: { batch: Batch }) {
  const game = getGame(batch.game);
  const [editingSets, setEditingSets] = useState(false);
  const locked = batch.settings.lockSets ?? [];
  // Shown at once: the saved setting comes back from the database a moment later.
  const saved = batch.settings.foil === true;
  const [foil, setFoil] = useState(saved);
  useEffect(() => setFoil(saved), [saved]);

  return (
    <section aria-label="Scan settings" className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        aria-expanded={editingSets}
        onClick={() => setEditingSets((open) => !open)}
        className={`${CHIP} ${locked.length ? 'ring-1 ring-amber-400/70' : ''}`}
      >
        Sets: {locked.length ? locked.map((code) => code.toUpperCase()).join(', ') : 'any'}
      </button>
      <label className={`${CHIP} cursor-pointer ${foil ? 'ring-1 ring-amber-400/70' : ''}`}>
        <input
          type="checkbox"
          // iOS 17.4+ draws a switch, and taps on it get the system's haptic tick.
          ref={(element) => element?.setAttribute('switch', '')}
          checked={foil}
          onChange={(event) => {
            setFoil(event.target.checked);
            void updateBatchSettings(batch.id, { foil: event.target.checked });
          }}
          className="size-5 accent-amber-400"
        />
        All foil
      </label>
      <select
        aria-label="Language"
        value={batch.settings.defaultLang}
        onChange={(event) => void updateBatchSettings(batch.id, { defaultLang: event.target.value })}
        className={SELECT}
      >
        {game.languages.map((choice) => (
          <option key={choice.code} value={choice.code}>
            {choice.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Condition"
        value={batch.settings.defaultCondition}
        onChange={(event) => void updateBatchSettings(batch.id, { defaultCondition: event.target.value })}
        className={SELECT}
      >
        {game.conditions.map((choice) => (
          <option key={choice.code} value={choice.code}>
            {choice.label}
          </option>
        ))}
      </select>
      {editingSets && <SetLockEditor batch={batch} onClose={() => setEditingSets(false)} />}
    </section>
  );
}
