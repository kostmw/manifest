import { describe, expect, it } from 'vitest';
import { frameOf, frameTags, withFrame } from './frames';

describe('frameOf', () => {
  it('names the frame that moves things on the card most', () => {
    expect(frameOf({ border_color: 'borderless', frame_effects: ['showcase'] })).toBe('borderless');
    expect(frameOf({ border_color: 'black', full_art: true })).toBe('full-art');
    expect(frameOf({ border_color: 'black', frame_effects: ['legendary', 'extendedart'] })).toBe('extended-art');
    expect(frameOf({ border_color: 'black', frame_effects: ['showcase'] })).toBe('showcase');
    expect(frameOf({ border_color: 'black', frame_effects: ['legendary'] })).toBe('normal');
    expect(frameOf({})).toBe('normal');
  });

  it('tags special frames as such, and leaves cards it doesn’t know alone', () => {
    expect(frameTags('extended-art')).toEqual(['frame:extended-art', 'frame:special']);
    expect(frameTags('normal')).toEqual(['frame:normal']);
    const frames = new Map([['a', 'borderless' as const]]);
    expect(withFrame(['real'], 'a', frames)).toEqual(['real', 'frame:borderless', 'frame:special']);
    expect(withFrame(['real'], 'b', frames)).toEqual(['real']);
    expect(withFrame(['frame:normal'], 'a', frames)).toEqual(['frame:normal']);
  });
});
