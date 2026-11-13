import { describe, expect, it } from 'vitest';
import type { Quad } from '../vision/geometry';
import { StabilityTracker } from '../vision/stability';
import { cardQuad } from '../vision/testScene';
import { LiveSession, NO_IDENTITY, sameCard, signatureDistance, type SignatureProbe } from './liveSession';

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
    expect(session.failed()).toBe('retry');
    expect(session.next(at(300)).recognize).toBe(true);
    expect(session.failed()).toBe('retry');
    expect(session.next(at(300)).recognize).toBe(true);
    expect(session.failed()).toBe('report');
    // Given up: treated as read until it leaves or the user asks again.
    expect(session.next(at(300))).toMatchObject({ recognize: false, phase: 'read' });
    session.again();
    expect(session.next(at(300)).recognize).toBe(true);
    expect(session.failed()).toBe('retry');
  });

  it('starts counting failures afresh for the next card', () => {
    const session = new LiveSession({ frames: 1, tolerance: 0.02 }, 1, 2);
    session.next(at(300));
    expect(session.failed()).toBe('retry');
    session.next(null);
    session.next(at(300));
    expect(session.failed()).toBe('retry');
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

  it('reads a different card put on top once it looks different on two checks in a row', () => {
    const session = afterReading();
    // A hand covers the card for a frame while the next one goes down.
    session.next(null);
    const step = settle(session, 304);
    expect(step).toMatchObject({ phase: 'read', checkCard: true, recognize: false });
    expect(session.changed(cardB)).toBe(false);
    expect(session.next(at(304)).checkCard).toBe(true);
    expect(session.changed(cardB)).toBe(true);
    expect(session.next(at(304))).toMatchObject({ recognize: true, phase: 'reading' });
    // It reads as another card, so it counts.
    expect(session.settle(cardB, at(304), { name: 'Opt', printingId: null })).toBe(true);
  });

  it('reads a different card put down exactly in place, with nothing seen in between', () => {
    const session = afterReading();
    expect(settle(session, 300).checkCard).toBe(true);
    session.changed(cardB);
    expect(session.changed(cardB)).toBe(true);
  });

  it('counts an identical copy put on top as a second card once the hand has covered the first', () => {
    const session = afterReading();
    session.next(null);
    session.next(null);
    settle(session, 302);
    expect(session.changed(cardAAgain)).toBe(true);
    // A copy after a disturbance counts, though it reads as the same card.
    expect(session.settle(cardAAgain, at(302), { name: 'Sol Ring', printingId: 'cmm-410' })).toBe(true);
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
    expect(session.failed(cardA, at(300))).toBe('report');
    expect(session.next(at(300)).checkCard).toBe(true);
    expect(session.changed(cardAAgain)).toBe(false);
    session.changed(cardB);
    expect(session.changed(cardB)).toBe(true);
  });
});

/** `bits` bits of `signature` flipped: the same card looking a little (or a lot) different. */
function flipped(signature: Uint32Array, bits: number, offset = 0): Uint32Array {
  const out = Uint32Array.from(signature);
  for (let i = offset; i < offset + bits; i++) out[(i >> 5) & 3]! ^= 1 << (i & 31);
  return out;
}

describe('LiveSession under glare and foil shimmer (the owner’s deck box with the flashlight on)', () => {
  const foil = Uint32Array.of(0x12345678, 0x9abcdef0, 0x0f0f0f0f, 0x33333333);
  const GRAY_AND_ADIRA = { name: 'Gray and Adira, Forever Joined', printingId: null };
  /** The fingerprint seen where the card lay: the card, or the empty box once it is gone. */
  const probeSeeing = (signature: Uint32Array): SignatureProbe => () => signature;
  const emptyBox = flipped(foil, 60, 3);

  function lyingAndRead() {
    const session = new LiveSession({ frames: 2, tolerance: 0.02 }, 3);
    session.next(at(300));
    expect(session.next(at(300)).recognize).toBe(true);
    expect(session.settle(foil, at(300), GRAY_AND_ADIRA)).toBe(true);
    return session;
  }

  it('keeps a card that detection loses for a while, as long as it still lies where it was', () => {
    const session = lyingAndRead();
    // Glare washes out the card's edges for ten frames: no outline, but the card is still there.
    for (let i = 0; i < 10; i++) expect(session.next(null, probeSeeing(flipped(foil, 12)))).toMatchObject({ phase: 'read', recognize: false });
    session.next(at(300));
    expect(session.next(at(300)).checkCard).toBe(true);
    expect(session.changed(flipped(foil, 8))).toBe(false);
  });

  it("doesn't take a jump of the outline to something else for the card being moved", () => {
    const session = lyingAndRead();
    // Detection picks the box's floor for a few frames; the card hasn't moved.
    for (let i = 0; i < 4; i++) session.next(cardQuad({ x: 360, y: 640 }, 900), probeSeeing(flipped(foil, 10)));
    session.next(at(300));
    session.next(at(300));
    expect(session.changed(flipped(foil, 6))).toBe(false);
  });

  it('forgets a card that really left: the spot shows the empty box', () => {
    const session = lyingAndRead();
    for (let i = 0; i < 3; i++) session.next(null, probeSeeing(emptyBox));
    session.next(at(300));
    expect(session.next(at(300))).toMatchObject({ recognize: true, checkCard: false });
  });

  it('reads a shimmering card again, but doesn’t count it again when it reads as the same card', () => {
    const session = lyingAndRead();
    const shimmer = flipped(foil, 34);
    session.next(at(300));
    session.next(at(300));
    // Past the new-card distance twice in a row: read again.
    expect(session.changed(shimmer)).toBe(false);
    expect(session.changed(shimmer)).toBe(true);
    expect(session.next(at(300)).recognize).toBe(true);
    // Same name (the printing unsure, as foils often are): the same card. Not counted.
    expect(session.settle(shimmer, at(300), GRAY_AND_ADIRA)).toBe(false);
    // That look is remembered, so it doesn't trigger another read.
    expect(session.next(at(300))).toMatchObject({ phase: 'read', checkCard: true });
    expect(session.changed(flipped(foil, 33))).toBe(false);
    expect(session.changed(flipped(foil, 33))).toBe(false);
  });

  it("doesn't count a shimmering card that couldn't be read the second time either", () => {
    const session = new LiveSession({ frames: 1, tolerance: 0.02 }, 3, 1);
    session.next(at(300));
    expect(session.settle(foil, at(300), NO_IDENTITY)).toBe(true);
    session.next(at(300));
    session.changed(flipped(foil, 30));
    expect(session.changed(flipped(foil, 30))).toBe(true);
    expect(session.failed(flipped(foil, 30), at(300))).toBe('same-card');
  });

  it('still counts a card with plainly other art, even when the name reads the same (another Forest)', () => {
    expect(sameCard({ name: 'Forest', printingId: null }, { name: 'Forest', printingId: null }, 52)).toBe(false);
    expect(sameCard({ name: 'Forest', printingId: 'dmu-277' }, { name: 'Forest', printingId: 'one-271' }, 30)).toBe(false);
    expect(sameCard({ name: 'Forest', printingId: 'dmu-277' }, { name: 'Forest', printingId: 'dmu-277' }, 30)).toBe(true);
    expect(sameCard({ name: 'Opt', printingId: null }, { name: 'Sol Ring', printingId: null }, 26)).toBe(false);
    expect(sameCard(NO_IDENTITY, NO_IDENTITY, 30)).toBe(true);
    expect(sameCard(NO_IDENTITY, NO_IDENTITY, 56)).toBe(false);
  });

  it('counts an identical copy put on top, once the hand or the falling card covered the first', () => {
    const session = lyingAndRead();
    // The next copy slides down the chute over the first: the spot looks different meanwhile.
    session.next(null, probeSeeing(emptyBox));
    session.next(at(380), probeSeeing(emptyBox));
    session.next(at(301));
    session.next(at(301));
    expect(session.changed(flipped(foil, 5))).toBe(true);
    expect(session.settle(flipped(foil, 5), at(301), GRAY_AND_ADIRA)).toBe(true);
  });
});
