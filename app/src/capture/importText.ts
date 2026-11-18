/** What the import panel says, as pure functions so the wording is tested. */
import type { ImportFailure, ImportJob } from '../session/imports';
import { filesDone, wasInterrupted, type ImportView } from './importQueue';

const count = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;

/** "about 12 min left", rounded so it doesn't flicker. */
export function timeLeft(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  const minutes = ms / 60_000;
  if (minutes < 1) return 'under a minute left';
  if (minutes < 60) return `about ${Math.round(minutes)} min left`;
  const hours = Math.floor(minutes / 60);
  return `about ${hours} h ${Math.round(minutes - hours * 60)} min left`;
}

/** "380 cards added · 32 to review · 3 without a card · 12 skipped". Parts that are 0 are left out. */
export function tally(job: Pick<ImportJob, 'photos' | 'cards'>): string {
  const parts = [
    plural(job.cards.added, 'card added', 'cards added'),
    ...(job.cards.review ? [`${count(job.cards.review)} to review`] : []),
    ...(job.photos.failed ? [`${count(job.photos.failed)} without a card`] : []),
    ...(job.cards.unread ? [plural(job.cards.unread, 'outline not read', 'outlines not read')] : []),
    ...(job.photos.skipped ? [`${count(job.photos.skipped)} skipped`] : []),
  ];
  return parts.join(' · ');
}

/** The panel's heading. */
export function headline(view: ImportView): string {
  const { job } = view;
  const done = filesDone(job);
  const of = `${count(done)} of ${plural(job.total, 'photo', 'photos')}`;
  if (wasInterrupted(view)) return `Import stopped before it finished: ${of} read`;
  switch (job.state) {
    case 'running':
      return `Importing photos: ${of}`;
    case 'paused':
      return `Import paused: ${of}`;
    case 'done':
      return `Import finished: ${plural(job.total, 'photo', 'photos')}`;
    case 'cancelled':
      return `Import cancelled: ${of} read`;
    case 'stopped':
      return `Import stopped: ${of} read`;
  }
}

/** What to do next, when there's something to say. */
export function nextStep(view: ImportView): string | null {
  const { job } = view;
  if (wasInterrupted(view)) {
    return 'The page reloaded or was closed. To finish, pick the same photos again: the ones already read are skipped.';
  }
  if (job.state === 'stopped' && job.why === 'batch-gone') return 'Its batch was deleted or merged, so the rest weren’t read.';
  if (job.state === 'cancelled') return 'The cards read so far are in the batch or waiting in Review.';
  if (job.state === 'running' || job.state === 'paused') {
    return 'It carries on if you switch tabs, but pauses while the screen is off or another app is in front.';
  }
  return null;
}

/** Why a photo gave no card, in a few words. */
export function failureText(failure: ImportFailure, name: string): string {
  switch (failure) {
    case 'no-card':
      return 'No card found';
    case 'not-image':
      return 'Not a picture';
    case 'unopenable':
      return /\.(heic|heif)$/i.test(name) ? 'This browser can’t open HEIC photos: use Safari, or save them as JPEG' : 'This browser can’t open it';
    case 'error':
      return 'Reading it went wrong';
    case 'unread':
      return 'Some outlines in it named no card (an empty pocket, or a card it couldn’t read)';
  }
}

/** "12 photos were read into this batch before, so they were skipped." */
export function skippedText(skipped: number): string {
  return skipped === 1
    ? '1 photo was read into this batch before, so it was skipped.'
    : `${count(skipped)} photos were read into this batch before, so they were skipped.`;
}
