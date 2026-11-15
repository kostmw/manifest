import { describe, expect, it } from 'vitest';
import type { Quad } from '../vision/geometry';
import { StabilityTracker } from '../vision/stability';
import { cardQuad } from '../vision/testScene';
import { CAMERA_SETTLE_MS, LiveSession, NO_IDENTITY, sameCard, sameCardReason, signatureDistance, type CardIdentity, type SignatureProbe } from './liveSession';

const at = (x: number): Quad => cardQuad({ x, y: 300 }, 400);
/** What a read said: a name, a sure printing, and the best printing however unsure. */
const id = (name: string | null, printingId: string | null = null, guess: string | null = printingId): CardIdentity => ({ name, printingId, guess });

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
    expect(session.settle(cardB, at(304), id('Opt'))).toBe(true);
  });

  it('reads a different card put down exactly in place, with nothing seen in between', () => {
    const session = afterReading();
    expect(settle(session, 300).checkCard).toBe(true);
    session.changed(cardB);
    expect(session.changed(cardB)).toBe(true);
  });

  it('counts an identical copy put on top as a second card once the hand has covered the first', () => {
    const session = afterReading();
    // The hand covers the card for three frames while the copy goes down: the card read last is gone.
    session.next(null);
    session.next(null);
    session.next(null);
    session.next(at(302));
    // So the copy is read like any new card, and counts though it reads as the same card.
    expect(session.next(at(302))).toMatchObject({ recognize: true, checkCard: false });
    expect(session.settle(cardAAgain, at(302), id('Sol Ring', 'cmm-410'))).toBe(true);
    // And a third.
    session.next(null);
    session.next(null);
    session.next(null);
    session.next(at(301));
    expect(session.next(at(301)).recognize).toBe(true);
  });

  it("doesn't count a card as gone for two frames of a hand, or when its outline only jumps (a hand-held phone moved)", () => {
    const session = afterReading();
    session.next(null);
    session.next(null);
    settle(session, 302);
    expect(session.changed(cardAAgain)).toBe(false);
    // The phone moves: the outline lands well away from where the card was read, but near.
    session.next(at(380));
    settle(session, 380);
    expect(session.changed(cardAAgain)).toBe(false);
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
  const GRAY_AND_ADIRA = id('Gray and Adira, Forever Joined');
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
    expect(session.lastSameCard).toBe('same name (Gray and Adira, Forever Joined), printing unsure, artwork 34 bits from how it looked before');
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
    expect(sameCard(id('Forest', null, 'dmu-277'), id('Forest', null, 'one-271'), 52)).toBe(false);
    expect(sameCard(id('Forest'), id('Forest'), 52)).toBe(false);
    expect(sameCard(id('Forest', 'dmu-277'), id('Forest', 'one-271'), 30)).toBe(false);
    expect(sameCard(id('Forest', 'dmu-277'), id('Forest', 'dmu-277'), 30)).toBe(true);
    expect(sameCard(id('Opt'), id('Sol Ring'), 26)).toBe(false);
    expect(sameCard(NO_IDENTITY, NO_IDENTITY, 30)).toBe(true);
    expect(sameCard(NO_IDENTITY, NO_IDENTITY, 56)).toBe(false);
  });

  it('takes two reads that put the same printing first for one card, however far its look drifted (round 6: a foil under the flashlight)', () => {
    // A review read (printing unsure), then a sure one, 52 bits apart in look.
    expect(sameCard(id('Stray from History', null, 'trk-130'), id('Stray from History', 'trk-130'), 52)).toBe(true);
    expect(sameCard(id(null, null, 'trk-130'), id('Stray from History', null, 'trk-130'), 60)).toBe(true);
    // Different names still differ, whatever the guesses.
    expect(sameCard(id('Opt', null, 'x'), id('Sol Ring', null, 'x'), 10)).toBe(false);
    // After the flashlight changed, the same name is enough: the looks can't be compared.
    expect(sameCard(id('Forest', null, 'dmu-277'), id('Forest', null, 'one-271'), 52, true)).toBe(true);
    expect(sameCard(id('Forest', 'dmu-277'), id('Forest', 'one-271'), 52, true)).toBe(false);
  });

  it('counts an identical copy put on top, once the hand or the falling card covered the first', () => {
    const session = lyingAndRead();
    // The next copy slides down the chute over the first: for three frames there is no card where it lay.
    for (let i = 0; i < 3; i++) session.next(null, probeSeeing(emptyBox));
    session.next(at(301));
    expect(session.next(at(301)).recognize).toBe(true);
    expect(session.settle(flipped(foil, 5), at(301), GRAY_AND_ADIRA)).toBe(true);
  });

  it('keeps a foil whose look a moving hotspot changes by up to 44 bits, with its edges lost (round 6)', () => {
    const session = lyingAndRead();
    // Measured on the owner's crops of one foil under the flashlight: median 36, p90 48 from its look.
    for (let i = 0; i < 30; i++) expect(session.next(null, probeSeeing(flipped(foil, 30 + (i % 15)))).phase).toBe('read');
    expect(session.lastFrame).toMatchObject({ outline: false, probe: 44, gone: 0 });
    session.next(at(300));
    expect(session.next(at(300))).toMatchObject({ phase: 'read', checkCard: true, recognize: false });
  });

  it('follows a card the phone drifts away from in steps, farther than a quarter of its diagonal in all', () => {
    const session = lyingAndRead();
    // Each step is 14% of the diagonal; 70 px in all is 30% from where it was read. Its look is off (glare).
    for (const x of [300, 335, 335, 370, 370]) session.next(at(x), probeSeeing(flipped(foil, 60)));
    expect(session.lastFrame).toMatchObject({ outline: true, moved: 0, gone: 0 });
    expect(session.next(at(370))).toMatchObject({ phase: 'read', checkCard: true });
  });

  it('keeps a card the phone has moved far off its spot, when the outline found there looks like it', () => {
    const session = lyingAndRead();
    const far = at(420);
    // Where it lay is the empty box now; the outline 30% away is the card.
    const probe: SignatureProbe = (corners) => (corners[0].x === far[0].x ? flipped(foil, 40) : emptyBox);
    for (let i = 0; i < 5; i++) session.next(far, probe);
    expect(session.lastFrame).toMatchObject({ outline: true, moved: 0, gone: 0 });
    expect(session.next(far, probe)).toMatchObject({ phase: 'read', checkCard: true });
    // Something unlike it that far off, with the box empty where it lay: gone.
    const elsewhere: SignatureProbe = () => emptyBox;
    for (let i = 0; i < 3; i++) session.next(at(120), elsewhere);
    expect(session.next(at(120))).toMatchObject({ recognize: true, checkCard: false });
  });

  it('takes a blown-out or black picture for no news, neither keeping the card nor taking it away', () => {
    const session = lyingAndRead();
    const blind: SignatureProbe = () => null;
    for (let i = 0; i < 20; i++) session.next(null, blind);
    expect(session.lastFrame).toMatchObject({ outline: false, probe: null, gone: 0 });
    expect(session.next(null, probeSeeing(emptyBox)).phase).toBe('read');
    session.next(null, probeSeeing(emptyBox));
    for (let i = 0; i < 5; i++) session.next(null, blind);
    expect(session.lastFrame.gone).toBe(2);
    // The third frame showing the empty box: gone.
    expect(session.next(null, probeSeeing(emptyBox)).phase).toBe('empty');
  });

  it('needs the card gone for frames in a row, not now and then', () => {
    const session = lyingAndRead();
    for (let i = 0; i < 10; i++) {
      session.next(null, probeSeeing(emptyBox));
      session.next(null, probeSeeing(emptyBox));
      session.next(at(300));
    }
    expect(session.next(at(300))).toMatchObject({ phase: 'read', recognize: false });
  });

  it('a review marks the card in view too, so a second look at it is not counted', () => {
    const session = new LiveSession({ frames: 2, tolerance: 0.02 }, 3);
    session.next(at(300));
    session.next(at(300));
    // Sent to review: the name was fairly sure, the printing not.
    expect(session.settle(foil, at(300), id('Stray from History', null, 'trk-130'))).toBe(true);
    session.next(at(300));
    session.next(at(300));
    session.changed(flipped(foil, 52));
    expect(session.changed(flipped(foil, 52))).toBe(true);
    expect(session.readReason).toEqual({ trigger: 'different', distance: 52 });
    // Read again, now sure: the same printing came first both times, so not counted.
    expect(session.settle(flipped(foil, 52), at(300), id('Stray from History', 'trk-130'))).toBe(false);
    expect(session.lastSameCard).toBe('same best printing (trk-130), unsure, artwork 52 bits from how it looked before');
  });
});

describe('LiveSession when the flashlight switches', () => {
  const foil = Uint32Array.of(0x12345678, 0x9abcdef0, 0x0f0f0f0f, 0x33333333);
  const STRAY = id('Stray from History', null, 'trk-130');
  const probeSeeing = (signature: Uint32Array): SignatureProbe => () => signature;

  function lyingAndRead() {
    let now = 0;
    const clock = { advance: (ms: number) => (now += ms) };
    const session = new LiveSession({ frames: 2, tolerance: 0.02 }, 3, 3, () => now);
    session.next(at(300));
    session.next(at(300));
    expect(session.settle(foil, at(300), STRAY)).toBe(true);
    return { session, clock };
  }

  it('holds the card while the camera re-exposes, then reads it once as a check, and doesn’t count the same card', () => {
    const { session, clock } = lyingAndRead();
    session.cameraChanged();
    // The picture blows out and the phone shakes: no outline, nothing like the card where it lay.
    for (let i = 0; i < 8; i++) {
      expect(session.next(null, probeSeeing(flipped(foil, 60)))).toMatchObject({ phase: 'read', recognize: false });
      clock.advance(120);
    }
    expect(session.lastFrame).toMatchObject({ hold: true, gone: 0 });
    // Steady again, but still settling: no check yet.
    expect(session.next(at(300)).checkCard).toBe(false);
    clock.advance(CAMERA_SETTLE_MS);
    expect(session.next(at(300))).toMatchObject({ checkCard: true });
    // The card under the flashlight looks unlike before: read at once, without waiting for a second check.
    expect(session.changed(flipped(foil, 50))).toBe(true);
    expect(session.readReason).toEqual({ trigger: 'camera', distance: 50 });
    // Same name, another printing guessed under the glare: still the card already counted.
    expect(session.settle(flipped(foil, 50), at(300), id('Stray from History', null, 'ptrk-130'))).toBe(false);
    expect(session.lastSameCard).toBe('same name (Stray from History) after the flashlight changed, artwork 50 bits from how it looked before');
    // And that look is now a look of it.
    session.next(at(300));
    expect(session.changed(flipped(foil, 50))).toBe(false);
    expect(session.changed(flipped(foil, 50))).toBe(false);
  });

  it('still counts a different card found by that check', () => {
    const { session, clock } = lyingAndRead();
    session.cameraChanged();
    clock.advance(CAMERA_SETTLE_MS + 1);
    session.next(at(300));
    session.next(at(300));
    expect(session.changed(flipped(foil, 50))).toBe(true);
    expect(session.settle(flipped(foil, 50), at(300), id('Officer', 'ttrk-13'))).toBe(true);
  });

  it('doesn’t read a card that still looks the same afterwards', () => {
    const { session, clock } = lyingAndRead();
    session.cameraChanged();
    clock.advance(CAMERA_SETTLE_MS + 1);
    session.next(at(300));
    session.next(at(300));
    expect(session.changed(flipped(foil, 10))).toBe(false);
    expect(session.changed(flipped(foil, 30))).toBe(false);
  });

  it('forgets a card taken away during the hold, once the camera has settled', () => {
    const { session, clock } = lyingAndRead();
    session.cameraChanged();
    clock.advance(CAMERA_SETTLE_MS + 1);
    for (let i = 0; i < 3; i++) session.next(null, probeSeeing(flipped(foil, 60)));
    session.next(at(300));
    expect(session.next(at(300))).toMatchObject({ recognize: true, checkCard: false });
    expect(session.readReason.trigger).toBe('fresh');
  });
});

describe('sameCardReason', () => {
  it('says which rule took two reads for one card', () => {
    expect(sameCardReason(id('Opt', 'dom-60'), id('Opt', 'dom-60'), 30)).toBe('same printing (dom-60), artwork 30 bits from how it looked before');
    expect(sameCardReason(NO_IDENTITY, NO_IDENTITY, 28)).toBe('name not read, artwork 28 bits from how it looked before');
  });
});
