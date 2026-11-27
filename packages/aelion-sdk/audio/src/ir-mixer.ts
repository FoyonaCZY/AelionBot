import { sampleBoundaryUs, throwIfAborted } from '@aelionsdk/core';
import { evaluateAnimatableNumber, evaluateAudioState, mapIrSourceTime, type RenderIr } from '@aelionsdk/render-ir';

import { pitchPreservingTimeStretch } from './time-stretch.js';

export interface PcmSourceBlock {
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly frameCount: number;
  readonly interleaved: Float32Array;
}

export interface IrPcmSource {
  pcmRange(
    assetId: string,
    streamIndex: number,
    startUs: number,
    durationUs: number,
    signal?: AbortSignal,
  ): Promise<PcmSourceBlock>;
}

export interface RenderIrAudioOptions {
  readonly ir: RenderIr;
  readonly startFrame: number;
  readonly frameCount: number;
  readonly channelCount: number;
  readonly source: IrPcmSource;
  /** Optional stem selection used by waveform, silence removal and sidechain export. */
  readonly trackIds?: readonly string[];
  readonly itemIds?: readonly string[];
  readonly signal?: AbortSignal;
}

function gains(gain: number, pan: number): readonly [number, number] {
  const angle = ((pan + 1) * Math.PI) / 4;
  return [gain * Math.cos(angle), gain * Math.sin(angle)];
}

function objectProperty(value: unknown): Readonly<Record<string, import('@aelionsdk/core').JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, import('@aelionsdk/core').JsonValue>>)
    : {};
}

function fadeEnvelope(
  audio: Readonly<Record<string, import('@aelionsdk/core').JsonValue>>,
  localTimeUs: number,
  durationUs: number,
): number {
  const fadeInUs = typeof audio.fadeInUs === 'number' ? audio.fadeInUs : 0;
  const fadeOutUs = typeof audio.fadeOutUs === 'number' ? audio.fadeOutUs : 0;
  const fadeIn = fadeInUs > 0 ? Math.max(0, Math.min(1, localTimeUs / fadeInUs)) : 1;
  const remainingUs = durationUs - localTimeUs;
  const fadeOut = fadeOutUs > 0 ? Math.max(0, Math.min(1, remainingUs / fadeOutUs)) : 1;
  return Math.min(fadeIn, fadeOut);
}

function interpolatedChannel(
  block: PcmSourceBlock,
  sourceFrame: number,
  nextSourceFrame: number,
  fraction: number,
  channel: number,
): number {
  if (channel >= block.channelCount) return 0;
  const first = block.interleaved[sourceFrame * block.channelCount + channel] ?? 0;
  const next = block.interleaved[nextSourceFrame * block.channelCount + channel] ?? first;
  return first + (next - first) * fraction;
}

interface MappedPcmFrame {
  readonly outputOffset: number;
  readonly sourceTimeUs: number;
}

interface PcmRequestSegment {
  readonly sourceStartUs: number;
  readonly durationUs: number;
  readonly frames: readonly MappedPcmFrame[];
}

function sampleBoundaryCeilUs(sampleIndex: number, sampleRate: number): number {
  const floorUs = sampleBoundaryUs(sampleIndex, sampleRate);
  const remainder = (BigInt(sampleIndex) * 1_000_000n) % BigInt(sampleRate);
  const result = floorUs + (remainder === 0n ? 0 : 1);
  if (!Number.isSafeInteger(result)) {
    throw new RangeError('PCM request boundary exceeds the safe integer range');
  }
  return result;
}

function pcmRequestSegments(
  active: ReturnType<typeof evaluateAudioState>['clips'][number],
  startFrame: number,
  frameCount: number,
  sampleRate: number,
): readonly PcmRequestSegment[] {
  const source = active.clip.source;
  const activeEndUs = active.sequenceStartUs + active.durationUs;
  const mappedFrames: MappedPcmFrame[] = [];
  for (let outputOffset = 0; outputOffset < frameCount; outputOffset += 1) {
    const sequenceTimeUs = sampleBoundaryUs(startFrame + outputOffset, sampleRate);
    if (sequenceTimeUs < active.sequenceStartUs || sequenceTimeUs >= activeEndUs) continue;
    const sourceTimeUs = mapIrSourceTime(
      source,
      active.clip.range.durationUs,
      sequenceTimeUs - active.clip.range.startUs,
    );
    if (sourceTimeUs !== null) mappedFrames.push({ outputOffset, sourceTimeUs });
  }
  if (mappedFrames.length === 0) return [];

  const groups: MappedPcmFrame[][] = [];
  let current: MappedPcmFrame[] = [];
  let direction = 0;
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const frame of mappedFrames) {
    const previous = current.at(-1);
    const difference = previous === undefined ? 0 : frame.sourceTimeUs - previous.sourceTimeUs;
    const nextDirection = Math.sign(difference);
    const nextMinimum = Math.min(minimum, frame.sourceTimeUs);
    const nextMaximum = Math.max(maximum, frame.sourceTimeUs);
    const discontinuity =
      previous !== undefined &&
      ((direction !== 0 && nextDirection !== 0 && direction !== nextDirection) ||
        Math.abs(difference) > 250_000 ||
        nextMaximum - nextMinimum > 1_000_000);
    if (discontinuity) {
      groups.push(current);
      current = [];
      direction = 0;
      minimum = Number.POSITIVE_INFINITY;
      maximum = Number.NEGATIVE_INFINITY;
    }
    const groupPrevious = current.at(-1);
    current.push(frame);
    minimum = Math.min(minimum, frame.sourceTimeUs);
    maximum = Math.max(maximum, frame.sourceTimeUs);
    if (groupPrevious !== undefined) {
      const groupDirection = Math.sign(frame.sourceTimeUs - groupPrevious.sourceTimeUs);
      if (groupDirection !== 0) direction = groupDirection;
    }
  }
  if (current.length > 0) groups.push(current);

  const sourceRangeEndUs = source.sourceRange.startUs + source.sourceRange.durationUs;
  const sampleDurationUs = sampleBoundaryCeilUs(1, sampleRate);
  const segments: PcmRequestSegment[] = [];
  for (const frames of groups) {
    const times = frames.map((frame) => frame.sourceTimeUs);
    const sourceStartUs = Math.min(...times);
    const sourceEndUs = Math.max(...times);
    const durationUs = Math.max(
      1,
      Math.min(sourceRangeEndUs - sourceStartUs, sourceEndUs - sourceStartUs + sampleDurationUs),
    );
    segments.push({ sourceStartUs, durationUs, frames });
  }
  return segments;
}

export async function renderIrAudio(options: RenderIrAudioOptions): Promise<Float32Array> {
  throwIfAborted(options.signal, 'Render IR audio');
  if (!Number.isSafeInteger(options.startFrame) || options.startFrame < 0) {
    throw new RangeError('startFrame must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(options.frameCount) || options.frameCount <= 0) {
    throw new RangeError('frameCount must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.channelCount) || options.channelCount < 1 || options.channelCount > 8) {
    throw new RangeError('Audio mixer supports between 1 and 8 output channels');
  }
  const startUs = sampleBoundaryUs(options.startFrame, options.ir.sampleRate);
  // A microsecond range whose end is floored can be one source sample short
  // whenever the target frame boundary is fractional in microseconds (for
  // example most 48 kHz block boundaries). Cover the complete final target
  // sample; per-segment copy bounds below discard any provider over-read.
  const endUs = sampleBoundaryCeilUs(options.startFrame + options.frameCount, options.ir.sampleRate);
  const selectedTracks = options.trackIds === undefined ? undefined : new Set(options.trackIds);
  const selectedItems = options.itemIds === undefined ? undefined : new Set(options.itemIds);
  const evaluatedState = evaluateAudioState(options.ir, startUs, endUs - startUs);
  const state = {
    ...evaluatedState,
    clips: evaluatedState.clips.filter(
      (active) =>
        (selectedTracks === undefined || selectedTracks.has(active.clip.trackId)) &&
        (selectedItems === undefined || selectedItems.has(active.clip.id)),
    ),
  };
  const output = new Float32Array(options.frameCount * options.channelCount);
  await Promise.all(
    state.clips.map(async (active) => {
      const trackAudio = objectProperty(active.trackAudio);
      const clipAudio = objectProperty(active.clip.audio);
      for (const segment of pcmRequestSegments(active, options.startFrame, options.frameCount, options.ir.sampleRate)) {
        const block = await options.source.pcmRange(
          active.clip.source.assetId,
          active.clip.source.streamIndex,
          segment.sourceStartUs,
          segment.durationUs,
          options.signal,
        );
        throwIfAborted(options.signal, 'Render IR audio');
        if (!Number.isSafeInteger(block.sampleRate) || block.sampleRate <= 0) {
          throw new RangeError('PCM source returned an invalid sample rate');
        }
        if (!Number.isSafeInteger(block.channelCount) || block.channelCount < 1 || block.channelCount > 8) {
          throw new RangeError('PCM source returned an invalid channel count');
        }
        if (block.interleaved.length !== block.frameCount * block.channelCount) {
          throw new RangeError('PCM source returned an inconsistent interleaved block');
        }
        if (block.frameCount < 1) continue;
        const linearMapping =
          active.clip.source.timeMapping?.type === 'linear' ? active.clip.source.timeMapping : undefined;
        const preservePitch =
          clipAudio.pitchPolicy === 'preserve' &&
          linearMapping !== undefined &&
          linearMapping.rate.numerator !== linearMapping.rate.denominator;
        const stretched = preservePitch
          ? pitchPreservingTimeStretch({
              input: block.interleaved,
              inputFrames: block.frameCount,
              outputFrames: segment.frames.length,
              channelCount: block.channelCount,
              reverse: linearMapping.reverse,
            })
          : undefined;
        for (const [segmentFrame, mapped] of segment.frames.entries()) {
          const targetFrame = options.startFrame + mapped.outputOffset;
          const sequenceTimeUs = sampleBoundaryUs(targetFrame, options.ir.sampleRate);
          const gainDb =
            evaluateAnimatableNumber(trackAudio.gainDb, sequenceTimeUs, 0, 0) +
            evaluateAnimatableNumber(clipAudio.gainDb, sequenceTimeUs, active.clip.range.startUs, 0);
          const pan = Math.max(
            -1,
            Math.min(
              1,
              evaluateAnimatableNumber(trackAudio.pan, sequenceTimeUs, 0, 0) +
                evaluateAnimatableNumber(clipAudio.pan, sequenceTimeUs, active.clip.range.startUs, 0),
            ),
          );
          const envelope = fadeEnvelope(
            clipAudio,
            sequenceTimeUs - active.clip.range.startUs,
            active.clip.range.durationUs,
          );
          const [leftGain, rightGain] = gains(10 ** (gainDb / 20) * envelope, pan);
          const masterGain = 10 ** (gainDb / 20) * envelope;
          const sourcePosition = ((mapped.sourceTimeUs - segment.sourceStartUs) * block.sampleRate) / 1_000_000;
          const sourceFrame = Math.max(0, Math.min(block.frameCount - 1, Math.floor(sourcePosition)));
          const nextSourceFrame = Math.min(block.frameCount - 1, sourceFrame + 1);
          const fraction = Math.max(0, Math.min(1, sourcePosition - sourceFrame));
          const channelSample = (channel: number): number =>
            stretched === undefined
              ? interpolatedChannel(block, sourceFrame, nextSourceFrame, fraction, channel)
              : (stretched[segmentFrame * block.channelCount + channel] ?? 0);
          const sourceLeft = channelSample(0);
          const sourceRight = block.channelCount === 1 ? sourceLeft : channelSample(1);
          const target = mapped.outputOffset * options.channelCount;
          const channelMap = Array.isArray(clipAudio.channelMap) ? clipAudio.channelMap : undefined;
          if (channelMap !== undefined) {
            if (
              channelMap.length !== options.channelCount ||
              channelMap.some(
                (row) =>
                  !Array.isArray(row) ||
                  row.length !== block.channelCount ||
                  row.some((value) => typeof value !== 'number' || !Number.isFinite(value)),
              )
            ) {
              throw new RangeError(`Audio channelMap for ${active.clip.id} must be outputChannels × sourceChannels`);
            }
            for (let outputChannel = 0; outputChannel < options.channelCount; outputChannel += 1) {
              const row = channelMap[outputChannel] as readonly number[];
              let sample = 0;
              for (let inputChannel = 0; inputChannel < block.channelCount; inputChannel += 1) {
                sample += channelSample(inputChannel) * (row[inputChannel] ?? 0);
              }
              const channelGain = outputChannel === 0 ? leftGain : outputChannel === 1 ? rightGain : masterGain;
              output[target + outputChannel] = (output[target + outputChannel] ?? 0) + sample * channelGain;
            }
          } else if (options.channelCount === 1) {
            output[target] = (output[target] ?? 0) + (sourceLeft * leftGain + sourceRight * rightGain) / Math.SQRT2;
          } else if (options.channelCount === 2) {
            output[target] = (output[target] ?? 0) + sourceLeft * leftGain;
            output[target + 1] = (output[target + 1] ?? 0) + sourceRight * rightGain;
          } else {
            for (let channel = 0; channel < options.channelCount; channel += 1) {
              const sourceSample = channel < block.channelCount ? channelSample(channel) : channel < 2 ? sourceLeft : 0;
              const channelGain = channel === 0 ? leftGain : channel === 1 ? rightGain : masterGain;
              output[target + channel] = (output[target + channel] ?? 0) + sourceSample * channelGain;
            }
          }
        }
      }
    }),
  );
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Math.max(-1, Math.min(1, output[index] ?? 0));
  }
  return output;
}

export interface AvSyncSample {
  readonly videoTimestampUs: number;
  readonly audioFrame: number;
  readonly audioTimestampUs: number;
  readonly driftUs: number;
}

export function measureAvSync(videoTimestampUs: number, audioFrame: number, sampleRate: number): AvSyncSample {
  const audioTimestampUs = sampleBoundaryUs(audioFrame, sampleRate);
  return {
    videoTimestampUs,
    audioFrame,
    audioTimestampUs,
    driftUs: videoTimestampUs - audioTimestampUs,
  };
}
