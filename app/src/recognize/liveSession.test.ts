import { describe, expect, it } from 'vitest';
import type { Quad } from '../vision/geometry';
import { StabilityTracker } from '../vision/stability';
import { cardQuad } from '../vision/testScene';
import { LiveSession } from './liveSession';

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
