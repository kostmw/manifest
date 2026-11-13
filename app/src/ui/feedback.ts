/**
 * Scan feedback: a beep when a card is added, a different tone when it needs
 * review, and a vibration where the browser allows it.
 *
 * What works where (checked 2026-11):
 * - Sound: Web Audio everywhere, but browsers only let a page make sound
 *   after a tap, so `unlockAudio()` must run in a tap handler ("Start camera",
 *   or any tap on the scanner). For touch, only the end of a tap counts
 *   (pointerup, touchend, click), not pointerdown. iOS also suspends audio when
 *   the app goes to the background; the next tap resumes it.
 * - iOS's silent switch mutes Web Audio by default. Safari's Audio Session API
 *   (`navigator.audioSession.type = 'playback'`) plays through it, but that
 *   also pauses music from other apps, so it is a separate choice.
 * - Haptics: `navigator.vibrate` on Android. iOS Safari has no vibration API,
 *   and the `<input type=checkbox switch>` haptic trick only fires on a real
 *   tap since WebKit's fix of January 2025 (bug 285120), so an iPhone gets the
 *   sound and the screen flash, without haptics.
 */

export type Cue = 'added' | 'review';
/** Off; on (iOS: muted by the silent switch); on even in silent mode. */
export type SoundMode = 'off' | 'on' | 'always';

const SOUND_KEY = 'manifest-sound';

export function soundMode(): SoundMode {
  try {
    const stored = localStorage.getItem(SOUND_KEY);
    return stored === 'off' || stored === 'always' ? stored : 'on';
  } catch {
    return 'on';
  }
}

export function setSoundMode(mode: SoundMode): void {
  try {
    if (mode === 'on') localStorage.removeItem(SOUND_KEY);
    else localStorage.setItem(SOUND_KEY, mode);
  } catch {
    // Storage blocked: the choice lasts until the page closes.
  }
  current = mode;
  applySession();
}

/** Each note: frequency in Hz, start and length in seconds. */
interface Note {
  hz: number;
  at: number;
  length: number;
}

/** One short high beep: done. Two lower falling notes: look at this one later. */
export const CUES: Record<Cue, { notes: Note[]; wave: OscillatorType; vibrate: number | number[] }> = {
  added: { notes: [{ hz: 1568, at: 0, length: 0.09 }], wave: 'sine', vibrate: 35 },
  review: {
    notes: [
      { hz: 659, at: 0, length: 0.12 },
      { hz: 440, at: 0.15, length: 0.16 },
    ],
    wave: 'triangle',
    vibrate: [60, 80, 60],
  },
};

let current: SoundMode = soundMode();
let context: AudioContext | null = null;

interface AudioSessionLike {
  type: string;
}

function applySession(): void {
  const session = (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession;
  if (!session) return;
  try {
    // 'ambient' mixes with other apps' audio and follows the silent switch.
    session.type = current === 'always' ? 'playback' : 'ambient';
  } catch {
    // Older Safari: leave the default.
  }
}

function audioContextClass(): typeof AudioContext | null {
  const scope = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/**
 * Lets later cues make sound. Call it from a tap (pointer or click handler):
 * browsers refuse audio that no tap started. Cheap when already unlocked.
 */
export function unlockAudio(): void {
  if (current === 'off') return;
  const Context = audioContextClass();
  if (!Context) return;
  try {
    if (!context) {
      applySession();
      context = new Context();
    }
    if (context.state !== 'running') {
      void context.resume().catch(() => {});
      // iOS unlocks only once something has actually played inside the tap.
      const silent = context.createBuffer(1, 1, 22050);
      const source = context.createBufferSource();
      source.buffer = silent;
      source.connect(context.destination);
      source.start(0);
    }
  } catch {
    context = null;
  }
}

/** Whether a cue would be heard now (false until a tap has unlocked audio, or after iOS suspended it). */
export function audioReady(): boolean {
  return current !== 'off' && context?.state === 'running';
}

function beep(cue: Cue): void {
  if (current === 'off' || !context || context.state !== 'running') return;
  const { notes, wave } = CUES[cue];
  const start = context.currentTime + 0.01;
  for (const note of notes) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = wave;
    oscillator.frequency.value = note.hz;
    const t0 = start + note.at;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.35, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + note.length);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(t0);
    oscillator.stop(t0 + note.length + 0.02);
  }
}

function vibrate(cue: Cue): void {
  try {
    navigator.vibrate?.(CUES[cue].vibrate);
  } catch {
    // Some browsers throw when vibration is blocked; it is only a nicety.
  }
}

const SOUND_TIP_KEY = 'manifest-sound-tip';

/**
 * Whether the phone's silent switch can mute the beeps, so a tip about it is
 * worth showing: Safari, the browser with the Audio Session API that can play
 * through the switch.
 */
export function silentSwitchMatters(): boolean {
  return typeof navigator !== 'undefined' && 'audioSession' in navigator;
}

/** Whether the one-time "no sound? the silent switch" tip was dismissed. */
export function soundTipDismissed(): boolean {
  try {
    return localStorage.getItem(SOUND_TIP_KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissSoundTip(): void {
  try {
    localStorage.setItem(SOUND_TIP_KEY, '1');
  } catch {
    // Storage blocked: the tip comes back next time, which is harmless.
  }
}

/** Whether this browser can vibrate at all (Android Chrome yes, iOS Safari no). */
export function canVibrate(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

/** The sound and vibration for a scanned card. The screen flash is the scanner's job. */
export function cue(kind: Cue): void {
  beep(kind);
  vibrate(kind);
}
