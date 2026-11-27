/** A single constant-rate segment of a rate envelope. */
export interface RateEnvelopeSegment {
  /** Playback rate of this segment, e.g. 0.5 for half speed. */
  readonly rate: number;
  /** Duration of the segment on the timeline, in microseconds. */
  readonly durationUs: number;
}

/** A point in a curve time mapping. */
export interface CurvePoint {
  readonly itemTimeUs: number;
  readonly sourceTimeUs: number;
  readonly interpolation: 'linear' | 'hold' | 'cubic';
}

/** Segmented rate envelope input. */
export interface RateEnvelopeOptions {
  readonly segments: readonly RateEnvelopeSegment[];
  /** Absolute source time at the start of the envelope. */
  readonly sourceStartUs?: number;
}

/**
 * Compile a rate envelope (segmented playback speed) into equivalent curve
 * time-mapping points. The envelope integrates rate over timeline time: each
 * segment advances the source time by `rate * durationUs`. Item time is
 * strictly increasing. Source time may advance, hold, or move backward,
 * allowing deterministic forward, freeze-frame, and reverse spans.
 *
 * Returns at least two points; a single segment produces the two endpoints.
 */
export function buildRateEnvelope(options: RateEnvelopeOptions): readonly CurvePoint[] {
  if (options.segments.length === 0) {
    throw new RangeError('rate envelope requires at least one segment');
  }
  const sourceStartUs = options.sourceStartUs ?? 0;
  if (!Number.isSafeInteger(sourceStartUs) || sourceStartUs < 0) {
    throw new RangeError('sourceStartUs must be a non-negative safe integer');
  }
  const points: CurvePoint[] = [];
  let itemTimeUs = 0;
  let sourceTimeUs = sourceStartUs;
  for (const [index, segment] of options.segments.entries()) {
    if (!Number.isFinite(segment.rate)) {
      throw new RangeError(`segment ${index} rate must be a finite number`);
    }
    if (!Number.isSafeInteger(segment.durationUs) || segment.durationUs < 0) {
      throw new RangeError(`segment ${index} durationUs must be a non-negative safe integer`);
    }
    if (segment.durationUs === 0) continue;
    if (points.length === 0) {
      points.push({
        itemTimeUs: 0,
        sourceTimeUs,
        interpolation: segment.rate === 0 ? 'hold' : 'linear',
      });
    }
    const advancedUs = segment.rate * segment.durationUs;
    const nextSourceUs = sourceTimeUs + advancedUs;
    const roundedSourceUs = Math.floor(nextSourceUs);
    if (!Number.isSafeInteger(roundedSourceUs) || roundedSourceUs < 0) {
      throw new RangeError(`segment ${index} moves source time outside the supported range`);
    }
    if (!Number.isSafeInteger(itemTimeUs + segment.durationUs)) {
      throw new RangeError(`segment ${index} moves item time past the safe integer range`);
    }
    itemTimeUs += segment.durationUs;
    sourceTimeUs = nextSourceUs;
    points.push({
      itemTimeUs,
      sourceTimeUs: roundedSourceUs,
      interpolation: 'linear',
    });
    const next = options.segments.slice(index + 1).find((value) => value.durationUs > 0);
    if (next !== undefined) {
      const pointIndex = points.length - 1;
      const point = points[pointIndex];
      if (point === undefined) throw new Error('Rate envelope point construction failed');
      points[pointIndex] = {
        ...point,
        interpolation: next.rate === 0 ? 'hold' : 'linear',
      };
    }
  }
  if (points.length < 2) {
    throw new RangeError('rate envelope requires a positive total duration');
  }
  return points;
}
