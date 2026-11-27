export interface TransferablePcmQueueSnapshot {
  readonly capacityFrames: number;
  readonly queuedFrames: number;
  readonly availableWriteFrames: number;
  readonly submittedBlocks: number;
  readonly acknowledgedBlocks: number;
  readonly peakQueuedFrames: number;
  readonly closed: boolean;
}

export interface TransferablePcmBlock {
  readonly id: number;
  readonly generation: number;
  readonly frameCount: number;
  readonly channelCount: number;
  readonly samples: Float32Array<ArrayBuffer>;
}

/** Main-thread ownership and backpressure for the non-SAB AudioWorklet path. */
export class TransferablePcmQueue {
  readonly #pending = new Map<number, number>();
  #nextId = 1;
  #queuedFrames = 0;
  #submittedBlocks = 0;
  #acknowledgedBlocks = 0;
  #peakQueuedFrames = 0;
  #closed = false;

  public constructor(
    public readonly capacityFrames: number,
    public readonly channelCount: number,
  ) {
    if (!Number.isSafeInteger(capacityFrames) || capacityFrames <= 0) {
      throw new RangeError('Transferable PCM capacityFrames must be a positive safe integer');
    }
    if (!Number.isSafeInteger(channelCount) || channelCount <= 0) {
      throw new RangeError('Transferable PCM channelCount must be a positive safe integer');
    }
  }

  public enqueue(input: Float32Array, generation: number): TransferablePcmBlock | undefined {
    if (this.#closed) return undefined;
    if (input.length % this.channelCount !== 0) {
      throw new RangeError('Interleaved PCM length must be divisible by channelCount');
    }
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new RangeError('PCM generation must be a non-negative safe integer');
    }
    const frameCount = input.length / this.channelCount;
    if (frameCount <= 0 || frameCount > this.availableWriteFrames()) return undefined;
    const id = this.#nextId;
    this.#nextId += 1;
    const samples = input.slice();
    this.#pending.set(id, frameCount);
    this.#queuedFrames += frameCount;
    this.#submittedBlocks += 1;
    this.#peakQueuedFrames = Math.max(this.#peakQueuedFrames, this.#queuedFrames);
    return { id, generation, frameCount, channelCount: this.channelCount, samples };
  }

  public acknowledge(id: number): void {
    const frames = this.#pending.get(id);
    if (frames === undefined) return;
    this.#pending.delete(id);
    this.#queuedFrames -= frames;
    this.#acknowledgedBlocks += 1;
  }

  public flush(): void {
    this.#pending.clear();
    this.#queuedFrames = 0;
  }

  public close(): void {
    this.#closed = true;
    this.flush();
  }

  public availableWriteFrames(): number {
    return this.capacityFrames - this.#queuedFrames;
  }

  public snapshot(): TransferablePcmQueueSnapshot {
    return {
      capacityFrames: this.capacityFrames,
      queuedFrames: this.#queuedFrames,
      availableWriteFrames: this.availableWriteFrames(),
      submittedBlocks: this.#submittedBlocks,
      acknowledgedBlocks: this.#acknowledgedBlocks,
      peakQueuedFrames: this.#peakQueuedFrames,
      closed: this.#closed,
    };
  }
}
