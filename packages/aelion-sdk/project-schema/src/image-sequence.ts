import type { ImageSequenceReference } from './types.js';

/**
 * Map an item time to the image-sequence frame whose interval contains it.
 *
 * Frames are uniform-duration and contiguous starting at zero. The mapping is
 * deterministic and integer-based so preview and export agree on every frame
 * boundary. Returns `undefined` when `itemTimeUs` is negative or at/after the
 * last frame boundary, which callers must treat as fail-closed.
 */
export function imageSequenceFrameIndex(sequence: ImageSequenceReference, itemTimeUs: number): number | undefined {
  if (!Number.isSafeInteger(itemTimeUs) || itemTimeUs < 0) return undefined;
  const frameDurationUs = sequence.frameDurationUs;
  if (!Number.isSafeInteger(frameDurationUs) || frameDurationUs <= 0) return undefined;
  const index = Math.floor(itemTimeUs / frameDurationUs);
  if (index < 0 || index >= sequence.frameAssetIds.length) return undefined;
  return index;
}

/** Total duration of the sequence in microseconds. */
export function imageSequenceDurationUs(sequence: ImageSequenceReference): number {
  return sequence.frameDurationUs * sequence.frameAssetIds.length;
}
