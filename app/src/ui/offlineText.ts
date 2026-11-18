/** What the app says about being ready offline (OfflineStatus.tsx shows it; offline.ts holds the state). */
import type { OfflineStatus } from './offline';

/** "18 Nov": the day the card index was built, in UTC, as the nightly build runs. */
export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** The footer's line about the card data. Null when there is nothing to say yet. */
export function offlineLine(status: OfflineStatus, online: boolean, debug = false): string | null {
  if (status.unavailable) return "Card data can't be kept offline in this browser (a private window, perhaps).";
  if (!status.buildDate) return status.download ? `Downloading card data for offline use · ${status.download.percent}%` : null;
  let line = `Card data ${shortDate(status.buildDate)}`;
  const { download } = status;
  if (download && !download.updating) line += ` · downloading for offline use, ${download.percent}%`;
  else if (status.ready) line += ' · ready offline';
  else if (status.ready === false) line += online ? ' · not ready offline yet' : ' · not ready offline: connect to finish downloading';
  if (download?.updating) line += ` · updating to ${shortDate(download.buildDate)}, ${download.percent}%`;
  if (debug && status.persisted !== null) line += status.persisted ? ' · storage kept' : ' · storage may be cleared';
  return line;
}

/** A notice in the page, for what matters now: the first download, or no room for it. */
export function offlineNotice(status: OfflineStatus): { text: string; alert: boolean } | null {
  if (status.noRoom) {
    return { text: "There isn't enough storage space to keep card data offline. Scanning still works while you're online.", alert: true };
  }
  if (status.download && !status.download.updating) {
    return { text: `Downloading card data for offline use: ${status.download.percent}%. You can scan meanwhile.`, alert: false };
  }
  return null;
}
