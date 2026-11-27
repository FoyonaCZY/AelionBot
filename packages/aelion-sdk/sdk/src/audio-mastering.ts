import {
  SidechainDucker,
  StreamingLoudnessAnalyzer,
  TruePeakLimiter,
  renderIrAudio,
  type LoudnessReport,
} from '@aelionsdk/audio';
import { sampleIndexAtTime, throwIfAborted } from '@aelionsdk/core';
import type { RenderIr } from '@aelionsdk/render-ir';

import type { AelionAudioMasteringOptions, AelionMediaProvider } from './types.js';

export interface MasteredAudioRequest {
  readonly startFrame: number;
  readonly frameCount: number;
  readonly channelCount: number;
}

export interface AudioMasteringReport {
  readonly inputLoudness?: LoudnessReport;
  readonly appliedGainDb: number;
  readonly limiterEnabled: boolean;
  readonly duckingRules: number;
}

export interface MasteredAudioRenderer {
  readonly report: AudioMasteringReport;
  readonly render: (request: MasteredAudioRequest, signal?: AbortSignal) => Promise<Float32Array>;
}

export interface CreateMasteredAudioRendererOptions {
  readonly ir: RenderIr;
  readonly source: AelionMediaProvider;
  readonly processing?: AelionAudioMasteringOptions;
  readonly signal?: AbortSignal;
  readonly onAnalysisProgress?: (progress: number) => void;
}

function channelCountForIr(ir: RenderIr): number {
  if (ir.channelLayout === 'mono') return 1;
  if (ir.channelLayout === 'stereo') return 2;
  if (ir.channelLayout === '5.1') return 6;
  throw new RangeError(`Unsupported channel layout ${ir.channelLayout}`);
}

function assertTrackSelection(ir: RenderIr, ids: readonly string[], name: string): void {
  for (const id of ids) {
    const track = ir.tracks.find((value) => value.id === id);
    if (track === undefined) throw new ReferenceError(`${name} references unknown Track ${id}`);
    if (track.kind !== 'audio') throw new TypeError(`${name} requires audio Tracks`);
  }
}

function gainPcm(pcm: Float32Array, gain: number): Float32Array {
  if (gain === 1) return pcm;
  const output = new Float32Array(pcm.length);
  for (let index = 0; index < pcm.length; index += 1) {
    output[index] = (pcm[index] ?? 0) * gain;
  }
  return output;
}

function monoDetector(pcm: Float32Array, channels: number): Float32Array {
  const frames = pcm.length / channels;
  const output = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += Math.abs(pcm[frame * channels + channel] ?? 0);
    }
    output[frame] = sum / channels;
  }
  return output;
}

export async function createMasteredAudioRenderer(
  options: CreateMasteredAudioRendererOptions,
): Promise<MasteredAudioRenderer> {
  const processing = options.processing ?? {};
  const expectedChannelCount = channelCountForIr(options.ir);
  const totalFrames = sampleIndexAtTime(options.ir.durationUs, options.ir.sampleRate, 'floor');
  const raw = (request: MasteredAudioRequest, signal?: AbortSignal, trackIds?: readonly string[]) =>
    renderIrAudio({
      ir: options.ir,
      startFrame: request.startFrame,
      frameCount: request.frameCount,
      channelCount: request.channelCount,
      source: options.source,
      ...(trackIds === undefined ? {} : { trackIds }),
      ...(signal === undefined ? {} : { signal }),
    });

  let inputLoudness: LoudnessReport | undefined;
  let appliedGainDb = 0;
  if (processing.targetLufs !== undefined) {
    if (!Number.isFinite(processing.targetLufs)) {
      throw new RangeError('targetLufs must be finite');
    }
    const analyzer = new StreamingLoudnessAnalyzer(options.ir.sampleRate, expectedChannelCount);
    const blockFrames = 16_384;
    for (let startFrame = 0; startFrame < totalFrames; startFrame += blockFrames) {
      throwIfAborted(options.signal, 'Audio mastering analysis');
      const frameCount = Math.min(blockFrames, totalFrames - startFrame);
      analyzer.process(await raw({ startFrame, frameCount, channelCount: expectedChannelCount }, options.signal));
      options.onAnalysisProgress?.((startFrame + frameCount) / Math.max(1, totalFrames));
    }
    if (totalFrames === 0) options.onAnalysisProgress?.(1);
    inputLoudness = analyzer.finish();
    if (Number.isFinite(inputLoudness.integratedLufs)) {
      const desired = processing.targetLufs - inputLoudness.integratedLufs;
      const maximum = processing.maximumGainDb ?? 24;
      if (!Number.isFinite(maximum) || maximum < 0) {
        throw new RangeError('maximumGainDb must be a non-negative finite number');
      }
      appliedGainDb = Math.max(-maximum, Math.min(maximum, desired));
    }
  }
  const linearGain = 10 ** (appliedGainDb / 20);

  const ducking = (processing.ducking ?? []).map((rule, index) => {
    assertTrackSelection(options.ir, rule.programTrackIds, `ducking[${index.toString()}].program`);
    assertTrackSelection(options.ir, rule.sidechainTrackIds, `ducking[${index.toString()}].sidechain`);
    const lookaheadUs = rule.lookaheadUs ?? 0;
    if (lookaheadUs !== 0) {
      throw new RangeError('Export ducking lookaheadUs must be zero until compensated tail flushing is enabled');
    }
    return {
      rule,
      processor: new SidechainDucker({
        sampleRate: options.ir.sampleRate,
        channelCount: expectedChannelCount,
        thresholdDb: rule.thresholdDb ?? -30,
        reductionDb: rule.reductionDb ?? -12,
        attackUs: rule.attackUs ?? 10_000,
        releaseUs: rule.releaseUs ?? 250_000,
        lookaheadUs,
      }),
    };
  });
  const duckedProgramTracks = new Set<string>();
  for (const { rule } of ducking) {
    for (const trackId of rule.programTrackIds) {
      if (duckedProgramTracks.has(trackId)) {
        throw new TypeError(`Audio Track ${trackId} cannot be a program Track in multiple ducking rules`);
      }
      duckedProgramTracks.add(trackId);
    }
  }

  const limiterEnabled = processing.limiter !== undefined && processing.limiter !== false;
  const limiterOptions = limiterEnabled ? processing.limiter : undefined;
  if ((limiterOptions?.lookaheadUs ?? 0) !== 0) {
    throw new RangeError('Export limiter lookaheadUs must be zero until compensated tail flushing is enabled');
  }
  let limiter: TruePeakLimiter | undefined;
  let expectedStartFrame = 0;

  return {
    report: {
      ...(inputLoudness === undefined ? {} : { inputLoudness }),
      appliedGainDb,
      limiterEnabled,
      duckingRules: ducking.length,
    },
    render: async (request, signal) => {
      if (request.channelCount !== expectedChannelCount) {
        throw new RangeError(`Mastered audio requires ${expectedChannelCount.toString()} channels`);
      }
      if (request.startFrame !== expectedStartFrame) {
        throw new RangeError('Mastered audio blocks must be requested sequentially from frame zero');
      }
      expectedStartFrame += request.frameCount;
      let output = gainPcm(await raw(request, signal), linearGain);
      for (const value of ducking) {
        const [programRaw, sidechain] = await Promise.all([
          raw(request, signal, value.rule.programTrackIds),
          raw(request, signal, value.rule.sidechainTrackIds),
        ]);
        const program = gainPcm(programRaw, linearGain);
        const ducked = value.processor.process(program, monoDetector(sidechain, request.channelCount));
        const mixed = new Float32Array(output.length);
        for (let index = 0; index < mixed.length; index += 1) {
          mixed[index] = (output[index] ?? 0) - (program[index] ?? 0) + (ducked[index] ?? 0);
        }
        output = mixed;
      }
      if (limiterEnabled) {
        limiter ??= new TruePeakLimiter({
          sampleRate: options.ir.sampleRate,
          channelCount: request.channelCount,
          ceilingDbtp: limiterOptions?.ceilingDbtp ?? -1,
          releaseUs: limiterOptions?.releaseUs ?? 100_000,
          lookaheadUs: 0,
        });
        output = limiter.process(output);
      }
      return output;
    },
  };
}
