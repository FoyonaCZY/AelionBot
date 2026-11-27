import { throwIfAborted } from '@aelionsdk/core';

/** A bounded PCM source for offline analysis, mirroring the waveform readFrames contract. */
export interface AnalysisSource {
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly totalFrames: number;
  readonly readFrames: (startFrame: number, frameCount: number, signal?: AbortSignal) => Promise<Float32Array>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: number) => void;
}

/** A single detected beat. */
export interface BeatMarker {
  /** Beat start frame. */
  readonly frame: number;
  /** Frame-based duration (estimated from the analysis window). */
  readonly frameCount: number;
  /** Normalized beat strength, 0..1. */
  readonly strength: number;
}

/** Result of beat detection over a PCM source. */
export interface BeatDetectionResult {
  readonly sampleRate: number;
  readonly totalFrames: number;
  readonly beats: readonly BeatMarker[];
}

/** A candidate boundary inferred from a discontinuity in audio energy. */
export interface AudioEnergyBoundary {
  /** Audio frame where the energy change is detected. */
  readonly frame: number;
  /** Normalized change magnitude, 0..1. */
  readonly magnitude: number;
}

/** Result of audio-energy change detection over a PCM source. */
export interface AudioEnergyChangeDetectionResult {
  readonly sampleRate: number;
  readonly totalFrames: number;
  readonly changes: readonly AudioEnergyBoundary[];
}

/** @deprecated Use AudioEnergyBoundary; audio alone cannot detect video scenes. */
export type SceneBoundary = AudioEnergyBoundary;

/** @deprecated Use AudioEnergyChangeDetectionResult. */
export interface SceneDetectionResult {
  readonly sampleRate: number;
  readonly totalFrames: number;
  readonly scenes: readonly AudioEnergyBoundary[];
}

const MIN_CHANGE_DB = 6;

function validateSource(options: AnalysisSource, threshold: number, label: string): void {
  if (!Number.isSafeInteger(options.sampleRate) || options.sampleRate <= 0) {
    throw new RangeError(`${label} sampleRate must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(options.channelCount) || options.channelCount <= 0) {
    throw new RangeError(`${label} channelCount must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(options.totalFrames) || options.totalFrames < 0) {
    throw new RangeError(`${label} totalFrames must be a non-negative safe integer`);
  }
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new RangeError(`${label} threshold must be a non-negative finite number`);
  }
}

/**
 * Detect beats from an interleaved PCM source using a bounded energy-envelope
 * onset detector. The signal is processed in fixed windows, computing a local
 * RMS envelope; an onset is flagged where the envelope rises above the local
 * noise floor by `minimumOnsetDb`. Bounded memory: only the current window and
 * a rolling floor are retained.
 */
export async function detectBeats(
  options: AnalysisSource & { readonly minimumOnsetDb?: number },
): Promise<BeatDetectionResult> {
  const sampleRate = options.sampleRate;
  const channelCount = options.channelCount;
  const totalFrames = options.totalFrames;
  const minimumOnsetDb = options.minimumOnsetDb ?? MIN_CHANGE_DB;
  validateSource(options, minimumOnsetDb, 'Beat detection');
  const windowFrames = Math.max(1, Math.round(sampleRate / 20));
  const beats: BeatMarker[] = [];
  let previousDb = 0;
  let floor = 0;
  let lastBeatFrame = -windowFrames;
  for (let startFrame = 0; startFrame < totalFrames; startFrame += windowFrames) {
    throwIfAborted(options.signal, 'Beat detection');
    const frameCount = Math.min(windowFrames, totalFrames - startFrame);
    const pcm = await options.readFrames(startFrame, frameCount, options.signal);
    if (pcm.length !== frameCount * channelCount) {
      throw new RangeError('Beat source returned an unexpected PCM length');
    }
    let squares = 0;
    for (const sample of pcm) squares += sample * sample;
    const envelope = Math.sqrt(squares / Math.max(1, frameCount * channelCount));
    const db = 20 * Math.log10(Math.max(1e-9, envelope));
    floor = floor === 0 ? db : Math.max(-120, floor * 0.95 + db * 0.05);
    const onset = db - floor > minimumOnsetDb && db > previousDb;
    if (onset && startFrame - lastBeatFrame >= windowFrames) {
      const strength = Math.min(1, Math.max(0, (db - floor) / 24));
      beats.push({ frame: startFrame, frameCount, strength });
      lastBeatFrame = startFrame;
    }
    previousDb = db;
    options.onProgress?.((startFrame + frameCount) / totalFrames);
  }
  if (totalFrames === 0) options.onProgress?.(1);
  return { sampleRate, totalFrames, beats };
}

/**
 * Detect audio-energy discontinuities as editing candidates. This function
 * does not inspect video pixels and therefore deliberately makes no claim to
 * detect scene boundaries.
 */
export async function detectAudioEnergyChanges(
  options: AnalysisSource & { readonly minimumJumpDb?: number },
): Promise<AudioEnergyChangeDetectionResult> {
  const sampleRate = options.sampleRate;
  const channelCount = options.channelCount;
  const totalFrames = options.totalFrames;
  const minimumJumpDb = options.minimumJumpDb ?? MIN_CHANGE_DB;
  validateSource(options, minimumJumpDb, 'Audio energy analysis');
  const windowFrames = Math.max(1, Math.round(sampleRate / 10));
  const changes: AudioEnergyBoundary[] = [];
  let previousDb = 0;
  for (let startFrame = 0; startFrame < totalFrames; startFrame += windowFrames) {
    throwIfAborted(options.signal, 'Scene detection');
    const frameCount = Math.min(windowFrames, totalFrames - startFrame);
    const pcm = await options.readFrames(startFrame, frameCount, options.signal);
    if (pcm.length !== frameCount * channelCount) {
      throw new RangeError('Scene source returned an unexpected PCM length');
    }
    let squares = 0;
    for (const sample of pcm) squares += sample * sample;
    const envelope = Math.sqrt(squares / Math.max(1, frameCount * channelCount));
    const db = 20 * Math.log10(Math.max(1e-9, envelope));
    if (startFrame > 0) {
      const jump = Math.abs(db - previousDb);
      if (jump >= minimumJumpDb) {
        changes.push({ frame: startFrame, magnitude: Math.min(1, jump / 24) });
      }
    }
    previousDb = db;
    options.onProgress?.((startFrame + frameCount) / totalFrames);
  }
  if (totalFrames === 0) options.onProgress?.(1);
  return { sampleRate, totalFrames, changes };
}

/**
 * @deprecated Audio-only input cannot detect video scenes. Use
 * `detectAudioEnergyChanges` and treat the result as editing candidates.
 */
export async function detectScenes(options: AnalysisSource & { readonly minimumJumpDb?: number }) {
  const result = await detectAudioEnergyChanges(options);
  return {
    sampleRate: result.sampleRate,
    totalFrames: result.totalFrames,
    scenes: result.changes,
  };
}
