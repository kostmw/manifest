import { useEffect, useMemo, useState } from 'react';
import { getGame } from '../games/registry';
import type { Batch, BatchItem } from '../session/types';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, FIELD, LABEL } from '../ui/styles';
import { aggregate } from './aggregate';
import { canShare, downloadText, exportFileName, shareText } from './deliver';
import type { GroupBy } from './types';

export function ExportPanel({ batch, items }: { batch: Batch; items: readonly BatchItem[] }) {
  const game = getGame(batch.game);
  const [formatId, setFormatId] = useState(game.exportFormats[0]!.id);
  const [groupBy, setGroupBy] = useState<GroupBy>('printing');
  const [extraColumnIds, setExtraColumnIds] = useState<string[]>([]);
  const [status, setStatus] = useState('');

  const format = game.exportFormats.find((candidate) => candidate.id === formatId) ?? game.exportFormats[0]!;

  const output = useMemo(
    () =>
      format.render(aggregate(items, groupBy), {
        batchName: batch.name,
        location: batch.location,
        createdAt: batch.createdAt,
        generatedAt: new Date().toISOString(),
        groupBy,
        extraColumnIds,
      }),
    [format, items, groupBy, batch.name, batch.location, batch.createdAt, extraColumnIds],
  );

  useEffect(() => setStatus(''), [output]);

  const fileName = exportFileName(batch.name, format.id, format.extension);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(output);
      setStatus('Copied to clipboard.');
    } catch {
      setStatus("Couldn't copy. Use Download instead.");
    }
  };

  const share = async () => {
    try {
      if (await shareText(fileName, output, format.mimeType)) setStatus('Shared.');
    } catch {
      setStatus("Couldn't share. Use Download instead.");
    }
  };

  const toggleColumn = (id: string, on: boolean) =>
    setExtraColumnIds((current) => (on ? [...current, id] : current.filter((value) => value !== id)));

  return (
    <section aria-label="Export" className="flex flex-col gap-3 rounded-xl bg-zinc-800/40 p-3">
      <h2 className="text-base font-semibold">Export</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Format</span>
          <select value={format.id} onChange={(event) => setFormatId(event.target.value)} className={FIELD}>
            {game.exportFormats.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label} (.{candidate.extension})
              </option>
            ))}
          </select>
        </label>
        {format.supportsGrouping && (
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Group by</span>
            <select
              value={groupBy}
              onChange={(event) => setGroupBy(event.target.value as GroupBy)}
              className={FIELD}
            >
              <option value="printing">Printing</option>
              <option value="name">Card name</option>
            </select>
          </label>
        )}
      </div>

      {format.supportsExtraColumns && (
        <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
          <legend className={`${LABEL} mb-1`}>Extra columns</legend>
          {game.extraColumns.map((column) => (
            <label key={column.id} className="flex min-h-8 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={extraColumnIds.includes(column.id)}
                onChange={(event) => toggleColumn(column.id, event.target.checked)}
              />
              {column.label}
            </label>
          ))}
        </fieldset>
      )}

      {format.note && <p className="text-xs leading-relaxed text-zinc-400">{format.note}</p>}

      <pre
        data-testid="export-preview"
        tabIndex={0}
        aria-label="Export preview"
        className="max-h-72 overflow-auto rounded-lg bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-200"
      >
        {output}
      </pre>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void copy()} className={BUTTON_PRIMARY}>
          Copy
        </button>
        <button
          type="button"
          onClick={() => downloadText(fileName, output, format.mimeType)}
          className={BUTTON_SECONDARY}
        >
          Download
        </button>
        {canShare() && (
          <button type="button" onClick={() => void share()} className={BUTTON_SECONDARY}>
            Share
          </button>
        )}
        <p aria-live="polite" className="text-sm text-emerald-300">
          {status}
        </p>
      </div>
    </section>
  );
}
