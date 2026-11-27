import { assertTimeUs } from '@aelionsdk/core';

import type { SampleEntry, SampleIndex, SeekPoint } from './types.js';

function upperBound(samples: readonly SampleEntry[], presentationOrder: readonly number[], targetUs: number): number {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const sampleIndex = presentationOrder[middle];
    const timestamp =
      sampleIndex === undefined
        ? Number.POSITIVE_INFINITY
        : (samples[sampleIndex]?.presentationTimestampUs ?? Number.POSITIVE_INFINITY);
    if (timestamp <= targetUs) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function resolveVideoSeek(index: SampleIndex, trackId: number, targetUs: number): SeekPoint {
  assertTimeUs(targetUs, 'targetUs');
  const samples = index.samples[trackId];
  const presentationOrder = index.presentationOrder[trackId];
  if (samples === undefined || samples.length === 0) {
    throw new RangeError(`Track ${trackId} has no indexed samples`);
  }
  const track = index.tracks.find((candidate) => candidate.id === trackId);
  if (track?.kind !== 'video') {
    throw new TypeError(`Track ${trackId} is not a video track`);
  }
  if (presentationOrder === undefined || presentationOrder.length !== samples.length) {
    throw new RangeError(`Track ${trackId} has an invalid presentation-order index`);
  }

  const insertion = upperBound(samples, presentationOrder, targetUs);
  const presentationPosition = Math.max(0, Math.min(presentationOrder.length - 1, insertion - 1));
  const presentationSample = presentationOrder[presentationPosition];
  if (presentationSample === undefined) {
    throw new RangeError('Seek resolution produced an invalid presentation sample');
  }
  let decodeStartSample = presentationSample;
  while (decodeStartSample > 0 && !samples[decodeStartSample]?.isSync) decodeStartSample -= 1;
  const decodeStart = samples[decodeStartSample];
  const presentation = samples[presentationSample];
  if (decodeStart === undefined || presentation === undefined) {
    throw new RangeError('Seek resolution produced an invalid sample index');
  }
  return {
    trackId,
    targetUs,
    decodeStartSample,
    presentationSample,
    decodeStartUs: decodeStart.presentationTimestampUs,
    presentationUs: presentation.presentationTimestampUs,
    samplesToDecode: presentationSample - decodeStartSample + 1,
  };
}
