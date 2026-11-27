import type { Rational } from '@aelionsdk/core';

import type { OfflineAudioRequest, OfflineFrameRequest, WebMExportResult } from './webm-export.js';

export interface ExportWorkerStartRequest {
  readonly type: 'start';
  readonly profile: 'webm' | 'mp4' | 'mp4-av1' | 'mp4-hevc';
  readonly config: {
    readonly durationUs: number;
    readonly width: number;
    readonly height: number;
    readonly frameRate: Rational;
    readonly sampleRate: number;
    readonly channelCount: number;
    readonly videoBitrate: number;
    readonly audioBitrate: number;
    readonly videoCodecString?: string;
    readonly audioCodecString?: string;
  };
  readonly sink: WritableStream<{
    readonly type: 'write';
    readonly data: Uint8Array<ArrayBuffer>;
    readonly position: number;
  }>;
}

export interface ExportWorkerCancelRequest {
  readonly type: 'cancel';
  readonly reason: string;
}

export interface ExportWorkerFrameResponse {
  readonly type: 'frame-response';
  readonly id: number;
  readonly frame?: VideoFrame;
  readonly error?: string;
}

export interface ExportWorkerAudioResponse {
  readonly type: 'audio-response';
  readonly id: number;
  readonly pcm?: Float32Array<ArrayBuffer>;
  readonly error?: string;
}

export type ExportWorkerRequest =
  ExportWorkerStartRequest | ExportWorkerCancelRequest | ExportWorkerFrameResponse | ExportWorkerAudioResponse;

export interface ExportWorkerFrameRequest {
  readonly type: 'render-frame';
  readonly id: number;
  readonly request: OfflineFrameRequest;
}

export interface ExportWorkerAudioRequest {
  readonly type: 'render-audio';
  readonly id: number;
  readonly request: OfflineAudioRequest;
}

export interface ExportWorkerProgress {
  readonly type: 'progress';
  readonly value: number;
}

export interface ExportWorkerCompleted {
  readonly type: 'completed';
  readonly result: WebMExportResult;
}

export interface ExportWorkerFailed {
  readonly type: 'failed';
  readonly code: string;
  readonly message: string;
  readonly aborted: boolean;
}

export type ExportWorkerResponse =
  | ExportWorkerFrameRequest
  | ExportWorkerAudioRequest
  | ExportWorkerProgress
  | ExportWorkerCompleted
  | ExportWorkerFailed;
