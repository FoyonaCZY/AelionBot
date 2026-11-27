const READ_FRAME = 0;
const WRITE_FRAME = 1;
const PLAYED_FRAME = 2;
const UNDERRUN_FRAME = 3;
const STATE = 4;
const HEADER_LENGTH = 8;
const HEADER_BYTES = HEADER_LENGTH * Int32Array.BYTES_PER_ELEMENT;

export type PcmRingState = 'open' | 'ended' | 'closed';

export interface PcmRingDescriptor {
  readonly buffer: SharedArrayBuffer;
  readonly capacityFrames: number;
  readonly channelCount: number;
  readonly sampleRate: number;
}

export interface PcmRingSnapshot {
  readonly capacityFrames: number;
  readonly availableReadFrames: number;
  readonly availableWriteFrames: number;
  readonly playedFrames: number;
  readonly underrunFrames: number;
  readonly state: PcmRingState;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function stateName(value: number): PcmRingState {
  if (value === 1) return 'ended';
  if (value === 2) return 'closed';
  return 'open';
}

export class SharedPcmRingBuffer {
  readonly #header: Int32Array;
  readonly #samples: Float32Array;

  public readonly capacityFrames: number;
  public readonly channelCount: number;
  public readonly sampleRate: number;
  public readonly buffer: SharedArrayBuffer;

  public static allocate(capacityFrames: number, channelCount: number, sampleRate: number): SharedPcmRingBuffer {
    assertPositiveInteger(capacityFrames, 'capacityFrames');
    assertPositiveInteger(channelCount, 'channelCount');
    assertPositiveInteger(sampleRate, 'sampleRate');
    const sampleCount = capacityFrames * channelCount;
    if (!Number.isSafeInteger(sampleCount)) throw new RangeError('PCM ring is too large');
    const buffer = new SharedArrayBuffer(HEADER_BYTES + sampleCount * Float32Array.BYTES_PER_ELEMENT);
    return new SharedPcmRingBuffer({ buffer, capacityFrames, channelCount, sampleRate });
  }

  public constructor(descriptor: PcmRingDescriptor) {
    assertPositiveInteger(descriptor.capacityFrames, 'capacityFrames');
    assertPositiveInteger(descriptor.channelCount, 'channelCount');
    assertPositiveInteger(descriptor.sampleRate, 'sampleRate');
    const expectedBytes =
      HEADER_BYTES + descriptor.capacityFrames * descriptor.channelCount * Float32Array.BYTES_PER_ELEMENT;
    if (descriptor.buffer.byteLength !== expectedBytes) {
      throw new RangeError(`PCM ring byteLength must be ${expectedBytes}; received ${descriptor.buffer.byteLength}`);
    }
    this.buffer = descriptor.buffer;
    this.capacityFrames = descriptor.capacityFrames;
    this.channelCount = descriptor.channelCount;
    this.sampleRate = descriptor.sampleRate;
    this.#header = new Int32Array(this.buffer, 0, HEADER_LENGTH);
    this.#samples = new Float32Array(this.buffer, HEADER_BYTES);
  }

  public descriptor(): PcmRingDescriptor {
    return {
      buffer: this.buffer,
      capacityFrames: this.capacityFrames,
      channelCount: this.channelCount,
      sampleRate: this.sampleRate,
    };
  }

  public availableReadFrames(): number {
    // A closed transport has no readable ownership even if an AudioWorklet
    // render quantum raced the close and still holds stale cursor values.
    if (stateName(Atomics.load(this.#header, STATE)) === 'closed') return 0;
    return Atomics.load(this.#header, WRITE_FRAME) - Atomics.load(this.#header, READ_FRAME);
  }

  public availableWriteFrames(): number {
    return this.capacityFrames - this.availableReadFrames();
  }

  public writeInterleaved(input: Float32Array): number {
    if (input.length % this.channelCount !== 0) {
      throw new RangeError('Interleaved PCM length must be divisible by channelCount');
    }
    if (stateName(Atomics.load(this.#header, STATE)) !== 'open') return 0;
    const requestedFrames = input.length / this.channelCount;
    const frames = Math.min(requestedFrames, this.availableWriteFrames());
    const writeFrame = Atomics.load(this.#header, WRITE_FRAME);
    for (let frame = 0; frame < frames; frame += 1) {
      const ringFrame = (writeFrame + frame) % this.capacityFrames;
      for (let channel = 0; channel < this.channelCount; channel += 1) {
        const source = frame * this.channelCount + channel;
        const target = ringFrame * this.channelCount + channel;
        this.#samples[target] = input[source] ?? 0;
      }
    }
    Atomics.store(this.#header, WRITE_FRAME, writeFrame + frames);
    Atomics.notify(this.#header, WRITE_FRAME);
    return frames;
  }

  public readPlanar(outputs: readonly Float32Array[]): number {
    if (outputs.length !== this.channelCount) {
      throw new RangeError('Output plane count must equal channelCount');
    }
    const requestedFrames = outputs[0]?.length ?? 0;
    if (outputs.some((output) => output.length !== requestedFrames)) {
      throw new RangeError('All output planes must have the same frame count');
    }

    const readFrame = Atomics.load(this.#header, READ_FRAME);
    const frames = Math.min(requestedFrames, this.availableReadFrames());
    for (let frame = 0; frame < frames; frame += 1) {
      const ringFrame = (readFrame + frame) % this.capacityFrames;
      for (let channel = 0; channel < this.channelCount; channel += 1) {
        const source = ringFrame * this.channelCount + channel;
        const plane = outputs[channel];
        if (plane !== undefined) plane[frame] = this.#samples[source] ?? 0;
      }
    }
    for (const output of outputs) output.fill(0, frames);

    // close() may publish the terminal state while this AudioWorklet quantum is
    // copying samples. Never overwrite its drained cursor or mutate terminal
    // counters after observing that state.
    if (stateName(Atomics.load(this.#header, STATE)) !== 'closed') {
      // A seek flush or close may advance READ_FRAME while this Worklet quantum
      // is copying samples. Commit only if the cursor is still ours; otherwise
      // silence the stale quantum and leave the terminal/new-generation cursor
      // untouched.
      const committed = Atomics.compareExchange(this.#header, READ_FRAME, readFrame, readFrame + frames) === readFrame;
      if (!committed) {
        for (const output of outputs) output.fill(0);
        return 0;
      }
      Atomics.add(this.#header, PLAYED_FRAME, requestedFrames);
      if (frames < requestedFrames) {
        Atomics.add(this.#header, UNDERRUN_FRAME, requestedFrames - frames);
      }
    }
    Atomics.notify(this.#header, READ_FRAME);
    return frames;
  }

  public end(): void {
    Atomics.compareExchange(this.#header, STATE, 0, 1);
  }

  public close(): void {
    Atomics.store(this.#header, STATE, 2);
    // Closing is terminal: queued PCM must not remain retained or appear in a
    // post-disposal resource snapshot. Publish the terminal state first so a
    // racing reader observes zero buffered frames throughout teardown.
    Atomics.store(this.#header, READ_FRAME, Atomics.load(this.#header, WRITE_FRAME));
    Atomics.notify(this.#header, READ_FRAME);
    Atomics.notify(this.#header, WRITE_FRAME);
  }

  /**
   * Drops queued PCM and starts a new transport generation without reallocating
   * the bounded SharedArrayBuffer. The AudioWorklet may race one render quantum;
   * generation-aware scheduling treats that quantum as belonging to the old seek.
   */
  public flush(): void {
    if (stateName(Atomics.load(this.#header, STATE)) !== 'open') {
      throw new Error('Only an open PCM ring can be flushed');
    }
    const writeFrame = Atomics.load(this.#header, WRITE_FRAME);
    Atomics.store(this.#header, READ_FRAME, writeFrame);
    Atomics.store(this.#header, PLAYED_FRAME, 0);
    Atomics.store(this.#header, UNDERRUN_FRAME, 0);
    Atomics.notify(this.#header, READ_FRAME);
  }

  public snapshot(): PcmRingSnapshot {
    const availableReadFrames = this.availableReadFrames();
    return {
      capacityFrames: this.capacityFrames,
      availableReadFrames,
      availableWriteFrames: this.capacityFrames - availableReadFrames,
      playedFrames: Atomics.load(this.#header, PLAYED_FRAME),
      underrunFrames: Atomics.load(this.#header, UNDERRUN_FRAME),
      state: stateName(Atomics.load(this.#header, STATE)),
    };
  }
}
