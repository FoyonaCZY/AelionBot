/// <reference lib="webworker" />

interface WorkletOptions {
  readonly processorOptions?: {
    readonly channelCount: number;
    readonly generation: number;
    readonly reportEveryFrames: number;
  };
}

interface QueuedBlock {
  readonly id: number;
  readonly generation: number;
  readonly frameCount: number;
  readonly channelCount: number;
  readonly samples: Float32Array<ArrayBuffer>;
  offsetFrames: number;
}

declare const currentFrame: number;
declare const currentTime: number;
declare const sampleRate: number;

declare abstract class AudioWorkletProcessor {
  public readonly port: MessagePort;
  public constructor(options?: WorkletOptions);
  public abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processor: new (options?: WorkletOptions) => AudioWorkletProcessor,
): void;

class AelionMessagePcmPlayerProcessor extends AudioWorkletProcessor {
  readonly #channelCount: number;
  readonly #reportEveryFrames: number;
  readonly #queue: QueuedBlock[] = [];
  #generation: number;
  #lastReportFrame = 0;
  #playedFrames = 0;
  #underrunFrames = 0;
  #closed = false;
  #playing = false;

  public constructor(options?: WorkletOptions) {
    super(options);
    const processorOptions = options?.processorOptions;
    if (processorOptions === undefined) {
      throw new TypeError('Aelion message PCM processor requires options');
    }
    this.#channelCount = processorOptions.channelCount;
    this.#generation = processorOptions.generation;
    this.#reportEveryFrames = processorOptions.reportEveryFrames;
    this.port.addEventListener('message', this.#onMessage);
    this.port.start();
    this.port.postMessage({ type: 'ready', sampleRate });
  }

  public process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    void inputs;
    void parameters;
    const output = outputs[0];
    if (output === undefined) return !this.#closed;
    for (const plane of output) plane.fill(0);
    if (!this.#playing) return !this.#closed;
    const requestedFrames = output[0]?.length ?? 0;
    let writtenFrames = 0;
    while (writtenFrames < requestedFrames) {
      const block = this.#queue[0];
      if (block === undefined) break;
      if (block.generation !== this.#generation) {
        this.#queue.shift();
        this.port.postMessage({ type: 'ack', id: block.id, generation: block.generation });
        continue;
      }
      const available = block.frameCount - block.offsetFrames;
      const frames = Math.min(available, requestedFrames - writtenFrames);
      for (let frame = 0; frame < frames; frame += 1) {
        for (let channel = 0; channel < this.#channelCount; channel += 1) {
          const plane = output[channel];
          if (plane !== undefined) {
            plane[writtenFrames + frame] =
              block.samples[(block.offsetFrames + frame) * block.channelCount + channel] ?? 0;
          }
        }
      }
      block.offsetFrames += frames;
      writtenFrames += frames;
      if (block.offsetFrames >= block.frameCount) {
        this.#queue.shift();
        this.port.postMessage({ type: 'ack', id: block.id, generation: block.generation });
      }
    }
    this.#playedFrames += requestedFrames;
    this.#underrunFrames += requestedFrames - writtenFrames;
    if (currentFrame - this.#lastReportFrame >= this.#reportEveryFrames) {
      this.#lastReportFrame = currentFrame;
      this.port.postMessage({
        type: 'clock',
        currentFrame,
        currentTime,
        generation: this.#generation,
        playedFrames: this.#playedFrames,
        underrunFrames: this.#underrunFrames,
        queuedBlocks: this.#queue.length,
      });
    }
    return !this.#closed;
  }

  readonly #onMessage = (event: MessageEvent): void => {
    const value: unknown = event.data;
    if (value === null || typeof value !== 'object') return;
    const type: unknown = Reflect.get(value, 'type');
    if (type === 'block') {
      const block = value as QueuedBlock;
      if (block.generation !== this.#generation) {
        this.port.postMessage({ type: 'ack', id: block.id, generation: block.generation });
        return;
      }
      this.#queue.push({ ...block, offsetFrames: 0 });
      return;
    }
    if (type === 'start') {
      this.#playing = true;
      return;
    }
    if (type === 'seek') {
      for (const block of this.#queue) {
        this.port.postMessage({ type: 'ack', id: block.id, generation: block.generation });
      }
      this.#queue.length = 0;
      const generation: unknown = Reflect.get(value, 'generation');
      if (typeof generation !== 'number' || !Number.isSafeInteger(generation)) return;
      this.#generation = generation;
      this.#playedFrames = 0;
      this.#underrunFrames = 0;
      return;
    }
    if (type === 'close') {
      this.#playing = false;
      this.#closed = true;
      this.#queue.length = 0;
    }
  };
}

registerProcessor('aelion-message-pcm-player', AelionMessagePcmPlayerProcessor);
