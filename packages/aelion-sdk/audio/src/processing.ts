import { throwIfAborted } from '@aelionsdk/core';

export interface AudioChannelMatrix {
  readonly inputChannels: number;
  readonly outputChannels: number;
  /** Row-major output × input gain matrix. */
  readonly gains: readonly number[];
}

export function applyChannelMatrix(input: Float32Array, matrix: AudioChannelMatrix): Float32Array {
  if (
    !Number.isSafeInteger(matrix.inputChannels) ||
    !Number.isSafeInteger(matrix.outputChannels) ||
    matrix.inputChannels <= 0 ||
    matrix.outputChannels <= 0 ||
    matrix.gains.length !== matrix.inputChannels * matrix.outputChannels ||
    input.length % matrix.inputChannels !== 0
  ) {
    throw new RangeError('Invalid channel matrix or interleaved PCM length');
  }
  const frames = input.length / matrix.inputChannels;
  const output = new Float32Array(frames * matrix.outputChannels);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let outputChannel = 0; outputChannel < matrix.outputChannels; outputChannel += 1) {
      let sample = 0;
      for (let inputChannel = 0; inputChannel < matrix.inputChannels; inputChannel += 1) {
        sample +=
          (input[frame * matrix.inputChannels + inputChannel] ?? 0) *
          (matrix.gains[outputChannel * matrix.inputChannels + inputChannel] ?? 0);
      }
      output[frame * matrix.outputChannels + outputChannel] = sample;
    }
  }
  return output;
}

export interface SidechainDuckerOptions {
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly thresholdDb: number;
  readonly reductionDb: number;
  readonly attackUs: number;
  readonly releaseUs: number;
  readonly lookaheadUs: number;
}

function smoothingCoefficient(durationUs: number, sampleRate: number): number {
  return durationUs <= 0 ? 0 : Math.exp(-1 / ((durationUs / 1_000_000) * sampleRate));
}

export class SidechainDucker {
  readonly #options: SidechainDuckerOptions;
  readonly #delay: Float32Array;
  readonly #attack: number;
  readonly #release: number;
  #delayFrame = 0;
  #gain = 1;

  public constructor(options: SidechainDuckerOptions) {
    if (
      !Number.isSafeInteger(options.sampleRate) ||
      !Number.isSafeInteger(options.channelCount) ||
      options.sampleRate <= 0 ||
      options.channelCount <= 0 ||
      options.reductionDb > 0 ||
      options.attackUs < 0 ||
      options.releaseUs < 0 ||
      options.lookaheadUs < 0
    ) {
      throw new RangeError('Invalid sidechain ducking options');
    }
    this.#options = options;
    const lookaheadFrames = Math.ceil((options.lookaheadUs * options.sampleRate) / 1_000_000);
    this.#delay = new Float32Array(lookaheadFrames * options.channelCount);
    this.#attack = smoothingCoefficient(options.attackUs, options.sampleRate);
    this.#release = smoothingCoefficient(options.releaseUs, options.sampleRate);
  }

  public get latencyFrames(): number {
    return this.#delay.length / this.#options.channelCount;
  }

  public reset(): void {
    this.#delay.fill(0);
    this.#delayFrame = 0;
    this.#gain = 1;
  }

  public process(program: Float32Array, sidechain: Float32Array): Float32Array {
    const frames = sidechain.length;
    if (program.length !== frames * this.#options.channelCount) {
      throw new RangeError('Sidechain must contain one mono sample per program frame');
    }
    const output = new Float32Array(program.length);
    const minimumGain = 10 ** (this.#options.reductionDb / 20);
    const threshold = 10 ** (this.#options.thresholdDb / 20);
    for (let frame = 0; frame < frames; frame += 1) {
      const detector = Math.abs(sidechain[frame] ?? 0);
      const target = detector > threshold ? minimumGain : 1;
      const coefficient = target < this.#gain ? this.#attack : this.#release;
      this.#gain = target + coefficient * (this.#gain - target);
      for (let channel = 0; channel < this.#options.channelCount; channel += 1) {
        const inputSample = program[frame * this.#options.channelCount + channel] ?? 0;
        if (this.latencyFrames === 0) {
          output[frame * this.#options.channelCount + channel] = inputSample * this.#gain;
          continue;
        }
        const delayIndex = this.#delayFrame * this.#options.channelCount + channel;
        output[frame * this.#options.channelCount + channel] = (this.#delay[delayIndex] ?? 0) * this.#gain;
        this.#delay[delayIndex] = inputSample;
      }
      if (this.latencyFrames > 0) {
        this.#delayFrame = (this.#delayFrame + 1) % this.latencyFrames;
      }
    }
    return output;
  }
}

export interface LoudnessReport {
  readonly integratedLufs: number;
  readonly ungatedLufs: number;
  readonly truePeakDbtp: number;
  readonly samplePeakDbfs: number;
  readonly gatedBlocks: number;
  readonly totalBlocks: number;
}

function decibels(value: number): number {
  return value <= 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(value);
}

/** Deterministic EBU-style block gating with 4× linear true-peak estimation. */
export function analyzeLoudness(pcm: Float32Array, sampleRate: number, channelCount: number): LoudnessReport {
  if (
    !Number.isSafeInteger(sampleRate) ||
    !Number.isSafeInteger(channelCount) ||
    sampleRate <= 0 ||
    channelCount <= 0 ||
    pcm.length % channelCount !== 0
  ) {
    throw new RangeError('Invalid loudness PCM format');
  }
  const frames = pcm.length / channelCount;
  const blockFrames = Math.max(1, Math.round(sampleRate * 0.4));
  const energies: number[] = [];
  let samplePeak = 0;
  let truePeak = 0;
  for (let start = 0; start < frames; start += blockFrames) {
    const end = Math.min(frames, start + blockFrames);
    let sumSquares = 0;
    let count = 0;
    for (let frame = start; frame < end; frame += 1) {
      for (let channel = 0; channel < channelCount; channel += 1) {
        const current = pcm[frame * channelCount + channel] ?? 0;
        const next = pcm[Math.min(frames - 1, frame + 1) * channelCount + channel] ?? current;
        samplePeak = Math.max(samplePeak, Math.abs(current));
        for (let phase = 0; phase < 4; phase += 1) {
          truePeak = Math.max(truePeak, Math.abs(current + ((next - current) * phase) / 4));
        }
        sumSquares += current * current;
        count += 1;
      }
    }
    energies.push(count === 0 ? 0 : sumSquares / count);
  }
  const lufs = (energy: number): number => (energy <= 0 ? Number.NEGATIVE_INFINITY : -0.691 + 10 * Math.log10(energy));
  const absoluteGated = energies.filter((energy) => lufs(energy) >= -70);
  const ungatedEnergy = absoluteGated.reduce((sum, value) => sum + value, 0) / Math.max(1, absoluteGated.length);
  const relativeThreshold = lufs(ungatedEnergy) - 10;
  const gated = absoluteGated.filter((energy) => lufs(energy) >= relativeThreshold);
  const integratedEnergy = gated.reduce((sum, value) => sum + value, 0) / Math.max(1, gated.length);
  return {
    integratedLufs: lufs(integratedEnergy),
    ungatedLufs: lufs(ungatedEnergy),
    truePeakDbtp: decibels(truePeak),
    samplePeakDbfs: decibels(samplePeak),
    gatedBlocks: gated.length,
    totalBlocks: energies.length,
  };
}

export interface TruePeakLimiterOptions {
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly ceilingDbtp?: number;
  readonly lookaheadUs?: number;
  readonly releaseUs?: number;
}

export class TruePeakLimiter {
  readonly #channels: number;
  readonly #ceiling: number;
  readonly #release: number;
  readonly #delay: Float32Array;
  #frame = 0;
  #gain = 1;

  public constructor(options: TruePeakLimiterOptions) {
    if (options.sampleRate <= 0 || options.channelCount <= 0) {
      throw new RangeError('Invalid limiter format');
    }
    this.#channels = options.channelCount;
    this.#ceiling = 10 ** ((options.ceilingDbtp ?? -1) / 20);
    this.#release = smoothingCoefficient(options.releaseUs ?? 100_000, options.sampleRate);
    const frames = Math.max(0, Math.ceil(((options.lookaheadUs ?? 5_000) * options.sampleRate) / 1_000_000));
    this.#delay = new Float32Array(frames * options.channelCount);
  }

  public get latencyFrames(): number {
    return this.#delay.length / this.#channels;
  }

  public process(input: Float32Array): Float32Array {
    if (input.length % this.#channels !== 0) throw new RangeError('Invalid limiter PCM length');
    const output = new Float32Array(input.length);
    for (let frame = 0; frame < input.length / this.#channels; frame += 1) {
      let peak = 0;
      for (let channel = 0; channel < this.#channels; channel += 1) {
        peak = Math.max(peak, Math.abs(input[frame * this.#channels + channel] ?? 0));
      }
      const target = peak > this.#ceiling ? this.#ceiling / peak : 1;
      this.#gain = target < this.#gain ? target : target + this.#release * (this.#gain - target);
      for (let channel = 0; channel < this.#channels; channel += 1) {
        const inputSample = input[frame * this.#channels + channel] ?? 0;
        if (this.latencyFrames === 0) {
          output[frame * this.#channels + channel] = inputSample * this.#gain;
          continue;
        }
        const index = this.#frame * this.#channels + channel;
        output[frame * this.#channels + channel] = (this.#delay[index] ?? 0) * this.#gain;
        this.#delay[index] = inputSample;
      }
      if (this.latencyFrames > 0) this.#frame = (this.#frame + 1) % this.latencyFrames;
    }
    return output;
  }
}

/** Incremental variant of analyzeLoudness for bounded-memory export prepasses. */
export class StreamingLoudnessAnalyzer {
  readonly #channelCount: number;
  readonly #blockFrames: number;
  readonly #energies: number[] = [];
  readonly #carry: number[] = [];
  readonly #previous: number[];
  #samplePeak = 0;
  #truePeak = 0;

  public constructor(sampleRate: number, channelCount: number) {
    if (
      !Number.isSafeInteger(sampleRate) ||
      !Number.isSafeInteger(channelCount) ||
      sampleRate <= 0 ||
      channelCount <= 0
    ) {
      throw new RangeError('Invalid loudness PCM format');
    }
    this.#channelCount = channelCount;
    this.#blockFrames = Math.max(1, Math.round(sampleRate * 0.4));
    this.#previous = Array.from({ length: channelCount }, () => 0);
  }

  public process(pcm: Float32Array): void {
    if (pcm.length % this.#channelCount !== 0) {
      throw new RangeError('Invalid loudness PCM block length');
    }
    for (let index = 0; index < pcm.length; index += 1) {
      const sample = pcm[index] ?? 0;
      const channel = index % this.#channelCount;
      const previous = this.#previous[channel] ?? sample;
      this.#samplePeak = Math.max(this.#samplePeak, Math.abs(sample));
      for (let phase = 1; phase <= 4; phase += 1) {
        this.#truePeak = Math.max(this.#truePeak, Math.abs(previous + ((sample - previous) * phase) / 4));
      }
      this.#previous[channel] = sample;
      this.#carry.push(sample);
      if (this.#carry.length === this.#blockFrames * this.#channelCount) {
        this.#commitCarry();
      }
    }
  }

  public finish(): LoudnessReport {
    if (this.#carry.length > 0) this.#commitCarry();
    const lufs = (energy: number): number =>
      energy <= 0 ? Number.NEGATIVE_INFINITY : -0.691 + 10 * Math.log10(energy);
    const absoluteGated = this.#energies.filter((energy) => lufs(energy) >= -70);
    const ungatedEnergy = absoluteGated.reduce((sum, value) => sum + value, 0) / Math.max(1, absoluteGated.length);
    const relativeThreshold = lufs(ungatedEnergy) - 10;
    const gated = absoluteGated.filter((energy) => lufs(energy) >= relativeThreshold);
    const integratedEnergy = gated.reduce((sum, value) => sum + value, 0) / Math.max(1, gated.length);
    return {
      integratedLufs: lufs(integratedEnergy),
      ungatedLufs: lufs(ungatedEnergy),
      truePeakDbtp: decibels(this.#truePeak),
      samplePeakDbfs: decibels(this.#samplePeak),
      gatedBlocks: gated.length,
      totalBlocks: this.#energies.length,
    };
  }

  #commitCarry(): void {
    let sumSquares = 0;
    for (const sample of this.#carry) sumSquares += sample * sample;
    this.#energies.push(sumSquares / Math.max(1, this.#carry.length));
    this.#carry.length = 0;
  }
}

export interface WaveformPeak {
  readonly startFrame: number;
  readonly frameCount: number;
  readonly min: readonly number[];
  readonly max: readonly number[];
  readonly rms: readonly number[];
}

export interface WaveformPeakResult {
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly totalFrames: number;
  readonly windowFrames: number;
  readonly peaks: readonly WaveformPeak[];
}

export interface BuildWaveformPeaksOptions {
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly totalFrames: number;
  readonly windowFrames?: number;
  readonly maxPoints?: number;
  readonly readFrames: (startFrame: number, frameCount: number, signal?: AbortSignal) => Promise<Float32Array>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: number) => void;
}

export async function buildWaveformPeaks(options: BuildWaveformPeaksOptions): Promise<WaveformPeakResult> {
  const maxPoints = options.maxPoints ?? 100_000;
  if (
    options.sampleRate <= 0 ||
    options.channelCount <= 0 ||
    !Number.isSafeInteger(options.totalFrames) ||
    options.totalFrames < 0 ||
    !Number.isSafeInteger(maxPoints) ||
    maxPoints <= 0
  ) {
    throw new RangeError('Invalid waveform options');
  }
  const requestedWindow = options.windowFrames ?? Math.max(1, Math.round(options.sampleRate / 100));
  const windowFrames = Math.max(requestedWindow, Math.ceil(options.totalFrames / maxPoints));
  if (!Number.isSafeInteger(windowFrames) || windowFrames <= 0) {
    throw new RangeError('windowFrames must be a positive safe integer');
  }
  const peaks: WaveformPeak[] = [];
  for (let startFrame = 0; startFrame < options.totalFrames; startFrame += windowFrames) {
    throwIfAborted(options.signal, 'Waveform peak generation');
    const frameCount = Math.min(windowFrames, options.totalFrames - startFrame);
    const pcm = await options.readFrames(startFrame, frameCount, options.signal);
    if (pcm.length !== frameCount * options.channelCount) {
      throw new RangeError('Waveform source returned an unexpected PCM length');
    }
    const minimum = Array.from({ length: options.channelCount }, () => Number.POSITIVE_INFINITY);
    const maximum = Array.from({ length: options.channelCount }, () => Number.NEGATIVE_INFINITY);
    const squares = Array.from({ length: options.channelCount }, () => 0);
    for (let frame = 0; frame < frameCount; frame += 1) {
      for (let channel = 0; channel < options.channelCount; channel += 1) {
        const sample = pcm[frame * options.channelCount + channel] ?? 0;
        minimum[channel] = Math.min(minimum[channel] ?? sample, sample);
        maximum[channel] = Math.max(maximum[channel] ?? sample, sample);
        squares[channel] = (squares[channel] ?? 0) + sample * sample;
      }
    }
    peaks.push({
      startFrame,
      frameCount,
      min: minimum,
      max: maximum,
      rms: squares.map((sum) => Math.sqrt(sum / frameCount)),
    });
    options.onProgress?.((startFrame + frameCount) / Math.max(1, options.totalFrames));
  }
  if (options.totalFrames === 0) options.onProgress?.(1);
  return {
    sampleRate: options.sampleRate,
    channelCount: options.channelCount,
    totalFrames: options.totalFrames,
    windowFrames,
    peaks,
  };
}

/** A contiguous range of audio frames. */
export interface AudioFrameRange {
  readonly startFrame: number;
  readonly frameCount: number;
}

export interface SilenceDetectionResult {
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly totalFrames: number;
  readonly thresholdDb: number;
  readonly nonSilent: readonly AudioFrameRange[];
  readonly silent: readonly AudioFrameRange[];
  readonly removedFrames: number;
}

export interface DetectSilenceOptions {
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly totalFrames: number;
  readonly thresholdDb?: number;
  readonly minimumSilenceUs?: number;
  readonly paddingUs?: number;
  readonly windowFrames?: number;
  readonly readFrames: (startFrame: number, frameCount: number, signal?: AbortSignal) => Promise<Float32Array>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: number) => void;
}

function invertFrameRanges(ranges: readonly AudioFrameRange[], totalFrames: number): readonly AudioFrameRange[] {
  const result: AudioFrameRange[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.startFrame > cursor) {
      result.push({ startFrame: cursor, frameCount: range.startFrame - cursor });
    }
    cursor = Math.max(cursor, range.startFrame + range.frameCount);
  }
  if (cursor < totalFrames) result.push({ startFrame: cursor, frameCount: totalFrames - cursor });
  return result;
}

/** Detect audible ranges with bounded reads and deterministic window merging. */
export async function detectSilence(options: DetectSilenceOptions): Promise<SilenceDetectionResult> {
  const thresholdDb = options.thresholdDb ?? -45;
  const minimumSilenceUs = options.minimumSilenceUs ?? 250_000;
  const paddingUs = options.paddingUs ?? 20_000;
  const windowFrames = options.windowFrames ?? 1_024;
  if (
    !Number.isSafeInteger(options.sampleRate) ||
    !Number.isSafeInteger(options.channelCount) ||
    !Number.isSafeInteger(options.totalFrames) ||
    !Number.isSafeInteger(windowFrames) ||
    options.sampleRate <= 0 ||
    options.channelCount <= 0 ||
    options.totalFrames < 0 ||
    windowFrames <= 0 ||
    !Number.isFinite(thresholdDb) ||
    minimumSilenceUs < 0 ||
    paddingUs < 0
  ) {
    throw new RangeError('Invalid silence detection options');
  }
  const threshold = 10 ** (thresholdDb / 20);
  const audibleWindows: AudioFrameRange[] = [];
  for (let startFrame = 0; startFrame < options.totalFrames; startFrame += windowFrames) {
    throwIfAborted(options.signal, 'Silence detection');
    const frameCount = Math.min(windowFrames, options.totalFrames - startFrame);
    const pcm = await options.readFrames(startFrame, frameCount, options.signal);
    if (pcm.length !== frameCount * options.channelCount) {
      throw new RangeError('Silence source returned an unexpected PCM length');
    }
    let sumSquares = 0;
    for (const sample of pcm) sumSquares += sample * sample;
    const rms = Math.sqrt(sumSquares / Math.max(1, pcm.length));
    if (rms > threshold) audibleWindows.push({ startFrame, frameCount });
    options.onProgress?.((startFrame + frameCount) / Math.max(1, options.totalFrames));
  }
  const minimumSilenceFrames = Math.round((minimumSilenceUs * options.sampleRate) / 1_000_000);
  const paddingFrames = Math.round((paddingUs * options.sampleRate) / 1_000_000);
  const nonSilent: AudioFrameRange[] = [];
  for (const window of audibleWindows) {
    const startFrame = Math.max(0, window.startFrame - paddingFrames);
    const endFrame = Math.min(options.totalFrames, window.startFrame + window.frameCount + paddingFrames);
    const previous = nonSilent.at(-1);
    if (previous !== undefined && startFrame - (previous.startFrame + previous.frameCount) <= minimumSilenceFrames) {
      nonSilent[nonSilent.length - 1] = {
        startFrame: previous.startFrame,
        frameCount: endFrame - previous.startFrame,
      };
    } else {
      nonSilent.push({ startFrame, frameCount: endFrame - startFrame });
    }
  }
  const silent = invertFrameRanges(nonSilent, options.totalFrames);
  if (options.totalFrames === 0) options.onProgress?.(1);
  return {
    sampleRate: options.sampleRate,
    channelCount: options.channelCount,
    totalFrames: options.totalFrames,
    thresholdDb,
    nonSilent,
    silent,
    removedFrames: silent.reduce((sum, range) => sum + range.frameCount, 0),
  };
}
