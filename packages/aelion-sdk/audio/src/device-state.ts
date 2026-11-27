import { AelionError, throwIfAborted, type Disposable } from '@aelionsdk/core';

export type AudioRuntimeState = 'idle' | 'running' | 'interrupted' | 'switching-device' | 'failed' | 'disposed';

export interface AudioOutputBackend {
  readonly state: string;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  setSinkId?(sinkId: string): Promise<void>;
  addEventListener(type: 'statechange', listener: () => void): void;
  removeEventListener(type: 'statechange', listener: () => void): void;
}

export interface AudioRuntimeSnapshot {
  readonly state: AudioRuntimeState;
  readonly outputDeviceId: string;
  readonly generation: number;
  readonly errorCode?: string;
}

function diagnostic(code: string, message: string, recoverable: boolean): AelionError {
  return new AelionError([{ code, severity: 'error', message, recoverable }]);
}

/** Serializes device changes and browser interruption recovery without losing mixer state. */
export class AudioRuntimeStateMachine implements Disposable {
  readonly #backend: AudioOutputBackend;
  #state: AudioRuntimeState = 'idle';
  #deviceId = 'default';
  #generation = 0;
  #errorCode: string | undefined;
  #switchTask: Promise<void> = Promise.resolve();

  public constructor(backend: AudioOutputBackend) {
    this.#backend = backend;
    backend.addEventListener('statechange', this.#handleStateChange);
  }

  public get disposed(): boolean {
    return this.#state === 'disposed';
  }

  public snapshot(): AudioRuntimeSnapshot {
    return {
      state: this.#state,
      outputDeviceId: this.#deviceId,
      generation: this.#generation,
      ...(this.#errorCode === undefined ? {} : { errorCode: this.#errorCode }),
    };
  }

  public async start(signal?: AbortSignal): Promise<void> {
    this.#requireActive();
    throwIfAborted(signal, 'Audio runtime start');
    try {
      await this.#backend.resume();
      throwIfAborted(signal, 'Audio runtime start');
      this.#state = this.#backend.state === 'running' ? 'running' : 'interrupted';
      this.#errorCode = undefined;
    } catch (error) {
      this.#fail('AUDIO_CONTEXT_RESUME_FAILED');
      throw diagnostic(
        'AUDIO_CONTEXT_RESUME_FAILED',
        error instanceof Error ? error.message : 'AudioContext resume failed',
        true,
      );
    }
  }

  public switchOutputDevice(deviceId: string, signal?: AbortSignal): Promise<void> {
    this.#requireActive();
    if (deviceId.length === 0) return Promise.reject(new TypeError('AUDIO_DEVICE_ID_INVALID'));
    const generation = ++this.#generation;
    const task = this.#switchTask.then(async () => {
      this.#requireActive();
      throwIfAborted(signal, 'Audio output device switch');
      if (generation !== this.#generation) return;
      if (this.#backend.setSinkId === undefined) {
        throw diagnostic(
          'AUDIO_OUTPUT_DEVICE_UNSUPPORTED',
          'The active browser does not support AudioContext output device selection',
          true,
        );
      }
      const wasRunning = this.#state === 'running';
      this.#state = 'switching-device';
      try {
        if (wasRunning) await this.#backend.suspend();
        throwIfAborted(signal, 'Audio output device switch');
        await this.#backend.setSinkId(deviceId);
        throwIfAborted(signal, 'Audio output device switch');
        if (wasRunning) await this.#backend.resume();
        if (generation !== this.#generation) return;
        this.#deviceId = deviceId;
        this.#state = this.#backend.state === 'running' ? 'running' : 'interrupted';
        this.#errorCode = undefined;
      } catch (error) {
        if (generation === this.#generation) this.#fail('AUDIO_OUTPUT_DEVICE_SWITCH_FAILED');
        if (error instanceof AelionError) throw error;
        throw diagnostic(
          'AUDIO_OUTPUT_DEVICE_SWITCH_FAILED',
          error instanceof Error ? error.message : 'Audio output device switch failed',
          true,
        );
      }
    });
    this.#switchTask = task.catch(() => undefined);
    return task;
  }

  public async recover(signal?: AbortSignal): Promise<void> {
    this.#requireActive();
    if (this.#state !== 'interrupted' && this.#state !== 'failed') return;
    await this.start(signal);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.#generation++;
    this.#backend.removeEventListener('statechange', this.#handleStateChange);
    this.#state = 'disposed';
    this.#errorCode = undefined;
  }

  readonly #handleStateChange = (): void => {
    if (this.disposed || this.#state === 'switching-device') return;
    if (this.#backend.state === 'running') {
      this.#state = 'running';
      this.#errorCode = undefined;
    } else if (this.#backend.state === 'suspended' || this.#backend.state === 'interrupted') {
      this.#state = 'interrupted';
      this.#errorCode = 'AUDIO_CONTEXT_INTERRUPTED';
    } else if (this.#backend.state === 'closed') {
      this.#fail('AUDIO_CONTEXT_CLOSED');
    }
  };

  #fail(code: string): void {
    this.#state = 'failed';
    this.#errorCode = code;
  }

  #requireActive(): void {
    if (this.disposed) throw new ReferenceError('Audio runtime is disposed');
  }
}
