import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AelionSession,
  createProject,
  defaultSchemas,
  installMigrationMaterials,
  RuntimeMaterialRegistry,
  seconds,
} from '@aelionsdk/sdk';
import { ProjectValidator } from '@aelionsdk/project-schema';
import { layoutIrText, type IrTextClip, type TextMeasureContext } from '@aelionsdk/render-ir';
import { computeFitScale, computeVisualParameters, fitModeCode } from '@aelionsdk/renderer-worker';
import { StreamingPcmResampler, TransferableAudioWorkletClock } from '@aelionsdk/audio';
import { FetchRangeReader } from '@aelionsdk/media';
import { decodeMaterialJson } from '@aelionsdk/material-sdk';
import { INVOKE_CHANNELS, IPC_CHANNELS } from '../shared/ipc';
import {
  annotationContext,
  botPins,
  markRefs,
  validateAnnotations,
  validMarkRefs,
} from '../shared/preview/preview-annotations';
import {
  VIDEO_ASPECT_DIMENSIONS,
  VIDEO_RUNTIME_ASSETS,
  VIDEO_RUNTIME_DIR,
  type VideoAspectPreset,
  type VideoAssetImportInput,
  type VideoAssetInfo,
  type VideoBeatMarker,
  type VideoClipCrop,
  type VideoClipEffect,
  type VideoClipFit,
  type VideoClipKind,
  type VideoClipStyle,
  type VideoClipSummary,
  type VideoClipTransitionRef,
  type VideoEditOperation,
  type VideoEditRequest,
  type VideoEditResult,
  type VideoEffectPreset,
  type VideoEngineState,
  type VideoExportFormat,
  type VideoExportJob,
  type VideoExportQuality,
  type VideoExportRequest,
  type VideoExportStatus,
  type VideoFilmstripFrame,
  type VideoKeyframe,
  type VideoKeyframeProperty,
  type VideoLoudnessSummary,
  type VideoMediaAnalyzeInput,
  type VideoMediaPosterInput,
  type VideoMediaPosterResult,
  type VideoMediaProbe,
  type VideoMediaSourceRef,
  type VideoProjectCreateInput,
  type VideoProjectDetail,
  type VideoProjectFrameInput,
  type VideoProjectFrameResult,
  type VideoProjectSummary,
  type VideoQuickEditAction,
  type VideoQuickEditRequest,
  type VideoQuickEditResult,
  type VideoSilenceSegment,
  type VideoSubtitleCue,
  type VideoTextBox,
  type VideoTextStyle,
  type VideoTrackKind,
  type VideoTrackSummary,
  type VideoTransitionPreset,
} from '../shared/types/video-studio-types';
import { AppError } from '../shared/errors';

test('inlined AelionSDK creates and validates a multi-track project in Ajv and CSP-safe structural modes', async () => {
  const builder = createProject({
    projectId: 'proj_smoke',
    title: 'Smoke Project',
    width: 1280,
    height: 720,
    frameRate: { numerator: 30, denominator: 1 },
    sampleRate: 48_000,
    skipAjvCompile: true,
  });
  const videoTrack = builder.addTrack({ id: 'track_v1', kind: 'visual', role: 'storyline', name: 'Main' });
  const textTrack = builder.addTrack({ id: 'track_t1', kind: 'visual', role: 'overlay', name: 'Titles' });
  builder.addShapeClip({
    id: 'clip_bg',
    trackId: videoTrack,
    atUs: 0,
    durationUs: seconds(2),
    kind: 'rectangle',
    box: { x: 0, y: 0, width: 1280, height: 720 },
    fill: '#1e293b',
  });
  builder.addTextClip({
    id: 'clip_title',
    trackId: textTrack,
    atUs: 0,
    durationUs: seconds(2),
    text: '你好 AelionBot 2.0',
    box: { x: 100, y: 540, width: 1080, height: 120 },
    style: { fontSizePx: 48, align: 'center', fill: '#ffffff' },
  });
  builder.addMarker({ id: 'marker_beat1', timeUs: 500_000, label: 'Beat 1' });
  const project = builder.build();

  const ajvValidator = new ProjectValidator({
    projectSchema: defaultSchemas.project,
    materialInstanceSchema: defaultSchemas.materialInstance,
    schemaMode: 'ajv',
  });
  assert.equal(ajvValidator.schemaValidationMode, 'ajv');
  assert.equal(ajvValidator.validate(project).ok, true);

  const structuralValidator = new ProjectValidator({
    projectSchema: defaultSchemas.project,
    materialInstanceSchema: defaultSchemas.materialInstance,
    skipAjvCompile: true,
  });
  assert.equal(structuralValidator.schemaValidationMode, 'structural');
  assert.equal(structuralValidator.validate(project).ok, true);

  // Structural + semantic mode must still reject invalid documents without throwing uncaught errors.
  assert.equal(structuralValidator.validate({ schemaVersion: '2.0.0' }).ok, false);
  const badDimProject = structuredClone(project);
  badDimProject.sequences[badDimProject.settings.defaultSequenceId]!.format.width = 0;
  assert.equal(structuralValidator.validate(badDimProject).ok, false);

  // Security regressions: schema version spoofing, prototype keys, invalid entity IDs, missing arrays.
  const spoofedSchema = structuredClone(project) as Record<string, unknown>;
  spoofedSchema.$schema = 'https://evil.example/v99.json';
  spoofedSchema.schemaVersion = '99.0.0';
  assert.equal(structuralValidator.validate(spoofedSchema).ok, false);

  const protoKeyProject = structuredClone(project);
  Object.defineProperty(protoKeyProject.assets, '__proto__', {
    value: { id: '__proto__', kind: 'video' },
    enumerable: true,
    configurable: true,
  });
  assert.equal(structuralValidator.validate(protoKeyProject).ok, false);

  const ctorKeyProject = structuredClone(project);
  Object.defineProperty(ctorKeyProject.assets, 'constructor', {
    value: { id: 'constructor', kind: 'video' },
    enumerable: true,
    configurable: true,
  });
  assert.equal(structuralValidator.validate(ctorKeyProject).ok, false);

  const badIdProject = structuredClone(project);
  (badIdProject.assets as Record<string, unknown>)['123invalid'] = { id: '123invalid', kind: 'video' };
  assert.equal(structuralValidator.validate(badIdProject).ok, false);

  const missingTransitionIds = structuredClone(project);
  delete (missingTransitionIds.sequences[missingTransitionIds.settings.defaultSequenceId] as Record<string, unknown>)
    .transitionIds;
  const missingTransitionRes = structuralValidator.validate(missingTransitionIds);
  assert.equal(missingTransitionRes.ok, false);
  assert.equal(missingTransitionRes.diagnostics[0]?.code, 'PROJECT_SCHEMA_INVALID');

  const badSampleRate = structuredClone(project);
  (badSampleRate.sequences[badSampleRate.settings.defaultSequenceId]!.format as Record<string, unknown>).sampleRate =
    22_050;
  assert.equal(structuralValidator.validate(badSampleRate).ok, false);

  const badWidthRange = structuredClone(project);
  badWidthRange.sequences[badWidthRange.settings.defaultSequenceId]!.format.width = 70_000;
  assert.equal(structuralValidator.validate(badWidthRange).ok, false);

  const badChannelLayout = structuredClone(project);
  (
    badChannelLayout.sequences[badChannelLayout.settings.defaultSequenceId]!.format as Record<string, unknown>
  ).channelLayout = '7.1';
  assert.equal(structuralValidator.validate(badChannelLayout).ok, false);

  const badMarkerOwner = structuredClone(project);
  delete (badMarkerOwner.markers.marker_beat1 as Record<string, unknown>).owner;
  const badMarkerOwnerRes = structuralValidator.validate(badMarkerOwner);
  assert.equal(badMarkerOwnerRes.ok, false);
  assert.equal(badMarkerOwnerRes.diagnostics[0]?.code, 'PROJECT_SCHEMA_INVALID');

  const badMarkerTime = structuredClone(project);
  badMarkerTime.markers.marker_beat1!.timeUs = -1;
  assert.equal(structuralValidator.validate(badMarkerTime).ok, false);

  const badMarkerDuration = structuredClone(project);
  badMarkerDuration.markers.marker_beat1!.durationUs = -5;
  assert.equal(structuralValidator.validate(badMarkerDuration).ok, false);

  // Session with skipAjvCompile loads and compiles Render IR cleanly.
  const registry = new RuntimeMaterialRegistry();
  installMigrationMaterials(registry);
  const session = new AelionSession({ skipAjvCompile: true, materials: registry });
  await session.loadProject(project);
  assert.equal(session.state, 'ready');
  assert.equal(session.requireIr().durationUs, seconds(2));
  await session.dispose();
});

test('material-sdk schema validation loads lazily without crashing on import and decodes JSON safely', () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ ok: true }));
  assert.deepEqual(decodeMaterialJson(bytes), { ok: true });
});

test('renderer-worker visualParameters preserves cover/fill fit modes and non-uniform scale', () => {
  const baseVisual = {
    fit: 'cover',
    transform: {
      positionPx: { x: 640, y: 360 },
      anchor: { x: 0.5, y: 0.5 },
      scale: { x: 1.5, y: 0.75 },
      rotationDeg: 15,
      skewDeg: { x: 0, y: 0 },
    },
    crop: { left: 0.05, top: 0, right: 0.05, bottom: 0 },
    opacity: 0.9,
    blendMode: 'normal',
  };
  const coverParams = computeVisualParameters(baseVisual, 1280, 720, 640, 360, 0, 0);
  assert.equal(coverParams.fitMode, fitModeCode('cover'));
  assert.equal(coverParams.scaleX, 1.5);
  assert.equal(coverParams.scaleY, 0.75);
  assert.equal(coverParams.positionX, 320);
  assert.equal(coverParams.positionY, 180);

  const fillParams = computeVisualParameters({ ...baseVisual, fit: 'fill' }, 1280, 720, 1280, 720, 0, 0);
  assert.equal(fillParams.fitMode, fitModeCode('fill'));
  assert.equal(fillParams.scaleX, 1.5);
  assert.equal(fillParams.scaleY, 0.75);

  // 16:9 source inside 9:16 destination: cover expands X to crop sides, contain shrinks Y to letterbox.
  const [coverX, coverY] = computeFitScale(1920, 1080, 1080, 1920, 'cover');
  assert.ok(coverX > 3.1 && coverX < 3.2, `expected coverX ~3.16, got ${coverX}`);
  assert.equal(coverY, 1);

  const [containX, containY] = computeFitScale(1920, 1080, 1080, 1920, 'contain');
  assert.equal(containX, 1);
  assert.ok(containY > 0.31 && containY < 0.32, `expected containY ~0.316, got ${containY}`);

  const [fillX, fillY] = computeFitScale(1920, 1080, 1080, 1920, 'fill');
  assert.deepEqual([fillX, fillY], [1, 1]);

  const [noneX, noneY] = computeFitScale(640, 360, 1280, 720, 'none');
  assert.deepEqual([noneX, noneY], [0.5, 0.5]);

  // Guard against NaN / non-positive dimensions and preserve projectWidth/projectHeight for renderScale invariance.
  const [safeNanX, safeNanY] = computeFitScale(Number.NaN, -10, 0, Number.POSITIVE_INFINITY, 'cover');
  assert.ok(Number.isFinite(safeNanX) && Number.isFinite(safeNanY));
  assert.deepEqual([safeNanX, safeNanY], [1, 1]);

  const halfScaleNone = computeVisualParameters({ ...baseVisual, fit: 'none' }, 1280, 720, 640, 360, 0, 0);
  assert.equal(halfScaleNone.fitMode, fitModeCode('none'));
  assert.equal(halfScaleNone.projectWidth, 1280);
  assert.equal(halfScaleNone.projectHeight, 720);
  assert.equal(halfScaleNone.outputWidth, 640);
  assert.equal(halfScaleNone.outputHeight, 360);

  const zeroProjectSafe = computeVisualParameters(baseVisual, 0, -100, 640, 360, 0, 0);
  assert.ok(Number.isFinite(zeroProjectSafe.positionX) && Number.isFinite(zeroProjectSafe.positionY));
  assert.equal(zeroProjectSafe.projectWidth, 1);
  assert.equal(zeroProjectSafe.projectHeight, 1);
});

test('render-ir text layout supports canvas measureText for mixed CJK/Latin and falls back cleanly in Node', () => {
  const clip: IrTextClip = {
    id: 't1',
    trackId: 'tr1',
    kind: 'text-clip',
    role: 'caption',
    range: { startUs: 0, durationUs: 2_000_000 },
    enabled: true,
    materialInstanceIds: [],
    dependencyEntityIds: [],
    fingerprint: 'fp1',
    box: { x: 40, y: 500, width: 200, height: 180 },
    overflow: 'clip',
    writingMode: 'horizontal-tb',
    paragraphs: [
      {
        style: { align: 'center', fontSizePx: 24, lineHeightPx: 30 },
        runs: [{ text: '你好世界 Hello World 超长不间断单词ABCDEFGHIJKLMNOP', style: {} }],
      },
    ],
    visual: {
      fit: 'contain',
      transform: {
        positionPx: { x: 640, y: 360 },
        anchor: { x: 0.5, y: 0.5 },
        scale: { x: 1, y: 1 },
        rotationDeg: 0,
        skewDeg: { x: 0, y: 0 },
      },
      crop: {},
      opacity: 1,
      blendMode: 'normal',
    },
  };

  // In Node (without OffscreenCanvas), auto falls back cleanly to portable metrics.
  const portable = layoutIrText(clip);
  assert.equal(portable.metricsId, 'aelion-portable-text-metrics/1');
  assert.ok(portable.lines.length >= 3);
  for (const line of portable.lines) {
    assert.ok(line.width <= clip.box.width + 0.01, `line width ${line.width} exceeded box ${clip.box.width}`);
  }

  // With a canvas-style measureText context (CJK = 1.0em, Latin = 0.52em, narrow = 0.28em), uses canvas metrics.
  const mockCanvasMeasure: TextMeasureContext = {
    measureText(value, style) {
      let total = 0;
      for (const ch of value) {
        const cp = ch.codePointAt(0) ?? 0;
        total +=
          cp >= 0x2e80
            ? style.fontSizePx * 1.0
            : /[ilI ]/u.test(ch)
              ? style.fontSizePx * 0.28
              : style.fontSizePx * 0.52;
      }
      return total;
    },
  };
  const measured = layoutIrText(clip, { measure: mockCanvasMeasure });
  assert.equal(measured.metricsId, 'aelion-canvas-text-metrics/1');
  assert.ok(measured.lines.length >= 2);
  for (const line of measured.lines) {
    assert.ok(line.width <= clip.box.width + 0.01, `measured line ${line.width} exceeded box ${clip.box.width}`);
  }

  // Regression: CJK immediately followed by Latin ('你好Hello') must break cleanly between '好' and 'Hello'.
  const cjkLatinClip: IrTextClip = {
    ...clip,
    box: { x: 0, y: 0, width: 60, height: 100 },
    paragraphs: [
      {
        style: { align: 'start', fontSizePx: 20, lineHeightPx: 24 },
        runs: [{ text: '你好Hello', style: {} }],
      },
    ],
  };
  const cjkLatinMeasure: TextMeasureContext = {
    measureText(value, style) {
      let total = 0;
      for (const ch of value) {
        total += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? style.fontSizePx : style.fontSizePx * 0.5;
      }
      return total;
    },
  };
  const cjkLatinLayout = layoutIrText(cjkLatinClip, { measure: cjkLatinMeasure });
  assert.deepEqual(
    cjkLatinLayout.lines.map((line) => line.spans.map((span) => span.text).join('')),
    ['你好', 'Hello'],
  );
});

test('audio StreamingPcmResampler adapts 48kHz project audio to 44.1kHz hardware output accurately', () => {
  const inputRate = 48_000;
  const outputRate = 44_100;
  const channels = 2;
  const durationSec = 0.5;
  const inputFrames = Math.round(inputRate * durationSec);
  const input = new Float32Array(inputFrames * channels);
  for (let i = 0; i < inputFrames; i++) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / inputRate) * 0.5;
    input[i * 2] = sample;
    input[i * 2 + 1] = sample;
  }
  const resampler = new StreamingPcmResampler({
    inputSampleRate: inputRate,
    outputSampleRate: outputRate,
    channelCount: channels,
  });
  let totalOutputFrames = 0;
  let peak = 0;
  const chunkFrames = 4_096;
  for (let offset = 0; offset < inputFrames; offset += chunkFrames) {
    const end = Math.min(inputFrames, offset + chunkFrames);
    const chunk = input.subarray(offset * channels, end * channels);
    const out = resampler.push(chunk, end >= inputFrames);
    totalOutputFrames += out.length / channels;
    for (let j = 0; j < out.length; j++) {
      assert.ok(Number.isFinite(out[j]));
      peak = Math.max(peak, Math.abs(out[j]!));
    }
  }
  assert.equal(totalOutputFrames, Math.round(outputRate * durationSec));
  assert.ok(peak > 0.45 && peak <= 0.51, `unexpected resampled peak ${peak}`);

  // Regression: TransferableAudioWorkletClock sanitizes zero/NaN context.sampleRate safely.
  const fakeContext = {
    sampleRate: 0,
    state: 'suspended',
    currentTime: 0,
    addEventListener() {},
    removeEventListener() {},
    close: async () => undefined,
  } as unknown as AudioContext;
  const clock = new TransferableAudioWorkletClock({
    context: fakeContext,
    sampleRate: 48_000,
    channelCount: 2,
  });
  assert.equal(clock.queue.channelCount, 2);
  assert.equal(clock.queue.capacityFrames, 48_000 * 4);
});

test('shared Video Studio IPC channels, DTO contracts, and timecoded annotations work cleanly', () => {
  const videoMethods = [
    'videoProjectsList',
    'videoProjectGet',
    'videoProjectCreate',
    'videoProjectDelete',
    'videoAssetImport',
    'videoProjectEdit',
    'videoProjectExport',
    'videoExportStatus',
    'videoExportCancel',
    'videoMediaAnalyze',
    'videoQuickEdit',
    'videoProjectFrame',
    'videoMediaPoster',
  ] as const;

  const channels = new Set<string>();
  for (const method of videoMethods) {
    const channel = INVOKE_CHANNELS[method];
    assert.equal(typeof channel, 'string');
    assert.ok(channel.startsWith('video:'));
    assert.equal(IPC_CHANNELS[method], channel);
    channels.add(channel);
  }
  assert.equal(channels.size, videoMethods.length);

  assert.deepEqual(VIDEO_ASPECT_DIMENSIONS['16:9'], { width: 1920, height: 1080 });
  assert.deepEqual(VIDEO_ASPECT_DIMENSIONS['9:16'], { width: 1080, height: 1920 });

  // Verify every shared Video Studio contract type compiles cleanly and holds realistic payloads.
  const aspect: VideoAspectPreset = '16:9';
  const transitionPreset: VideoTransitionPreset = 'cross-dissolve';
  const effectPreset: VideoEffectPreset = 'warm-film';
  const exportFormat: VideoExportFormat = 'mp4';
  const exportQuality: VideoExportQuality = 'standard';
  const exportStatus: VideoExportStatus = 'completed';
  const clipFit: VideoClipFit = 'cover';
  const trackKind: VideoTrackKind = 'visual';
  const clipKind: VideoClipKind = 'video';
  const keyframeProp: VideoKeyframeProperty = 'opacity';
  const crop: VideoClipCrop = { left: 0, right: 0 };
  const style: VideoClipStyle = { fit: clipFit, opacity: 1, crop };
  const textBox: VideoTextBox = { x: 80, y: 900, width: 1760, height: 120 };
  const textStyle: VideoTextStyle = { fontSizePx: 44, align: 'center', fill: '#ffffff' };
  const effect: VideoClipEffect = { id: 'fx1', preset: effectPreset, intensity: 0.7 };
  const keyframe: VideoKeyframe = { timeUs: 0, value: 1, interpolation: 'linear' };
  const transitionRef: VideoClipTransitionRef = { id: 'tr1', preset: transitionPreset, durationUs: 500_000 };
  const clipSummary: VideoClipSummary = {
    id: 'c1',
    trackId: 't1',
    kind: clipKind,
    startUs: 0,
    durationUs: 2_000_000,
    enabled: true,
    style,
    textBox,
    textStyle,
    effects: [effect],
    transitionOut: transitionRef,
  };
  const trackSummary: VideoTrackSummary = {
    id: 't1',
    kind: trackKind,
    name: 'Main',
    enabled: true,
    locked: false,
    clips: [clipSummary],
  };
  const assetInfo: VideoAssetInfo = { id: 'a1', kind: 'video', name: 'clip.mp4', durationUs: 2_000_000 };
  const exportJob: VideoExportJob = {
    id: 'job1',
    projectId: 'p1',
    status: exportStatus,
    format: exportFormat,
    quality: exportQuality,
    progress: 1,
    stage: 'done',
    startedAt: '2026-11-26T00:00:00Z',
  };
  const summary: VideoProjectSummary = {
    id: 'p1',
    title: 'Demo',
    aspect,
    width: 1920,
    height: 1080,
    fps: 30,
    sampleRate: 48_000,
    durationUs: 2_000_000,
    revision: '1',
    trackCount: 1,
    clipCount: 1,
    assetCount: 1,
    createdAt: '2026-11-26T00:00:00Z',
    updatedAt: '2026-11-26T00:00:00Z',
  };
  const detail: VideoProjectDetail = {
    ...summary,
    sequenceId: 'seq1',
    canUndo: false,
    canRedo: false,
    tracks: [trackSummary],
    assets: [assetInfo],
    projectJson: {},
    assetUrls: {},
    recentExports: [exportJob],
  };
  const createInput: VideoProjectCreateInput = { title: 'Demo', aspect };
  const importInput: VideoAssetImportInput = { projectId: 'p1', source: { kind: 'host', path: '/tmp/a.mp4' } };
  const subtitleCue: VideoSubtitleCue = { startUs: 0, endUs: 1_000_000, text: '你好' };
  const ops: VideoEditOperation[] = [
    { op: 'add_clip', assetId: 'a1', startUs: 0, durationUs: 2_000_000 },
    { op: 'set_keyframes', clipId: 'c1', property: keyframeProp, keyframes: [keyframe] },
    { op: 'import_subtitles', format: 'cues', cues: [subtitleCue] },
    { op: 'undo' },
  ];
  const editReq: VideoEditRequest = { projectId: 'p1', operations: ops };
  const editRes: VideoEditResult = { project: detail, revision: '2', applied: ops.length };
  const exportReq: VideoExportRequest = { projectId: 'p1', format: exportFormat, quality: exportQuality };
  const sourceRef: VideoMediaSourceRef = { kind: 'host', path: '/tmp/a.mp4' };
  const analyzeInput: VideoMediaAnalyzeInput = { source: sourceRef, includeFilmstrip: true };
  const silence: VideoSilenceSegment = { startUs: 0, endUs: 500_000, durationUs: 500_000 };
  const beat: VideoBeatMarker = { timeUs: 500_000, strength: 0.9 };
  const loudness: VideoLoudnessSummary = { integratedLufs: -16, truePeakDbtp: -1 };
  const frame: VideoFilmstripFrame = { timeUs: 0, dataUrl: 'data:image/png;base64,', width: 160, height: 90 };
  const probe: VideoMediaProbe = {
    durationUs: 2_000_000,
    hasAudio: true,
    filmstrip: [frame],
    silences: [silence],
    beats: [beat],
    loudness,
  };
  const posterInput: VideoMediaPosterInput = { source: sourceRef, timeSec: 0 };
  const posterRes: VideoMediaPosterResult = { posterDataUrl: frame.dataUrl, durationSec: 2 };
  const quickAction: VideoQuickEditAction = { action: 'capture_frame', timeSec: 1 };
  const quickReq: VideoQuickEditRequest = { source: sourceRef, edit: quickAction };
  const quickRes: VideoQuickEditResult = { action: 'capture_frame', posterDataUrl: frame.dataUrl };
  const frameReq: VideoProjectFrameInput = { projectId: 'p1', timestampsUs: [0] };
  const frameRes: VideoProjectFrameResult = { projectId: 'p1', revision: '2', frames: [frame] };
  const engineState: VideoEngineState = {
    ready: true,
    supportedExportFormats: ['mp4', 'webm', 'wav', 'gif', 'png'],
    codecs: { h264: true, vp9: true, av1: false, hevc: false, aac: true, opus: true },
    activeExports: [],
    projectCount: 1,
  };
  assert.equal(editReq.projectId, editRes.project.id);
  assert.equal(createInput.title, detail.title);
  assert.equal(importInput.projectId, exportReq.projectId);
  assert.equal(analyzeInput.includeFilmstrip, true);
  assert.equal(probe.hasAudio, true);
  assert.equal(posterInput.timeSec, 0);
  assert.equal(posterRes.durationSec, 2);
  assert.equal(quickReq.edit.action, quickRes.action);
  assert.equal(frameReq.projectId, frameRes.projectId);
  assert.equal(engineState.ready, true);

  // Timecoded preview annotations round-trip and format into annotationContext
  const validated = validateAnnotations([
    {
      id: 'v1',
      type: 'rect',
      x: 0.2,
      y: 0.3,
      w: 0.4,
      h: 0.2,
      color: '#8b6bea',
      text: '字幕再靠上一点',
      timestampSec: 12.5,
    },
    { id: 'img1', type: 'rect', x: 0.1, y: 0.1, color: '#29282c', text: '普通图片标注' },
  ]);
  assert.equal(validated[0]?.timestampSec, 12.5);
  assert.equal('timestampSec' in validated[1]!, false);

  const refs = markRefs(validated);
  assert.equal(refs[0]?.timestampSec, 12.5);
  assert.equal('timestampSec' in refs[1]!, false);
  assert.deepEqual(validMarkRefs(refs), refs);

  const ctxZh = annotationContext(validated, { en: false });
  assert.ok(ctxZh.includes('时间点 00:12.5'));
  const ctxEn = annotationContext(validated, { en: true });
  assert.ok(ctxEn.includes('time 00:12.5'));

  const pinned = botPins([{ box: [0.1, 0.2, 0.3, 0.4], note: '转场衔接处', timestampSec: 65.2 }]);
  assert.equal(pinned[0]?.timestampSec, 65.2);

  assert.throws(
    () => validateAnnotations([{ id: 'bad', type: 'rect', x: 0.1, y: 0.1, color: '#29282c', timestampSec: -1 }]),
    (err: unknown) => err instanceof AppError && err.code === 'preview.annotation_invalid',
  );
  assert.throws(
    () => validMarkRefs([{ id: 'bad', n: 1, title: '区域', timestampSec: Number.NaN }]),
    (err: unknown) => err instanceof AppError && err.code === 'preview.annotation_invalid',
  );
  assert.throws(
    () => botPins([{ box: [0.1, 0.2, 0.3, 0.4], note: 'bad', timestampSec: -5 }]),
    (err: unknown) => err instanceof AppError && err.code === 'preview.mark_invalid',
  );
});

test('FetchRangeReader invokes fetch detached so Chromium Window brand check never throws Illegal invocation', async () => {
  const payload = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
  function brandCheckedFetch(this: unknown, _input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    if (init?.method === 'HEAD') {
      return Promise.resolve(
        new Response(null, { status: 200, headers: { 'content-length': String(payload.byteLength) } }),
      );
    }
    return Promise.resolve(
      new Response(payload.subarray(0, 4), {
        status: 206,
        headers: { 'content-range': `bytes 0-3/${payload.byteLength}` },
      }),
    );
  }

  // Explicit options.fetch (simulates passing window.fetch)
  const explicitReader = new FetchRangeReader('a1', 'aelion-video://asset/p1/a1', {
    fetch: brandCheckedFetch as typeof globalThis.fetch,
    maxRetries: 0,
  });
  assert.equal(await explicitReader.size(), payload.byteLength);
  const chunk = await explicitReader.read({ offset: 0, length: 4 });
  assert.deepEqual([...chunk.bytes], [0, 1, 2, 3]);

  // Default globalThis.fetch path
  const originalFetch = globalThis.fetch;
  globalThis.fetch = brandCheckedFetch as typeof globalThis.fetch;
  try {
    const defaultReader = new FetchRangeReader('a2', 'aelion-video://asset/p1/a2', { maxRetries: 0 });
    assert.equal(await defaultReader.size(), payload.byteLength);
    const chunk2 = await defaultReader.read({ offset: 0, length: 4 });
    assert.deepEqual([...chunk2.bytes], [0, 1, 2, 3]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('bundled video runtime workers exist in dist/video-runtime after build', () => {
  const dir = resolve(process.cwd(), 'dist', VIDEO_RUNTIME_DIR);
  if (!existsSync(dir)) return;
  for (const filename of Object.values(VIDEO_RUNTIME_ASSETS)) {
    const full = resolve(dir, filename);
    assert.ok(existsSync(full), `missing worker bundle: ${full}`);
    assert.ok(statSync(full).size > 200, `worker bundle unexpectedly empty: ${full}`);
  }
});
