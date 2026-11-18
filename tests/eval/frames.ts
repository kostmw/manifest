/**
 * Every eval card's frame, from Scryfall's bulk data, so every report breaks
 * its numbers down by frame: `frame:borderless`, `frame:full-art`,
 * `frame:extended-art`, `frame:showcase` or `frame:normal`, plus
 * `frame:special` for any of the first four.
 *
 * Looked up by Scryfall id in the bulk file once and cached next to it, as
 * `.cache/eval/frames-<bulk file name>.json`.
 */
import { createReadStream, existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { readJsonLines, type ScryfallCard } from '../../scripts/games/mtg';

export type Frame = 'borderless' | 'full-art' | 'extended-art' | 'showcase' | 'normal';

interface FrameFields {
  border_color?: string;
  full_art?: boolean;
  frame_effects?: string[];
  type_line?: string;
}

/**
 * One frame per printing, the one that most changes where things are on the
 * card: no border at all first, then art behind the whole card, then art
 * under the frame's sides, then a showcase frame.
 */
export function frameOf(card: FrameFields): Frame {
  if (card.border_color === 'borderless') return 'borderless';
  // Basic lands' full-art printings are a frame of their own too.
  if (card.full_art) return 'full-art';
  const effects = card.frame_effects ?? [];
  if (effects.includes('extendedart')) return 'extended-art';
  if (effects.includes('showcase')) return 'showcase';
  return 'normal';
}

/** The eval tags for a frame. */
export const frameTags = (frame: Frame): string[] => (frame === 'normal' ? ['frame:normal'] : [`frame:${frame}`, 'frame:special']);

/** Every printing's frame by Scryfall id, from the bulk file (cached). */
export async function framesById(bulkFile: string, cacheDir = '.cache/eval'): Promise<Map<string, Frame>> {
  const cachePath = join(cacheDir, `frames-${basename(bulkFile).replace(/\.jsonl\.gz$/, '')}.json`);
  if (existsSync(cachePath)) return new Map(Object.entries(JSON.parse(await readFile(cachePath, 'utf8')) as Record<string, Frame>));
  const frames = new Map<string, Frame>();
  const input = createReadStream(bulkFile);
  const stream = bulkFile.endsWith('.gz') ? input.pipe(createGunzip()) : input;
  for await (const card of readJsonLines<ScryfallCard & FrameFields>(stream)) frames.set(card.id, frameOf(card));
  await writeFile(cachePath, JSON.stringify(Object.fromEntries(frames)));
  return frames;
}

/** A card's tags with its frame added (left as they are when the id is unknown or already tagged). */
export function withFrame(tags: readonly string[], id: string | undefined, frames: ReadonlyMap<string, Frame> | null): string[] {
  if (!id || !frames || tags.some((tag) => tag.startsWith('frame:'))) return [...tags];
  const frame = frames.get(id);
  return frame ? [...tags, ...frameTags(frame)] : [...tags];
}
