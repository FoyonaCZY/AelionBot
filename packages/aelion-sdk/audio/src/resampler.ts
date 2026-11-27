import { concat, positiveInteger } from './pcm-utils.js';

export interface StreamingPcmResamplerOptions {
  readonly inputSampleRate: number;
  readonly outputSampleRate: number;
  readonly channelCount: number;
}

/**
 * Deterministic, chunk-boundary-independent linear PCM resampler.
 *
 * The phase is represented with integer sample counts instead of an accumulated
 * float, so a long render produces the same samples regardless of how providers
 * split their PCM blocks. `push(..., true)` flushes the exact finite-duration
 * tail and seals the instance.
 */
export class StreamingPcmResampler {
  readonly #inputSampleRate: number;
  readonly #outputSampleRate: number;
  readonly #channelCount: number;
  #buffer = new Float32Array();
  #bufferStartFrame = 0;
  #inputFrames = 0;
  #outputFrames = 0;
  #sealed = false;

  public constructor(options: StreamingPcmResamplerOptions) {
    positiveInteger(options.inputSampleRate, 'inputSampleRate');
    positiveInteger(options.outputSampleRate, 'outputSampleRate');
    positiveInteger(options.channelCount, 'channelCount');
    if (options.channelCount > 8) throw new RangeError('channelCount must not exceed 8');
    this.#inputSampleRate = options.inputSampleRate;
    this.#outputSampleRate = options.outputSampleRate;
    this.#channelCount = options.channelCount;
  }

  public get inputFrames(): number {
    return this.#inputFrames;
  }

  public get outputFrames(): number {
    return this.#outputFrames;
  }

  public push(interleaved: Float32Array, final = false): Float32Array {
    if (this.#sealed) throw new ReferenceError('PCM resampler is sealed');
    if (interleaved.length % this.#channelCount !== 0) {
      throw new RangeError('PCM length must be divisible by channelCount');
    }
    this.#buffer = concat(this.#buffer, interleaved);
    this.#inputFrames += interleaved.length / this.#channelCount;

    const maximumOutputFrames = final
      ? Number((BigInt(this.#inputFrames) * BigInt(this.#outputSampleRate)) / BigInt(this.#inputSampleRate))
      : Number.MAX_SAFE_INTEGER;
    const samples: number[] = [];
    while (this.#outputFrames < maximumOutputFrames) {
      const positionNumerator = BigInt(this.#outputFrames) * BigInt(this.#inputSampleRate);
      const sourceFrame = Number(positionNumerator / BigInt(this.#outputSampleRate));
      const fractionNumerator = Number(positionNumerator % BigInt(this.#outputSampleRate));
      const needsNext = fractionNumerator !== 0;
      if (sourceFrame >= this.#inputFrames || (!final && needsNext && sourceFrame + 1 >= this.#inputFrames)) {
        break;
      }
      const localFrame = sourceFrame - this.#bufferStartFrame;
      if (localFrame < 0) throw new Error('PCM resampler discarded a required source frame');
      const nextLocalFrame = Math.min(this.#buffer.length / this.#channelCount - 1, localFrame + 1);
      const fraction = fractionNumerator / this.#outputSampleRate;
      for (let channel = 0; channel < this.#channelCount; channel += 1) {
        const first = this.#buffer[localFrame * this.#channelCount + channel] ?? 0;
        const next = this.#buffer[nextLocalFrame * this.#channelCount + channel] ?? first;
        samples.push(first + (next - first) * fraction);
      }
      this.#outputFrames += 1;
    }

    const nextPositionNumerator = BigInt(this.#outputFrames) * BigInt(this.#inputSampleRate);
    const firstRequiredFrame = Number(nextPositionNumerator / BigInt(this.#outputSampleRate));
    const discardFrames = Math.max(
      0,
      Math.min(this.#buffer.length / this.#channelCount, firstRequiredFrame - this.#bufferStartFrame),
    );
    if (discardFrames > 0) {
      this.#buffer = this.#buffer.slice(discardFrames * this.#channelCount);
      this.#bufferStartFrame += discardFrames;
    }
    if (final) {
      this.#sealed = true;
      this.#buffer = new Float32Array();
    }
    return Float32Array.from(samples);
  }
}

export function resampleInterleavedPcm(input: Float32Array, options: StreamingPcmResamplerOptions): Float32Array {
  return new StreamingPcmResampler(options).push(input, true);
}
