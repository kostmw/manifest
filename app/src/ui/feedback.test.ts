import { afterEach, describe, expect, it, vi } from 'vitest';
import { audioReady, canVibrate, cue, CUES, setSoundMode, soundMode } from './feedback';

function fakeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: () => null,
    get length() {
      return values.size;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('feedback', () => {
  it('sounds two different cues: one high note for added, falling lower notes for review', () => {
    expect(CUES.added.notes).toHaveLength(1);
    expect(CUES.review.notes.length).toBeGreaterThan(1);
    const highestReview = Math.max(...CUES.review.notes.map((note) => note.hz));
    expect(CUES.added.notes[0]!.hz).toBeGreaterThan(highestReview);
    expect(CUES.review.notes[0]!.hz).toBeGreaterThan(CUES.review.notes[1]!.hz);
  });

  it('remembers the sound setting, on by default', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(soundMode()).toBe('on');
    setSoundMode('always');
    expect(soundMode()).toBe('always');
    setSoundMode('off');
    expect(soundMode()).toBe('off');
    setSoundMode('on');
    expect(soundMode()).toBe('on');
  });

  it('stays on, and quiet about it, when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    expect(soundMode()).toBe('on');
  });

  it('vibrates where the browser can, and never throws where it can’t', () => {
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { vibrate });
    expect(canVibrate()).toBe(true);
    cue('review');
    expect(vibrate).toHaveBeenCalledWith(CUES.review.vibrate);
    vi.stubGlobal('navigator', {});
    expect(canVibrate()).toBe(false);
    expect(() => cue('added')).not.toThrow();
    // No tap has unlocked audio here.
    expect(audioReady()).toBe(false);
  });
});
