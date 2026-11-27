import { concat, positiveInteger } from './pcm-utils.js';

export interface PitchPreservingTimeStretchOptions {
  readonly input: Float32Array;
  readonly inputFrames: number;
  readonly outputFrames: number;
  readonly channelCount: number;
  readonly reverse?: boolean;
  /** Analysis grain size. The implementation clamps it to the available input. */
  readonly grainFrames?: number;
}

export interface StreamingPitchPreservingTimeStretchOptions {
  readonly inputFrames: number;
  readonly outputFrames: number;
  readonly channelCount: number;
  readonly grainFrames?: number;
}

/**
 * Stateful deterministic synchronous overlap-add time stretch.
 *
 * Input can arrive in arbitrary chunks. Grains and correlation searches stay
 * anchored to the complete stream, and only samples that can no longer be
 * affected by a later grain are emitted. This makes adjacent offline mixer
 * blocks continuous without retaining the whole source or output.
 */
export class StreamingPitchPreservingTimeStretch {
  readonly #inputFrames: number;
  readonly #outputFrames: number;
  readonly #channelCount: number;
  readonly #grainFrames: number;
  readonly #synthesisHop: number;
  readonly #searchRadius: number;
  readonly #maximumInputStart: number;
  readonly #accumulator: Float32Array;
  readonly #normalization: Float32Array;
  #input = new Float32Array();
  #inputStartFrame = 0;
  #receivedFrames = 0;
  #nextOutputStart = 0;
  #previousGrain: Float32Array | undefined;
  #sealed = false;

  public constructor(options: StreamingPitchPreservingTimeStretchOptions) {
    positiveInteger(options.inputFrames, 'inputFrames');
    positiveInteger(options.outputFrames, 'outputFrames');
    positiveInteger(options.channelCount, 'channelCount');
    if (options.channelCount > 8) throw new RangeError('channelCount must not exceed 8');
    const requestedGrain = options.grainFrames ?? 1_024;
    positiveInteger(requestedGrain, 'grainFrames');
    this.#inputFrames = options.inputFrames;
    this.#outputFrames = options.outputFrames;
    this.#channelCount = options.channelCount;
    this.#grainFrames = Math.min(options.inputFrames, requestedGrain);
    this.#synthesisHop = Math.max(1, Math.floor(this.#grainFrames / 4));
    this.#searchRadius = Math.min(256, this.#synthesisHop);
    this.#maximumInputStart = Math.max(0, options.inputFrames - this.#grainFrames);
    this.#accumulator = new Float32Array(this.#grainFrames * options.channelCount);
    this.#normalization = new Float32Array(this.#grainFrames);
  }

  public push(interleaved: Float32Array, final = false): Float32Array {
    if (this.#sealed) throw new ReferenceError('Time stretch is sealed');
    if (interleaved.length % this.#channelCount !== 0) {
      throw new RangeError('PCM length must be divisible by channelCount');
    }
    const addedFrames = interleaved.length / this.#channelCount;
    if (this.#receivedFrames + addedFrames > this.#inputFrames) {
      throw new RangeError('Time stretch received more frames than declared');
    }
    this.#input = concat(this.#input, interleaved);
    this.#receivedFrames += addedFrames;
    if (final && this.#receivedFrames !== this.#inputFrames) {
      throw new RangeError('Final time-stretch chunk does not complete inputFrames');
    }

    const emitted: number[] = [];
    while (this.#nextOutputStart < this.#outputFrames) {
      const expected = this.#expectedInputStart(this.#nextOutputStart);
      const lastCandidate = Math.min(this.#maximumInputStart, expected + this.#searchRadius);
      if (!final && lastCandidate + this.#grainFrames > this.#receivedFrames) break;
      const firstCandidate = Math.max(0, expected - this.#searchRadius);
      let selected = expected;
      if (this.#previousGrain !== undefined) {
        let bestScore = Number.NEGATIVE_INFINITY;
        for (let candidate = firstCandidate; candidate <= lastCandidate; candidate += 1) {
          let cross = 0;
          let previousEnergy = 0;
          let candidateEnergy = 0;
          const overlapFrames = this.#grainFrames - this.#synthesisHop;
          for (let frame = 0; frame < overlapFrames; frame += 1) {
            const previous = this.#previousGrain[(frame + this.#synthesisHop) * this.#channelCount] ?? 0;
            const next = this.#source(candidate + frame, 0);
            cross += previous * next;
            previousEnergy += previous * previous;
            candidateEnergy += next * next;
          }
          const score = cross / Math.sqrt(Math.max(Number.EPSILON, previousEnergy * candidateEnergy));
          if (score > bestScore) {
            bestScore = score;
            selected = candidate;
          }
        }
      }

      const grain = new Float32Array(this.#grainFrames * this.#channelCount);
      for (let frame = 0; frame < this.#grainFrames; frame += 1) {
        const phase = (frame + 0.5) / this.#grainFrames;
        const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
        this.#normalization[frame] = (this.#normalization[frame] ?? 0) + window;
        for (let channel = 0; channel < this.#channelCount; channel += 1) {
          const sample = this.#source(selected + frame, channel);
          grain[frame * this.#channelCount + channel] = sample;
          const index = frame * this.#channelCount + channel;
          this.#accumulator[index] = (this.#accumulator[index] ?? 0) + sample * window;
        }
      }
      this.#previousGrain = grain;

      const emitFrames = Math.min(this.#synthesisHop, this.#outputFrames - this.#nextOutputStart);
      for (let frame = 0; frame < emitFrames; frame += 1) {
        const scale = this.#normalization[frame] ?? 0;
        for (let channel = 0; channel < this.#channelCount; channel += 1) {
          const value = this.#accumulator[frame * this.#channelCount + channel] ?? 0;
          emitted.push(scale > 1e-6 ? value / scale : this.#source(selected + frame, channel));
        }
      }
      this.#shiftAccumulator(this.#synthesisHop);
      this.#nextOutputStart += this.#synthesisHop;

      const nextMinimum = Math.max(0, this.#expectedInputStart(this.#nextOutputStart) - this.#searchRadius);
      const discardFrames = Math.max(
        0,
        Math.min(this.#input.length / this.#channelCount, nextMinimum - this.#inputStartFrame),
      );
      if (discardFrames > 0) {
        this.#input = this.#input.slice(discardFrames * this.#channelCount);
        this.#inputStartFrame += discardFrames;
      }
    }
    if (final) {
      this.#sealed = true;
      this.#input = new Float32Array();
    }
    return Float32Array.from(emitted);
  }

  #expectedInputStart(outputStart: number): number {
    return Math.max(
      0,
      Math.min(this.#maximumInputStart, Math.round((outputStart * this.#inputFrames) / this.#outputFrames)),
    );
  }

  #source(frame: number, channel: number): number {
    const bounded = Math.max(0, Math.min(this.#receivedFrames - 1, frame));
    const local = bounded - this.#inputStartFrame;
    if (local < 0) throw new Error('Time stretch discarded a required source grain');
    return this.#input[local * this.#channelCount + channel] ?? 0;
  }

  #shiftAccumulator(frames: number): void {
    const retainedFrames = Math.max(0, this.#grainFrames - frames);
    this.#accumulator.copyWithin(0, frames * this.#channelCount);
    this.#accumulator.fill(0, retainedFrames * this.#channelCount);
    this.#normalization.copyWithin(0, frames);
    this.#normalization.fill(0, retainedFrames);
  }
}

export function pitchPreservingTimeStretch(options: PitchPreservingTimeStretchOptions): Float32Array {
  positiveInteger(options.inputFrames, 'inputFrames');
  positiveInteger(options.outputFrames, 'outputFrames');
  positiveInteger(options.channelCount, 'channelCount');
  if (options.input.length !== options.inputFrames * options.channelCount) {
    throw new RangeError('input length does not match inputFrames × channelCount');
  }
  let input = options.input;
  if (options.reverse === true) {
    input = new Float32Array(options.input.length);
    for (let frame = 0; frame < options.inputFrames; frame += 1) {
      for (let channel = 0; channel < options.channelCount; channel += 1) {
        input[frame * options.channelCount + channel] =
          options.input[(options.inputFrames - 1 - frame) * options.channelCount + channel] ?? 0;
      }
    }
  }
  const processor = new StreamingPitchPreservingTimeStretch({
    inputFrames: options.inputFrames,
    outputFrames: options.outputFrames,
    channelCount: options.channelCount,
    ...(options.grainFrames === undefined ? {} : { grainFrames: options.grainFrames }),
  });
  return processor.push(input, true);
}
