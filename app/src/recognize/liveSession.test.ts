import { describe, expect, it } from 'vitest';
import type { Quad } from '../vision/geometry';
import { StabilityTracker } from '../vision/stability';
import { cardQuad } from '../vision/testScene';
import { LiveSession, signatureDistance } from './liveSession';

const at = (x: number): Quad => cardQuad({ x, y: 300 }, 400);

describe('StabilityTracker', () => {
  it('counts steady frames and starts over when the card moves', () => {
    const tracker = new StabilityTracker({ frames: 3, tolerance: 0.02 });
    expect(tracker.update(at(300)).steadyFrames).toBe(1);
    expect(tracker.update(at(301)).steadyFrames).toBe(2);
    expect(tracker.update(at(302))).toEqual({ steadyFrames: 3, stable: true });
    expect(tracker.update(at(340)).steadyFrames).toBe(1);
    expect(tracker.update(null)).toEqual({ steadyFrames: 0, stable: false });
  });
});

describe('LiveSession', () => {
  it('reads a card once it is steady, and only once while it stays', () => {
    const session = new LiveSession({ frames: 2, tolerance: 0.02 }, 2);
    expect(session.next(at(300)).recognize).toBe(false);
    expect(session.next(at(300)).recognize).toBe(true);
    session.markRead();
    expect(session.next(at(300)).recognize).toBe(false);
    expect(session.next(at(301)).recognize).toBe(false);
  });

  it('reads again after the card leaves, so two copies in a row count twice', () => {
    const session = new LiveSession({ frames: 1, tolerance: 0.02 }, 2);
    expect(session.next(at(300)).recognize).toBe(true);
    session.markRead();
    session.next(null);
    // One empty frame could be a glitch; two mean the card is gone.
    expect(session.next(at(300)).recognize).toBe(false);
    session.next(null);
    session.next(null);
    expect(session.next(at(300)).recognize).toBe(true);
  });

  it('reads again on request', () => {
    const session = new LiveSession({ frames: 1, tolerance: 0.02 });
    session.next(at(300));
    session.markRead();
    session.again();
    expect(session.next(at(300)).recognize).toBe(true);
  });

  it('says where the card is up to', () => {
    const session = new LiveSession({ frames: 3, tolerance: 0.02 }, 1);
    expect(session.next(null).phase).toBe('empty');
    expect(session.next(at(300)).phase).toBe('settling');
    // One frame before the read: the next steady frame is read.
    expect(session.next(at(300)).phase).toBe('reading');
    expect(session.next(at(300))).toMatchObject({ phase: 'reading', recognize: true });
    session.markRead();
    expect(session.next(at(300)).phase).toBe('read');
    expect(session.next(null).phase).toBe('empty');
  });

  it('gives up on a card whose reads keep failing, instead of trying forever', () => {
    const session = new LiveSession({ frames: 1, tolerance: 0.02 }, 1, 3);
    expect(session.next(at(300)).recognize).toBe(true);
    expect(session.failed()).toBe(false);
    expect(session.next(at(300)).recognize).toBe(true);
    expect(session.failed()).toBe(false);
    expect(session.next(at(300)).recognize).toBe(true);
    expect(session.failed()).toBe(true);
    // Given up: treated as read until it leaves or the user asks again.
    expect(session.next(at(300))).toMatchObject({ recognize: false, phase: 'read' });
    session.again();
    expect(session.next(at(300)).recognize).toBe(true);
    expect(session.failed()).toBe(false);
  });

  it('starts counting failures afresh for the next card', () => {
    const session = new LiveSession({ frames: 1, tolerance: 0.02 }, 1, 2);
    session.next(at(300));
    expect(session.failed()).toBe(false);
    session.next(null);
    session.next(at(300));
    expect(session.failed()).toBe(false);
  });

});

describe('LiveSession with cards stacked on top of each other', () => {
  // Fingerprints: two different cards, and the first again as the next frame sees it.
  const cardA = Uint32Array.of(0x12345678, 0x9abcdef0, 0x0f0f0f0f, 0x33333333);
  const cardAAgain = Uint32Array.of(0x12345679, 0x9abcdef0, 0x0f0f0f0f, 0x33333333);
  const cardB = Uint32Array.of(0xedcba987, 0x6543210f, 0xf0f0f0f0, 0xcccccccc);

  /** A session that has just read card A, lying at x = 300. */
  function afterReading() {
    const session = new LiveSession({ frames: 2, tolerance: 0.02 }, 3);
    session.next(at(300));
    expect(session.next(at(300)).recognize).toBe(true);
    session.markRead(cardA, at(300));
    return session;
  }

  /** Frames of a card settling at `x`; returns the last step. */
  function settle(session: LiveSession, x: number) {
    session.next(at(x));
    return session.next(at(x));
  }

  it('tells the fingerprints apart', () => {
    expect(signatureDistance(cardA, cardAAgain)).toBe(1);
    expect(signatureDistance(cardA, cardB)).toBeGreaterThan(24);
  });

  it('reads a different card put on top as soon as it is steady', () => {
    const session = afterReading();
    // A hand covers the card for a frame while the next one goes down.
    session.next(null);
    const step = settle(session, 304);
    expect(step).toMatchObject({ phase: 'read', checkCard: true, recognize: false });
    expect(session.changed(cardB)).toBe(true);
    expect(session.next(at(304))).toMatchObject({ recognize: true, phase: 'reading' });
  });

  it('reads a different card put down exactly in place, with nothing seen in between', () => {
    const session = afterReading();
    expect(settle(session, 300).checkCard).toBe(true);
    expect(session.changed(cardB)).toBe(true);
  });

  it('counts an identical copy put on top as a second card once the hand has covered the first', () => {
    const session = afterReading();
    session.next(null);
    session.next(null);
    settle(session, 302);
    expect(session.changed(cardAAgain)).toBe(true);
    session.markRead(cardAAgain, at(302));
    // And a third.
    session.next(null);
    session.next(null);
    settle(session, 301);
    expect(session.changed(cardAAgain)).toBe(true);
  });

  it('notices a copy put down without the card ever leaving view, if the outline jumped', () => {
    const session = afterReading();
    // The new copy lands well away from where the last one was read.
    session.next(at(380));
    settle(session, 380);
    expect(session.changed(cardAAgain)).toBe(true);
  });

  it("doesn't count a card again after a one-frame glitch in detection", () => {
    const session = afterReading();
    // Missed for one frame…
    session.next(null);
    settle(session, 300);
    expect(session.changed(cardAAgain)).toBe(false);
    // …or its art box taken for the card for one frame.
    session.next(cardQuad({ x: 300, y: 240 }, 220));
    settle(session, 300);
    expect(session.changed(cardAAgain)).toBe(false);
  });

  it("doesn't read the same card twice when it just lies there", () => {
    const session = afterReading();
    expect(settle(session, 300).checkCard).toBe(true);
    expect(session.changed(cardAAgain)).toBe(false);
    expect(session.next(at(300))).toMatchObject({ recognize: false, phase: 'read' });
    for (let i = 0; i < 20; i++) session.next(at(300 + (i % 3)));
    expect(session.changed(cardAAgain)).toBe(false);
  });

  it("doesn't read the same card twice when it is nudged", () => {
    const session = afterReading();
    settle(session, 312);
    settle(session, 316);
    expect(session.changed(cardAAgain)).toBe(false);
  });

  it('treats a card read after leaving the frame as new, whatever it looks like', () => {
    const session = afterReading();
    session.next(null);
    session.next(null);
    session.next(null);
    session.next(at(300));
    expect(session.next(at(300))).toMatchObject({ recognize: true, checkCard: false });
  });

  it('remembers a card it gave up on, so it is not retried forever', () => {
    const session = new LiveSession({ frames: 1, tolerance: 0.02 }, 3, 1);
    expect(session.next(at(300)).recognize).toBe(true);
    expect(session.failed(cardA, at(300))).toBe(true);
    expect(session.next(at(300)).checkCard).toBe(true);
    expect(session.changed(cardAAgain)).toBe(false);
    expect(session.changed(cardB)).toBe(true);
  });
});
