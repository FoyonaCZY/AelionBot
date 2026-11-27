import {
  StreamingLoudnessAnalyzer,
  buildWaveformPeaks,
  detectBeats,
  detectAudioEnergyChanges,
  detectSilence,
  renderIrAudio,
  type BeatDetectionResult,
  type AudioEnergyChangeDetectionResult,
  type LoudnessReport,
  type SilenceDetectionResult,
  type WaveformPeakResult,
} from '@aelionsdk/audio';
import { sampleBoundaryUs, sampleIndexAtTime, type JsonObject } from '@aelionsdk/core';
import type { AelionProject, ItemEntity } from '@aelionsdk/project-schema';
import type { RenderIr } from '@aelionsdk/render-ir';
import type { TransactionBuilder, TransactionCommit } from '@aelionsdk/transaction';

import type {
  AelionAudioAnalysisOptions,
  AelionAudioApi,
  AelionAudioMasteringOptions,
  AelionAudioRemoveSilenceOptions,
  AelionAudioRemoveSilenceResult,
  AelionAudioSceneCompatibilityResult,
  AelionAudioWaveformOptions,
  AelionMediaProvider,
} from './types.js';

const MASTERING_EXTENSION = 'aelion.audio.mastering';

interface AudioControllerHost {
  readonly ir: () => RenderIr;
  readonly project: () => Readonly<AelionProject>;
  readonly media: () => AelionMediaProvider;
  readonly revision: () => bigint;
  readonly edit: (label: string, callback: (transaction: TransactionBuilder) => void) => TransactionCommit;
}

type AudioItem = ItemEntity & {
  type: 'audio';
  source: {
    assetId: string;
    stream: { type: 'audio'; index: number };
    sourceRange: { startUs: number; durationUs: number };
    timeMapping:
      | {
          type: 'linear';
          rate: { numerator: number; denominator: number };
          reverse: boolean;
          boundary: 'error' | 'hold' | 'loop' | 'transparent';
        }
      | { type: 'curve' };
  };
};

function channelCount(layout: string): number {
  if (layout === 'mono') return 1;
  if (layout === 'stereo') return 2;
  if (layout === '5.1') return 6;
  throw new RangeError(`Unsupported channel layout ${layout}`);
}

function totalFrames(ir: RenderIr): number {
  return sampleIndexAtTime(ir.durationUs, ir.sampleRate, 'floor');
}

function readSelection(
  host: AudioControllerHost,
  options: {
    readonly trackIds?: readonly string[];
    readonly itemIds?: readonly string[];
  },
  startFrame: number,
  frameCount: number,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const ir = host.ir();
  return renderIrAudio({
    ir,
    startFrame,
    frameCount,
    channelCount: channelCount(ir.channelLayout),
    source: host.media(),
    ...(options.trackIds === undefined ? {} : { trackIds: options.trackIds }),
    ...(options.itemIds === undefined ? {} : { itemIds: options.itemIds }),
    ...(signal === undefined ? {} : { signal }),
  });
}

function assertAudioItem(project: Readonly<AelionProject>, itemId: string): AudioItem {
  const item = project.items[itemId];
  if (item === undefined) throw new ReferenceError(`Unknown Item: ${itemId}`);
  if (item.type !== 'audio') throw new TypeError(`${itemId} is not an audio Item`);
  return item as AudioItem;
}

function masteringFrom(project: Readonly<AelionProject>, sequenceId: string) {
  const sequence = project.sequences[sequenceId];
  const extensions = sequence?.extensions;
  const value =
    extensions !== null && typeof extensions === 'object' && !Array.isArray(extensions)
      ? extensions[MASTERING_EXTENSION]
      : undefined;
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (structuredClone(value) as unknown as AelionAudioMasteringOptions)
    : undefined;
}

export class SessionAudioController implements AelionAudioApi {
  public constructor(private readonly host: AudioControllerHost) {}

  public getMastering(): AelionAudioMasteringOptions | undefined {
    const ir = this.host.ir();
    return masteringFrom(this.host.project(), ir.sequenceId);
  }

  public configureMastering(options: AelionAudioMasteringOptions): TransactionCommit {
    const ir = this.host.ir();
    const project = this.host.project();
    const sequence = project.sequences[ir.sequenceId];
    if (sequence === undefined) throw new ReferenceError(`Unknown Sequence: ${ir.sequenceId}`);
    const currentExtensions =
      sequence.extensions !== null && typeof sequence.extensions === 'object' && !Array.isArray(sequence.extensions)
        ? sequence.extensions
        : {};
    const extensions = {
      ...currentExtensions,
      [MASTERING_EXTENSION]: structuredClone(options) as unknown as JsonObject,
    };
    return this.host.edit('Configure audio mastering', (transaction) => {
      transaction.setField('sequences', ir.sequenceId, ['extensions'], extensions);
    });
  }

  public async analyze(options: AelionAudioAnalysisOptions = {}): Promise<LoudnessReport> {
    const ir = this.host.ir();
    const channels = channelCount(ir.channelLayout);
    const analyzer = new StreamingLoudnessAnalyzer(ir.sampleRate, channels);
    const frames = totalFrames(ir);
    const blockFrames = options.blockFrames ?? 8_192;
    for (let startFrame = 0; startFrame < frames; startFrame += blockFrames) {
      const frameCount = Math.min(blockFrames, frames - startFrame);
      analyzer.process(await readSelection(this.host, options, startFrame, frameCount, options.signal));
      options.onProgress?.((startFrame + frameCount) / Math.max(1, frames));
    }
    if (frames === 0) options.onProgress?.(1);
    return analyzer.finish();
  }

  public async analyzeBeats(options: AelionAudioAnalysisOptions = {}): Promise<BeatDetectionResult> {
    const ir = this.host.ir();
    const channels = channelCount(ir.channelLayout);
    const frames = totalFrames(ir);
    return detectBeats({
      sampleRate: ir.sampleRate,
      channelCount: channels,
      totalFrames: frames,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      readFrames: (startFrame, frameCount, signal) => readSelection(this.host, options, startFrame, frameCount, signal),
    });
  }

  /** @deprecated Audio-only input cannot detect video scenes; use analyzeAudioEnergyChanges. */
  public async analyzeScenes(options: AelionAudioAnalysisOptions = {}): Promise<AelionAudioSceneCompatibilityResult> {
    const result = await this.analyzeAudioEnergyChanges(options);
    return {
      sampleRate: result.sampleRate,
      totalFrames: result.totalFrames,
      scenes: result.changes,
    };
  }

  public async analyzeAudioEnergyChanges(
    options: AelionAudioAnalysisOptions = {},
  ): Promise<AudioEnergyChangeDetectionResult> {
    const ir = this.host.ir();
    const channels = channelCount(ir.channelLayout);
    const frames = totalFrames(ir);
    return detectAudioEnergyChanges({
      sampleRate: ir.sampleRate,
      channelCount: channels,
      totalFrames: frames,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      readFrames: (startFrame, frameCount, signal) => readSelection(this.host, options, startFrame, frameCount, signal),
    });
  }

  public waveform(options: AelionAudioWaveformOptions = {}): Promise<WaveformPeakResult> {
    const ir = this.host.ir();
    const channels = channelCount(ir.channelLayout);
    return buildWaveformPeaks({
      sampleRate: ir.sampleRate,
      channelCount: channels,
      totalFrames: totalFrames(ir),
      ...(options.windowFrames === undefined ? {} : { windowFrames: options.windowFrames }),
      ...(options.maxPoints === undefined ? {} : { maxPoints: options.maxPoints }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      readFrames: (startFrame, frameCount, signal) => readSelection(this.host, options, startFrame, frameCount, signal),
    });
  }

  public async detectSilence(options: AelionAudioRemoveSilenceOptions): Promise<SilenceDetectionResult> {
    const ir = this.host.ir();
    const project = this.host.project();
    const item = assertAudioItem(project, options.itemId);
    const channels = channelCount(ir.channelLayout);
    const itemStartFrame = sampleIndexAtTime(item.range.startUs, ir.sampleRate, 'floor');
    const itemEndFrame = sampleIndexAtTime(item.range.startUs + item.range.durationUs, ir.sampleRate, 'floor');
    return detectSilence({
      sampleRate: ir.sampleRate,
      channelCount: channels,
      totalFrames: itemEndFrame - itemStartFrame,
      ...(options.thresholdDb === undefined ? {} : { thresholdDb: options.thresholdDb }),
      ...(options.minimumSilenceUs === undefined ? {} : { minimumSilenceUs: options.minimumSilenceUs }),
      ...(options.paddingUs === undefined ? {} : { paddingUs: options.paddingUs }),
      ...(options.windowFrames === undefined ? {} : { windowFrames: options.windowFrames }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      readFrames: (startFrame, frameCount, signal) =>
        readSelection(this.host, { itemIds: [item.id] }, itemStartFrame + startFrame, frameCount, signal),
    });
  }

  public async removeSilence(options: AelionAudioRemoveSilenceOptions): Promise<AelionAudioRemoveSilenceResult> {
    const baseRevision = this.host.revision();
    const project = this.host.project();
    const ir = this.host.ir();
    const item = assertAudioItem(project, options.itemId);
    if (item.linkGroupId !== undefined) {
      throw new TypeError('Unlink an audio Item before removing silence');
    }
    if ((item.markerIds?.length ?? 0) > 0 || item.materialInstanceIds.length > 0) {
      throw new TypeError('Audio Item markers/effects require an explicit split ownership policy');
    }
    if (
      Object.values(project.transitions).some((value) => value.fromItemId === item.id || value.toItemId === item.id)
    ) {
      throw new TypeError('Remove transitions attached to an audio Item before removing silence');
    }
    if (item.source.timeMapping.type !== 'linear') {
      throw new TypeError('Silence removal currently requires a linear audio TimeMap');
    }
    const mapping = item.source.timeMapping;
    if (mapping.reverse || mapping.rate.numerator !== mapping.rate.denominator || mapping.boundary !== 'hold') {
      throw new TypeError('Silence removal requires forward 1x hold-boundary audio');
    }
    const track = project.tracks[item.trackId];
    if (track === undefined) throw new ReferenceError(`Unknown Track: ${item.trackId}`);
    const originalEndUs = item.range.startUs + item.range.durationUs;
    const overlapping = track.itemIds
      .filter((id) => id !== item.id)
      .flatMap((id) => {
        const candidate = project.items[id];
        if (candidate === undefined) return [];
        const endUs = candidate.range.startUs + candidate.range.durationUs;
        return candidate.range.startUs < originalEndUs && endUs > item.range.startUs ? [candidate.id] : [];
      });
    if (overlapping.length > 0) {
      throw new TypeError('Silence compaction requires a non-overlapping audio Item');
    }

    const detection = await this.detectSilence(options);
    if (this.host.revision() !== baseRevision) {
      throw new Error('Project revision changed while silence detection was running');
    }
    if (detection.removedFrames === 0) {
      throw new RangeError('No removable silence was detected');
    }
    const kept = detection.nonSilent;
    const nextItemId = track.itemIds[track.itemIds.indexOf(item.id) + 1];
    const createdIds: string[] = [];
    let cursorUs = item.range.startUs;
    const segmentValues = kept.map((range, index) => {
      const localStartUs = sampleBoundaryUs(range.startFrame, ir.sampleRate);
      const localEndUs = sampleBoundaryUs(range.startFrame + range.frameCount, ir.sampleRate);
      const durationUs = Math.max(1, localEndUs - localStartUs);
      const id = index === 0 ? item.id : `${item.id}_audible_${baseRevision.toString()}_${index.toString()}`;
      const value = structuredClone(item);
      value.id = id;
      value.range = { startUs: cursorUs, durationUs };
      value.source.sourceRange = {
        startUs: item.source.sourceRange.startUs + localStartUs,
        durationUs,
      };
      cursorUs += durationUs;
      return value;
    });
    const removedUs = item.range.durationUs - (cursorUs - item.range.startUs);
    const laterItems = track.itemIds.flatMap((id) => {
      const value = project.items[id];
      return value !== undefined && value.id !== item.id && value.range.startUs >= originalEndUs ? [value] : [];
    });
    const laterTransitions = Object.values(project.transitions).filter(
      (value) => value.trackId === track.id && value.range.startUs >= originalEndUs,
    );
    const commit = this.host.edit('Remove audio silence', (transaction) => {
      if (segmentValues.length === 0) {
        transaction.listRemove('tracks', track.id, ['itemIds'], item.id);
        transaction.deleteEntity('items', item.id);
      } else {
        const first = segmentValues[0];
        if (first === undefined) throw new Error('Missing first audible segment');
        transaction.setField('items', item.id, ['range'], first.range);
        transaction.setField('items', item.id, ['source', 'sourceRange'], first.source.sourceRange);
        for (const segment of segmentValues.slice(1)) {
          transaction.createEntity('items', segment.id, segment as unknown as JsonObject);
          transaction.listInsert('tracks', track.id, ['itemIds'], segment.id, nextItemId);
          createdIds.push(segment.id);
        }
      }
      for (const later of laterItems) {
        transaction.setField('items', later.id, ['range', 'startUs'], later.range.startUs - removedUs);
      }
      for (const transition of laterTransitions) {
        transaction.setField('transitions', transition.id, ['range', 'startUs'], transition.range.startUs - removedUs);
      }
    });
    return {
      commit,
      detection,
      itemIds: segmentValues.length === 0 ? [] : [item.id, ...createdIds],
      removedUs,
    };
  }
}

export function projectAudioMastering(
  project: Readonly<AelionProject>,
  sequenceId: string,
): AelionAudioMasteringOptions | undefined {
  return masteringFrom(project, sequenceId);
}
