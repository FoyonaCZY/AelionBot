/// <reference lib="webworker" />

import { SharedPcmRingBuffer, type PcmRingDescriptor } from './pcm-ring.js';

interface ProcessorOptions {
  readonly ring: PcmRingDescriptor;
  readonly reportEveryFrames?: number;
}

interface WorkletOptions {
  readonly processorOptions?: ProcessorOptions;
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

class AelionPcmPlayerProcessor extends AudioWorkletProcessor {
  readonly #ring: SharedPcmRingBuffer;
  readonly #reportEveryFrames: number;
  #lastReportFrame = 0;

  public constructor(options?: WorkletOptions) {
    super(options);
    const processorOptions = options?.processorOptions;
    if (processorOptions === undefined) {
      throw new TypeError('Aelion PCM processor requires a ring descriptor');
    }
    this.#ring = new SharedPcmRingBuffer(processorOptions.ring);
    this.#reportEveryFrames = processorOptions.reportEveryFrames ?? sampleRate;
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
    if (output === undefined) return true;
    this.#ring.readPlanar(output);
    if (currentFrame - this.#lastReportFrame >= this.#reportEveryFrames) {
      this.#lastReportFrame = currentFrame;
      this.port.postMessage({
        type: 'clock',
        currentFrame,
        currentTime,
        snapshot: this.#ring.snapshot(),
      });
    }
    return this.#ring.snapshot().state !== 'closed';
  }
}

registerProcessor('aelion-pcm-player', AelionPcmPlayerProcessor);
