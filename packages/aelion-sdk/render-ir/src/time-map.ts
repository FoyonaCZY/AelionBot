import type { IrCurveTimeMapPoint, IrLinearTimeMapping, IrMediaSource, IrTimeMapping } from './types.js';

export type IrTimeMapDirection = 'forward' | 'reverse' | 'hold';

export interface IrTimeMapSegment {
  readonly itemStartUs: number;
  readonly itemEndUs: number;
  readonly sourceStartUs: number;
  readonly sourceEndUs: number;
  readonly direction: IrTimeMapDirection;
  readonly interpolation: 'linear' | 'hold' | 'cubic';
}

export interface IrTimeMapInverse {
  readonly kind: 'point' | 'range';
  readonly itemStartUs: number;
  readonly itemEndUs: number;
}

function legacyLinearMapping(source: IrMediaSource): IrLinearTimeMapping {
  const rateValue: unknown = Reflect.get(source, 'rate');
  const numerator =
    rateValue !== null && typeof rateValue === 'object' && !Array.isArray(rateValue)
      ? (Reflect.get(rateValue, 'numerator') as unknown)
      : undefined;
  const denominator =
    rateValue !== null && typeof rateValue === 'object' && !Array.isArray(rateValue)
      ? (Reflect.get(rateValue, 'denominator') as unknown)
      : undefined;
  const reverse: unknown = Reflect.get(source, 'reverse');
  return {
    type: 'linear',
    rate:
      typeof numerator === 'number' && typeof denominator === 'number'
        ? { numerator, denominator }
        : { numerator: 1, denominator: 1 },
    reverse: typeof reverse === 'boolean' ? reverse : false,
  };
}

/** Returns the canonical mapping, including compatibility for legacy hand-authored IR. */
export function irTimeMapping(source: IrMediaSource): IrTimeMapping {
  return source.timeMapping ?? legacyLinearMapping(source);
}

function scaledLinearTime(localUs: number, mapping: IrLinearTimeMapping): number {
  const value = (BigInt(localUs) * BigInt(mapping.rate.numerator)) / BigInt(mapping.rate.denominator);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError('Mapped source time is not safe');
  return result;
}

function curveSegment(
  points: readonly IrCurveTimeMapPoint[],
  localUs: number,
): readonly [IrCurveTimeMapPoint, IrCurveTimeMapPoint] {
  let low = 0;
  let high = points.length - 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    const point = points[middle];
    if (point !== undefined && point.itemTimeUs <= localUs) low = middle;
    else high = middle;
  }
  const from = points[low];
  const to = points[high];
  if (from === undefined || to === undefined) throw new RangeError('TimeMap has no covering segment');
  return [from, to];
}

function mappedCurveTime(points: readonly IrCurveTimeMapPoint[], localUs: number): number {
  if (points.length < 2) throw new RangeError('Curve TimeMap requires at least two points');
  const [from, to] = curveSegment(points, localUs);
  if (from.interpolation === 'hold') return from.sourceTimeUs;
  const durationUs = to.itemTimeUs - from.itemTimeUs;
  if (durationUs <= 0) throw new RangeError('Curve TimeMap item times must increase');
  let progress = (localUs - from.itemTimeUs) / durationUs;
  if (from.interpolation === 'cubic') progress = progress * progress * (3 - 2 * progress);
  return Math.floor(from.sourceTimeUs + (to.sourceTimeUs - from.sourceTimeUs) * progress);
}

function direction(from: number, to: number): IrTimeMapDirection {
  return to > from ? 'forward' : to < from ? 'reverse' : 'hold';
}

/** Validates and exposes independently monotonic portions of a TimeMap. */
export function analyzeIrTimeMap(source: IrMediaSource, itemDurationUs: number): readonly IrTimeMapSegment[] {
  if (!Number.isSafeInteger(itemDurationUs) || itemDurationUs <= 0) {
    throw new RangeError('itemDurationUs must be a positive safe integer');
  }
  const mapping = irTimeMapping(source);
  if (mapping.type === 'linear') {
    if (
      !Number.isSafeInteger(mapping.rate.numerator) ||
      !Number.isSafeInteger(mapping.rate.denominator) ||
      mapping.rate.numerator <= 0 ||
      mapping.rate.denominator <= 0
    ) {
      throw new RangeError('Linear TimeMap rate must be a positive rational');
    }
    const start = mapping.reverse
      ? source.sourceRange.startUs + source.sourceRange.durationUs - 1
      : source.sourceRange.startUs;
    const delta = Number((BigInt(itemDurationUs) * BigInt(mapping.rate.numerator)) / BigInt(mapping.rate.denominator));
    return [
      {
        itemStartUs: 0,
        itemEndUs: itemDurationUs,
        sourceStartUs: start,
        sourceEndUs: mapping.reverse ? start - delta : start + delta,
        direction: mapping.reverse ? 'reverse' : 'forward',
        interpolation: 'linear',
      },
    ];
  }
  if (mapping.points.length < 2) throw new RangeError('Curve TimeMap requires at least two points');
  const first = mapping.points[0];
  const last = mapping.points.at(-1);
  if (first?.itemTimeUs !== 0 || last?.itemTimeUs !== itemDurationUs) {
    throw new RangeError('Curve TimeMap must cover the complete Item-local interval');
  }
  return mapping.points.slice(0, -1).map((from, index) => {
    const to = mapping.points[index + 1];
    if (to === undefined || to.itemTimeUs <= from.itemTimeUs) {
      throw new RangeError('Curve TimeMap item times must strictly increase');
    }
    const segmentDirection = from.interpolation === 'hold' ? 'hold' : direction(from.sourceTimeUs, to.sourceTimeUs);
    return {
      itemStartUs: from.itemTimeUs,
      itemEndUs: to.itemTimeUs,
      sourceStartUs: from.sourceTimeUs,
      sourceEndUs: segmentDirection === 'hold' ? from.sourceTimeUs : to.sourceTimeUs,
      direction: segmentDirection,
      interpolation: from.interpolation,
    };
  });
}

function inverseSmoothStep(progress: number): number {
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 32; iteration++) {
    const middle = (low + high) / 2;
    const value = middle * middle * (3 - 2 * middle);
    if (value < progress) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/** Inverts all monotonic TimeMap segments. Hold regions return an Item-local range. */
export function invertIrSourceTime(
  source: IrMediaSource,
  itemDurationUs: number,
  sourceTimeUs: number,
): readonly IrTimeMapInverse[] {
  if (!Number.isSafeInteger(sourceTimeUs)) throw new RangeError('sourceTimeUs must be a safe integer');
  const segments = analyzeIrTimeMap(source, itemDurationUs);
  const mapping = irTimeMapping(source);
  if (mapping.type === 'linear') {
    const segment = segments[0];
    if (segment === undefined) return [];
    const sourceOffset = mapping.reverse ? segment.sourceStartUs - sourceTimeUs : sourceTimeUs - segment.sourceStartUs;
    if (sourceOffset < 0) return [];
    const localUs = (sourceOffset * mapping.rate.denominator) / mapping.rate.numerator;
    if (localUs < 0 || localUs >= itemDurationUs) return [];
    return [{ kind: 'point', itemStartUs: localUs, itemEndUs: localUs }];
  }
  return segments.flatMap((segment): readonly IrTimeMapInverse[] => {
    if (segment.direction === 'hold') {
      return sourceTimeUs === segment.sourceStartUs
        ? [
            {
              kind: 'range' as const,
              itemStartUs: segment.itemStartUs,
              itemEndUs: segment.itemEndUs,
            },
          ]
        : [];
    }
    const minimum = Math.min(segment.sourceStartUs, segment.sourceEndUs);
    const maximum = Math.max(segment.sourceStartUs, segment.sourceEndUs);
    if (sourceTimeUs < minimum || sourceTimeUs > maximum) return [];
    const sourceProgress = (sourceTimeUs - segment.sourceStartUs) / (segment.sourceEndUs - segment.sourceStartUs);
    const progress =
      sourceProgress === 0 || sourceProgress === 1
        ? sourceProgress
        : segment.interpolation === 'cubic'
          ? inverseSmoothStep(sourceProgress)
          : sourceProgress;
    const itemTime = segment.itemStartUs + (segment.itemEndUs - segment.itemStartUs) * progress;
    return [{ kind: 'point' as const, itemStartUs: itemTime, itemEndUs: itemTime }];
  });
}

function applyBoundary(source: IrMediaSource, sourceTimeUs: number): number | null {
  const startUs = source.sourceRange.startUs;
  const durationUs = source.sourceRange.durationUs;
  const endUs = startUs + durationUs;
  if (sourceTimeUs >= startUs && sourceTimeUs < endUs) return sourceTimeUs;
  switch (source.boundary) {
    case 'loop': {
      const wrapped = (((sourceTimeUs - startUs) % durationUs) + durationUs) % durationUs;
      return startUs + wrapped;
    }
    case 'hold':
      return Math.max(startUs, Math.min(endUs - 1, sourceTimeUs));
    case 'transparent':
      return null;
    case 'error':
      throw new RangeError('TimeMap resolves outside its sourceRange');
  }
}

/** Maps Item-local time to normalized absolute source presentation time. */
export function mapIrSourceTime(
  source: IrMediaSource,
  itemDurationUs: number,
  localUs: number,
  options: { readonly allowOutsideItem?: boolean } = {},
): number | null {
  if (!Number.isSafeInteger(localUs) || (!options.allowOutsideItem && (localUs < 0 || localUs >= itemDurationUs))) {
    return null;
  }
  const mapping = irTimeMapping(source);
  const mapped =
    mapping.type === 'linear'
      ? mapping.reverse
        ? source.sourceRange.startUs + source.sourceRange.durationUs - 1 - scaledLinearTime(localUs, mapping)
        : source.sourceRange.startUs + scaledLinearTime(localUs, mapping)
      : mappedCurveTime(mapping.points, localUs);
  return applyBoundary(source, mapped);
}
