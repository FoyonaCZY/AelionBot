const MICROSECONDS_PER_SECOND = 1_000_000n;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_INTEGER_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

export interface Rational {
  readonly numerator: number;
  readonly denominator: number;
}

export type RoundingMode = 'floor' | 'ceil' | 'nearest';

export class TimeError extends RangeError {
  public readonly code:
    'TIME_NOT_SAFE_INTEGER' | 'RATIONAL_INVALID' | 'INDEX_NOT_SAFE_INTEGER' | 'TIME_RESULT_OUT_OF_RANGE';

  public constructor(code: TimeError['code'], message: string) {
    super(message);
    this.name = 'TimeError';
    this.code = code;
  }
}

function assertSafeInteger(value: number, name: string, code: TimeError['code']): void {
  if (!Number.isSafeInteger(value)) {
    throw new TimeError(code, `${name} must be a safe integer; received ${String(value)}`);
  }
}

export function assertTimeUs(value: number, name = 'timeUs'): number {
  assertSafeInteger(value, name, 'TIME_NOT_SAFE_INTEGER');
  return value;
}

export function assertRational(value: Rational, name = 'rational'): Rational {
  assertSafeInteger(value.numerator, `${name}.numerator`, 'RATIONAL_INVALID');
  assertSafeInteger(value.denominator, `${name}.denominator`, 'RATIONAL_INVALID');

  if (value.numerator <= 0 || value.denominator <= 0) {
    throw new TimeError('RATIONAL_INVALID', `${name} numerator and denominator must be positive`);
  }

  return value;
}

export function normalizeRational(value: Rational): Rational {
  assertRational(value);
  const divisor = greatestCommonDivisor(BigInt(value.numerator), BigInt(value.denominator));
  return {
    numerator: Number(BigInt(value.numerator) / divisor),
    denominator: Number(BigInt(value.denominator) / divisor),
  };
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function divide(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator <= 0n) {
    throw new TimeError('RATIONAL_INVALID', 'division denominator must be positive');
  }

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;

  if (mode === 'floor') return numerator >= 0n ? quotient : quotient - 1n;
  if (mode === 'ceil') return numerator >= 0n ? quotient + 1n : quotient;

  const absoluteRemainder = remainder < 0n ? -remainder : remainder;
  const direction = numerator < 0n ? -1n : 1n;
  return absoluteRemainder * 2n >= denominator ? quotient + direction : quotient;
}

function toSafeNumber(value: bigint, context: string): number {
  if (value > MAX_SAFE_INTEGER_BIGINT || value < MIN_SAFE_INTEGER_BIGINT) {
    throw new TimeError('TIME_RESULT_OUT_OF_RANGE', `${context} exceeds safe integer range`);
  }
  return Number(value);
}

function assertIndex(value: number, name: string): void {
  assertSafeInteger(value, name, 'INDEX_NOT_SAFE_INTEGER');
  if (value < 0) {
    throw new TimeError('INDEX_NOT_SAFE_INTEGER', `${name} must be non-negative`);
  }
}

export function frameStartUs(frameIndex: number, frameRate: Rational): number {
  assertIndex(frameIndex, 'frameIndex');
  assertRational(frameRate, 'frameRate');
  const numerator = BigInt(frameIndex) * MICROSECONDS_PER_SECOND * BigInt(frameRate.denominator);
  return toSafeNumber(divide(numerator, BigInt(frameRate.numerator), 'floor'), 'frameStartUs');
}

export function frameDurationUs(frameIndex: number, frameRate: Rational): number {
  assertIndex(frameIndex, 'frameIndex');
  const current = frameStartUs(frameIndex, frameRate);
  const next = frameStartUs(frameIndex + 1, frameRate);
  return next - current;
}

export function frameIndexAtTime(timeUs: number, frameRate: Rational, mode: RoundingMode = 'floor'): number {
  assertTimeUs(timeUs);
  assertRational(frameRate, 'frameRate');
  const denominator = MICROSECONDS_PER_SECOND * BigInt(frameRate.denominator);
  const rateNumerator = BigInt(frameRate.numerator);

  // frameStartUs() intentionally floors rational frame boundaries to integer
  // microseconds. Its inverse must therefore reason about the quantized
  // boundary, not merely divide timeUs by the rational frame duration.
  //
  // max n where floor(n * denominator / rateNumerator) <= timeUs
  //   = ceil((timeUs + 1) * rateNumerator / denominator) - 1
  const containing = divide((BigInt(timeUs) + 1n) * rateNumerator, denominator, 'ceil') - 1n;
  if (mode === 'floor') {
    return toSafeNumber(containing, 'frameIndexAtTime');
  }

  const atOrAfter = divide(BigInt(timeUs) * rateNumerator, denominator, 'ceil');
  if (mode === 'ceil') {
    return toSafeNumber(atOrAfter, 'frameIndexAtTime');
  }

  const containingStart = divide(containing * denominator, rateNumerator, 'floor');
  const atOrAfterStart = divide(atOrAfter * denominator, rateNumerator, 'floor');
  const distanceBefore = BigInt(timeUs) - containingStart;
  const distanceAfter = atOrAfterStart - BigInt(timeUs);
  return toSafeNumber(distanceAfter <= distanceBefore ? atOrAfter : containing, 'frameIndexAtTime');
}

export function sampleIndexAtTime(timeUs: number, sampleRate: number, mode: RoundingMode = 'floor'): number {
  assertTimeUs(timeUs);
  assertSafeInteger(sampleRate, 'sampleRate', 'RATIONAL_INVALID');
  if (sampleRate <= 0) {
    throw new TimeError('RATIONAL_INVALID', 'sampleRate must be positive');
  }
  const numerator = BigInt(timeUs) * BigInt(sampleRate);
  return toSafeNumber(divide(numerator, MICROSECONDS_PER_SECOND, mode), 'sampleIndexAtTime');
}

export function sampleBoundaryUs(sampleIndex: number, sampleRate: number): number {
  assertIndex(sampleIndex, 'sampleIndex');
  assertSafeInteger(sampleRate, 'sampleRate', 'RATIONAL_INVALID');
  if (sampleRate <= 0) {
    throw new TimeError('RATIONAL_INVALID', 'sampleRate must be positive');
  }
  return toSafeNumber(
    divide(BigInt(sampleIndex) * MICROSECONDS_PER_SECOND, BigInt(sampleRate), 'floor'),
    'sampleBoundaryUs',
  );
}

export function sampleCountForRange(startUs: number, durationUs: number, sampleRate: number): number {
  assertTimeUs(startUs, 'startUs');
  assertTimeUs(durationUs, 'durationUs');
  if (durationUs < 0) {
    throw new TimeError('TIME_NOT_SAFE_INTEGER', 'durationUs must be non-negative');
  }
  const endUs = startUs + durationUs;
  assertTimeUs(endUs, 'endUs');
  return sampleIndexAtTime(endUs, sampleRate) - sampleIndexAtTime(startUs, sampleRate);
}
