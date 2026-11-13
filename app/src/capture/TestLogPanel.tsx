/** Under "Sound and testing": record a test log of scans, then share it as one file. */
import { useEffect, useState } from 'react';
import { canShare, downloadText, shareText } from '../export/deliver';
import {
  BUILD,
  clearTestLog,
  createTestLogFile,
  setTestLogEnabled,
  setTestLogPictures,
  testLogCount,
  testLogEnabled,
  testLogFileName,
  testLogPictures,
} from '../session/testLog';
import { BUTTON_SECONDARY } from '../ui/styles';

export function TestLogPanel() {
  const [on, setOn] = useState(() => testLogEnabled());
  const [pictures, setPictures] = useState(() => testLogPictures());
  const [count, setCount] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // The count of reads logged, refreshed every few seconds while the panel is open and recording.
  useEffect(() => {
    let stopped = false;
    const refresh = () =>
      void testLogCount().then(
        (n) => !stopped && setCount(n),
        () => !stopped && setCount(null),
      );
    refresh();
    const timer = on ? setInterval(refresh, 3000) : undefined;
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, [on]);

  const exportLog = async (share: boolean) => {
    try {
      const text = JSON.stringify(await createTestLogFile({ build: BUILD, userAgent: navigator.userAgent }));
      const name = testLogFileName();
      if (share) {
        if (await shareText(name, text, 'application/json')) setMessage('Test log shared.');
      } else {
        downloadText(name, text, 'application/json');
        setMessage(`Saved ${name}.`);
      }
    } catch {
      setMessage("Couldn't make the test log file.");
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-zinc-800 p-2">
      <label className="flex min-h-11 items-center gap-2">
        <input
          type="checkbox"
          checked={on}
          onChange={(event) => {
            setTestLogEnabled(event.target.checked);
            setOn(event.target.checked);
          }}
        />
        Record a test log
      </label>
      <p>
        Keeps what each scan read, how long it took and what you corrected, for sending to the developer as one file. It
        stays on this phone until you share it.
      </p>
      {on && (
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={pictures}
            onChange={(event) => {
              setTestLogPictures(event.target.checked);
              setPictures(event.target.checked);
            }}
          />
          Include card pictures (small, about 10 KB each)
        </label>
      )}
      {count !== null && (
        <p data-testid="testlog-count">
          {count} scan{count === 1 ? '' : 's'} in the log (it keeps the last 300).
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {canShare() && (
          <button type="button" disabled={!count} onClick={() => void exportLog(true)} className={BUTTON_SECONDARY}>
            Share test log
          </button>
        )}
        <button type="button" disabled={!count} onClick={() => void exportLog(false)} className={BUTTON_SECONDARY}>
          Download test log
        </button>
        <button
          type="button"
          disabled={!count}
          onClick={() => {
            if (!window.confirm('Delete every scan in the test log?')) return;
            void clearTestLog().then(() => {
              setCount(0);
              setMessage('Test log cleared.');
            });
          }}
          className={BUTTON_SECONDARY}
        >
          Clear log
        </button>
      </div>
      {message && (
        <p role="status" className="text-zinc-300">
          {message}
        </p>
      )}
    </div>
  );
}
