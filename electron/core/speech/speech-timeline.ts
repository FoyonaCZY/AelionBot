// Fine-grained speech segmentation for narrated demonstrations: scans 100 ms energy frames, skips silent pauses
// during clicking (zero ASR cost), groups natural phrases into ~4-15 s chunks, and splits long continuous speech
// at quiet moments with speechPieces.
import { speechPieces } from './speech-audio';

export interface SpeechSegmentOptions {
  /** Frame length in milliseconds for energy scanning (default 100 ms). */
  frameMs?: number;
  /** Minimum silence gap in milliseconds that separates spoken phrases (default 350 ms). */
  minSilenceMs?: number;
  /** Minimum voiced span in milliseconds to keep, filtering out brief clicks/pops (default 200 ms). */
  minSpeechMs?: number;
  /** Preferred minimum chunk duration in seconds when merging nearby phrases across brief pauses (default 4 s). */
  minChunkSeconds?: number;
  /** Maximum pause in milliseconds across which short adjacent phrases may merge (default 800 ms). */
  mergeGapMs?: number;
  /** Maximum chunk duration in seconds before splitting at the quietest moment (default 15 s). */
  maxSeconds?: number;
  /** Padding added before and after each voiced span in milliseconds (default 100 ms). */
  padMs?: number;
  /** Optional explicit RMS threshold (16-bit PCM scale 0..32767). */
  silenceRms?: number;
}

/**
 * Returns sample ranges `[start, end]` covering only voiced speech regions, skipping pure-silence gaps.
 * Returns `[]` when the recording is silent or empty.
 */
export function speechSegments(
  samples: Int16Array,
  sampleRate: number,
  options: SpeechSegmentOptions = {},
): Array<[number, number]> {
  if (!samples.length || sampleRate <= 0) return [];
  const frameMs = Math.max(20, options.frameMs ?? 100),
    minSilenceMs = Math.max(frameMs, options.minSilenceMs ?? 350),
    minSpeechMs = Math.max(frameMs, options.minSpeechMs ?? 200),
    minChunkSeconds = Math.max(1, options.minChunkSeconds ?? 4),
    mergeGapMs = Math.max(0, options.mergeGapMs ?? 800),
    maxSeconds = Math.max(2, options.maxSeconds ?? 15),
    padMs = Math.max(0, options.padMs ?? 100);

  const frameSamples = Math.max(1, Math.round((sampleRate * frameMs) / 1000)),
    frameCount = Math.ceil(samples.length / frameSamples),
    energies = new Float64Array(frameCount);

  let maxRms = 0;
  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * frameSamples,
      end = Math.min(samples.length, start + frameSamples);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const value = samples[i];
      sum += value * value;
    }
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    energies[frame] = rms;
    if (rms > maxRms) maxRms = rms;
  }

  // Digital silence or dead microphone: skip all ASR calls.
  if (maxRms < (options.silenceRms ?? 100)) return [];

  const sorted = Float64Array.from(energies).sort(),
    noiseFloor = sorted[Math.floor(frameCount * 0.15)] ?? 0,
    floor = options.silenceRms ?? Math.min(250, maxRms * 0.2),
    threshold = options.silenceRms ?? Math.max(floor, Math.min(noiseFloor * 2.2, maxRms * 0.18));

  // A 350 ms silence spans at least 3 full 100 ms frames; bridging only strictly shorter dips preserves real pauses.
  const minSilenceFrames = Math.max(1, Math.floor(minSilenceMs / frameMs)),
    minSpeechFrames = Math.max(1, Math.round(minSpeechMs / frameMs));

  // Find voiced islands separated by at least `minSilenceFrames` quiet frames.
  const islands: Array<[number, number]> = [];
  let inSpeech = false,
    speechStart = 0,
    lastLoud = 0,
    quietRun = 0;
  for (let frame = 0; frame < frameCount; frame++) {
    const loud = energies[frame] >= threshold;
    if (loud) {
      if (!inSpeech) {
        inSpeech = true;
        speechStart = frame;
      }
      lastLoud = frame;
      quietRun = 0;
    } else if (inSpeech) {
      quietRun++;
      if (quietRun >= minSilenceFrames) {
        if (lastLoud - speechStart + 1 >= minSpeechFrames) islands.push([speechStart, lastLoud + 1]);
        inSpeech = false;
        quietRun = 0;
      }
    }
  }
  if (inSpeech && lastLoud - speechStart + 1 >= minSpeechFrames) islands.push([speechStart, lastLoud + 1]);
  if (!islands.length) return [];

  // Merge adjacent voiced islands across very brief pauses when building ~4-15 s chunks.
  const mergeGapFrames = Math.floor(mergeGapMs / frameMs),
    minChunkFrames = Math.round((minChunkSeconds * 1000) / frameMs),
    maxChunkFrames = Math.max(minChunkFrames, Math.round((maxSeconds * 1000) / frameMs));

  const merged: Array<[number, number]> = [];
  for (const [start, end] of islands) {
    const previous = merged.at(-1);
    if (
      previous &&
      start - previous[1] <= mergeGapFrames &&
      previous[1] - previous[0] < minChunkFrames &&
      end - previous[0] <= maxChunkFrames
    ) {
      previous[1] = end;
    } else {
      merged.push([start, end]);
    }
  }

  // Convert frame spans to padded sample ranges without overlapping neighbors, splitting spans > maxSeconds.
  const padSamples = Math.round((sampleRate * padMs) / 1000),
    maxSamples = Math.floor(sampleRate * maxSeconds),
    ranges: Array<[number, number]> = [];

  for (let index = 0; index < merged.length; index++) {
    const [startFrame, endFrame] = merged[index];
    const prevEnd = index > 0 ? merged[index - 1][1] * frameSamples : 0;
    const nextStart = index + 1 < merged.length ? merged[index + 1][0] * frameSamples : samples.length;
    const rawStart = Math.max(0, startFrame * frameSamples - padSamples),
      rawEnd = Math.min(samples.length, endFrame * frameSamples + padSamples);
    const start = Math.max(prevEnd, rawStart),
      end = Math.min(nextStart, rawEnd);
    if (end <= start) continue;

    if (end - start <= maxSamples) {
      ranges.push([start, end]);
    } else {
      for (const [pieceStart, pieceEnd] of speechPieces(samples.subarray(start, end), sampleRate, maxSeconds)) {
        ranges.push([start + pieceStart, start + pieceEnd]);
      }
    }
  }

  return ranges;
}
