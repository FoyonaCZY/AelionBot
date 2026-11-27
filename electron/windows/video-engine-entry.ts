// Browser entry running inside the hidden sandboxed Chromium video engine (aelion-video://engine/index.html).
// Executes AelionSDK media analysis, WebGL2 frame rendering, contact-sheet composition, and WebCodecs streaming export.
import { buildWaveformPeaks, detectBeats, detectSilence, StreamingLoudnessAnalyzer } from '@aelionsdk/audio';
import { probeCapabilities } from '@aelionsdk/capability';
import type { JsonObject } from '@aelionsdk/core';
import type { AelionProject } from '@aelionsdk/project-schema';
import {
  Aelion,
  ProductionMediaProvider,
  RuntimeMaterialRegistry,
  type AelionProfileExportOptions,
  type AelionRuntimeAssets,
} from '@aelionsdk/sdk';
import type { StreamTargetChunk } from 'mediabunny';
import {
  VIDEO_RUNTIME_ASSETS,
  VIDEO_RUNTIME_DIR,
  type VideoBeatMarker,
  type VideoExportFormat,
  type VideoExportQuality,
  type VideoFilmstripFrame,
  type VideoMediaProbe,
  type VideoSilenceSegment,
} from '../../shared/types/video-studio-types';
import { registerBuiltinVideoMaterials } from '../core/video/video-presets';
import type { VideoEngineBridge, VideoEngineRpcRequest } from './video-engine-preload';

declare global {
  interface Window {
    videoEngineBridge?: VideoEngineBridge;
  }
}

export interface EngineAssetRef {
  url: string;
  kind: 'video' | 'audio' | 'image' | 'font' | 'image-sequence';
  mime?: string;
}

export interface EngineAnalyzeMediaPayload {
  url: string;
  mimeType?: string;
  byteLength?: number;
  includeFilmstrip?: boolean;
  filmstripCount?: number;
  includeWaveform?: boolean;
  waveformPoints?: number;
  detectSilence?: boolean;
  detectBeats?: boolean;
  measureLoudness?: boolean;
  posterTimeSec?: number;
  maxPosterWidth?: number;
}

export interface EngineRenderFramesPayload {
  projectJson: AelionProject;
  assets: Record<string, EngineAssetRef>;
  timestampsUs: number[];
  maxWidth?: number;
  contactSheet?: boolean;
}

export interface EngineRenderFramesResult {
  frames: VideoFilmstripFrame[];
  contactSheetPng?: Uint8Array;
  contactSheetWidth?: number;
  contactSheetHeight?: number;
}

export interface EngineExportPayload {
  jobId: string;
  projectJson: AelionProject;
  assets: Record<string, EngineAssetRef>;
  format: VideoExportFormat;
  quality: VideoExportQuality;
  timeUs?: number;
  fps?: number;
  width?: number;
  height?: number;
}

export interface EngineExportResult {
  negotiatedFormat: VideoExportFormat;
  negotiatedCodec: string;
  bytesWritten: number;
}

export interface EngineCapabilitiesResult {
  supportedExportFormats: VideoExportFormat[];
  codecs: {
    h264: boolean;
    vp9: boolean;
    av1: boolean;
    hevc: boolean;
    aac: boolean;
    opus: boolean;
  };
}

const RUNTIME_ASSETS: AelionRuntimeAssets = {
  rendererWorker: new URL(`/${VIDEO_RUNTIME_DIR}/${VIDEO_RUNTIME_ASSETS.rendererWorker}`, location.href).href,
  exportWorker: new URL(`/${VIDEO_RUNTIME_DIR}/${VIDEO_RUNTIME_ASSETS.exportWorker}`, location.href).href,
  sharedAudioWorklet: new URL(`/${VIDEO_RUNTIME_DIR}/${VIDEO_RUNTIME_ASSETS.sharedAudioWorklet}`, location.href).href,
  transferableAudioWorklet: new URL(
    `/${VIDEO_RUNTIME_DIR}/${VIDEO_RUNTIME_ASSETS.transferableAudioWorklet}`,
    location.href,
  ).href,
};

const materialRegistry = new RuntimeMaterialRegistry();
registerBuiltinVideoMaterials(materialRegistry);

const activeExportAborts = new Map<string, AbortController>();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function bitmapToPngBytes(
  source: ImageBitmap | VideoFrame | OffscreenCanvas,
  maxWidth?: number,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const srcW =
    source instanceof VideoFrame ? source.displayWidth : source instanceof ImageBitmap ? source.width : source.width;
  const srcH =
    source instanceof VideoFrame ? source.displayHeight : source instanceof ImageBitmap ? source.height : source.height;
  const scale = maxWidth && srcW > maxWidth ? maxWidth / srcW : 1;
  const width = Math.max(2, Math.round(srcW * scale));
  const height = Math.max(2, Math.round(srcH * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
  ctx.drawImage(source, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, width, height };
}

function formatTimeBadge(timeUs: number): string {
  const sec = Math.max(0, timeUs / 1_000_000);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

async function buildContactSheet(
  frames: Array<{ timeUs: number; bitmap: ImageBitmap | VideoFrame; width: number; height: number }>,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const count = frames.length;
  const cols = count === 1 ? 1 : count <= 4 ? 2 : 3;
  const rows = Math.ceil(count / cols);
  const cellW = frames[0]!.width;
  const cellH = frames[0]!.height;
  const pad = 8;
  const totalW = cols * cellW + (cols + 1) * pad;
  const totalH = rows * cellH + (rows + 1) * pad;
  const canvas = new OffscreenCanvas(totalW, totalH);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');

  ctx.fillStyle = '#111318';
  ctx.fillRect(0, 0, totalW, totalH);

  const fontSize = Math.max(12, Math.min(20, Math.round(cellH * 0.06)));
  ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;

  frames.forEach((frame, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = pad + col * (cellW + pad);
    const y = pad + row * (cellH + pad);
    ctx.drawImage(frame.bitmap, x, y, cellW, cellH);

    const label = `#${index + 1}  ${formatTimeBadge(frame.timeUs)}`;
    const metrics = ctx.measureText(label);
    const badgeW = Math.ceil(metrics.width) + 16;
    const badgeH = fontSize + 10;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.fillRect(x + 6, y + 6, badgeW, badgeH);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 14, y + 6 + badgeH / 2);
  });

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, width: totalW, height: totalH };
}

function registerProjectAssets(provider: ProductionMediaProvider, assets: Record<string, EngineAssetRef>): void {
  for (const [assetId, info] of Object.entries(assets)) {
    if (info.kind === 'font' || info.kind === 'image-sequence') continue;
    provider.registerUrl(assetId, info.url, {
      kind: info.kind === 'image' ? 'image' : 'media',
      ...(info.mime ? { mimeType: info.mime } : {}),
    });
  }
}

async function handleCapabilities(): Promise<EngineCapabilitiesResult> {
  const report = await probeCapabilities();
  const videoEnc = new Set(
    report.codecs.filter((c) => c.kind === 'video-encoder' && c.supported).map((c) => c.codec.toLowerCase()),
  );
  const audioEnc = new Set(
    report.codecs.filter((c) => c.kind === 'audio-encoder' && c.supported).map((c) => c.codec.toLowerCase()),
  );
  const hasAny = (set: Set<string>, prefixes: string[]) =>
    [...set].some((codec) => prefixes.some((p) => codec.startsWith(p)));

  const h264 = hasAny(videoEnc, ['avc1', 'h264']);
  const vp9 = hasAny(videoEnc, ['vp09', 'vp9']);
  const av1 = hasAny(videoEnc, ['av01', 'av1']);
  const hevc = hasAny(videoEnc, ['hvc1', 'hev1', 'hevc']);
  const aac = hasAny(audioEnc, ['mp4a', 'aac']);
  const opus = hasAny(audioEnc, ['opus']);

  const supportedExportFormats: VideoExportFormat[] = ['wav', 'gif', 'png'];
  if (h264 || vp9) supportedExportFormats.unshift('mp4');
  if (vp9) supportedExportFormats.splice(supportedExportFormats.includes('mp4') ? 1 : 0, 0, 'webm');

  return {
    supportedExportFormats,
    codecs: { h264, vp9, av1, hevc, aac, opus },
  };
}

async function analyzeAudioFallback(url: string, payload: EngineAnalyzeMediaPayload): Promise<VideoMediaProbe> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch media for audio fallback: ${resp.status}`);
  const arr = await resp.arrayBuffer();
  const ctx = new OfflineAudioContext(2, 1, 48_000);
  const decoded = await ctx.decodeAudioData(arr);
  const sampleRate = decoded.sampleRate;
  const channels = decoded.numberOfChannels;
  const totalFrames = decoded.length;
  const durationUs = Math.max(1, Math.round((totalFrames / sampleRate) * 1_000_000));
  const interleaved = new Float32Array(totalFrames * channels);
  for (let ch = 0; ch < channels; ch += 1) {
    const channelData = decoded.getChannelData(ch);
    for (let f = 0; f < totalFrames; f += 1) {
      interleaved[f * channels + ch] = channelData[f] ?? 0;
    }
  }
  const readFrames = async (startFrame: number, frameCount: number): Promise<Float32Array> => {
    const out = new Float32Array(frameCount * channels);
    const start = startFrame * channels;
    const end = Math.min(interleaved.length, start + out.length);
    if (start < end) out.set(interleaved.subarray(start, end), 0);
    return out;
  };
  const extras = await runAudioAnalysis(sampleRate, channels, totalFrames, readFrames, payload);
  return {
    mimeType: payload.mimeType,
    byteLength: payload.byteLength ?? arr.byteLength,
    durationUs,
    hasVideo: false,
    hasAudio: true,
    sampleRate,
    channels,
    ...extras,
  };
}

async function runAudioAnalysis(
  sampleRate: number,
  channelCount: number,
  totalFrames: number,
  readFrames: (startFrame: number, frameCount: number, signal?: AbortSignal) => Promise<Float32Array>,
  payload: EngineAnalyzeMediaPayload,
): Promise<Pick<VideoMediaProbe, 'waveform' | 'silences' | 'beats' | 'loudness'>> {
  const result: Pick<VideoMediaProbe, 'waveform' | 'silences' | 'beats' | 'loudness'> = {};
  if (totalFrames <= 0) return result;

  if (payload.includeWaveform) {
    const maxPoints = Math.min(2000, Math.max(16, payload.waveformPoints ?? 120));
    const windowFrames = Math.max(1, Math.ceil(totalFrames / maxPoints));
    const wf = await buildWaveformPeaks({
      sampleRate,
      channelCount,
      totalFrames,
      windowFrames,
      maxPoints,
      readFrames,
    });
    result.waveform = wf.peaks.map((peak) => {
      let maxAbs = 0;
      for (let i = 0; i < peak.max.length; i += 1) {
        maxAbs = Math.max(maxAbs, Math.abs(peak.max[i] ?? 0), Math.abs(peak.min[i] ?? 0));
      }
      return Number(Math.min(1, maxAbs).toFixed(4));
    });
  }

  if (payload.detectSilence) {
    const sil = await detectSilence({
      sampleRate,
      channelCount,
      totalFrames,
      thresholdDb: -42,
      minimumSilenceUs: 250_000,
      paddingUs: 20_000,
      readFrames,
    });
    result.silences = sil.silent.map((seg): VideoSilenceSegment => {
      const startUs = Math.round((seg.startFrame / sampleRate) * 1_000_000);
      const endUs = Math.round(((seg.startFrame + seg.frameCount) / sampleRate) * 1_000_000);
      return { startUs, endUs, durationUs: Math.max(0, endUs - startUs) };
    });
  }

  if (payload.detectBeats) {
    const beatsRes = await detectBeats({
      sampleRate,
      channelCount,
      totalFrames,
      readFrames,
    });
    result.beats = beatsRes.beats.map((b): VideoBeatMarker => ({
      timeUs: Math.round((b.frame / sampleRate) * 1_000_000),
      strength: Number(b.strength.toFixed(3)),
    }));
  }

  if (payload.measureLoudness) {
    const analyzer = new StreamingLoudnessAnalyzer(sampleRate, channelCount);
    const block = 16_384;
    for (let start = 0; start < totalFrames; start += block) {
      const count = Math.min(block, totalFrames - start);
      analyzer.process(await readFrames(start, count));
    }
    const report = analyzer.finish();
    result.loudness = {
      integratedLufs: Number.isFinite(report.integratedLufs) ? Number(report.integratedLufs.toFixed(2)) : -70,
      truePeakDbtp: Number.isFinite(report.truePeakDbtp) ? Number(report.truePeakDbtp.toFixed(2)) : -70,
    };
  }

  return result;
}

async function handleAnalyzeMedia(payload: EngineAnalyzeMediaPayload): Promise<VideoMediaProbe> {
  const isImage = Boolean(payload.mimeType?.startsWith('image/'));
  const provider = new ProductionMediaProvider({ maxConcurrentOperations: 2 });
  const assetId = 'analyze_asset';
  try {
    provider.registerUrl(assetId, payload.url, {
      kind: isImage ? 'image' : 'media',
      ...(payload.mimeType ? { mimeType: payload.mimeType } : {}),
    });

    let probed: Awaited<ReturnType<ProductionMediaProvider['probe']>>;
    try {
      probed = await provider.probe(assetId, { purpose: 'export' });
    } catch (error) {
      if (!isImage && (payload.mimeType?.startsWith('audio/') || /\.(wav|mp3|ogg|flac|m4a|aac)/i.test(payload.url))) {
        return await analyzeAudioFallback(payload.url, payload);
      }
      throw error;
    }

    const index = probed.index;
    const videoTrack = index.tracks.find((t) => t.kind === 'video');
    const audioTrack = index.tracks.find((t) => t.kind === 'audio');
    const durationUs = index.durationUs;

    let fps: number | undefined;
    if (videoTrack && !isImage) {
      const samples = index.samples[videoTrack.id];
      if (samples && samples.length > 0 && durationUs > 0) {
        fps = Number(((samples.length * 1_000_000) / durationUs).toFixed(3));
      }
    }

    let posterDataUrl: string | undefined;
    let filmstrip: VideoFilmstripFrame[] | undefined;

    if (videoTrack) {
      const posterTimeUs = isImage
        ? 0
        : payload.posterTimeSec !== undefined
          ? Math.max(0, Math.min(durationUs - 1, Math.round(payload.posterTimeSec * 1_000_000)))
          : Math.min(Math.round(durationUs * 0.1), 1_000_000);
      try {
        const frame = await provider.frameAt(assetId, 0, posterTimeUs, undefined, {
          purpose: 'preview',
          maxDimension: payload.maxPosterWidth ?? 480,
          transient: true,
        });
        try {
          const png = await bitmapToPngBytes(frame, payload.maxPosterWidth ?? 480);
          posterDataUrl = `data:image/png;base64,${bytesToBase64(png.bytes)}`;
        } finally {
          frame.close();
        }
      } catch {
        // Non-fatal if poster decode fails
      }

      if (payload.includeFilmstrip && !isImage && durationUs > 0) {
        const count = Math.min(24, Math.max(1, payload.filmstripCount ?? 8));
        filmstrip = [];
        for (let i = 0; i < count; i += 1) {
          const tUs = Math.min(durationUs - 1, Math.round(((i + 0.5) / count) * durationUs));
          try {
            const frame = await provider.frameAt(assetId, 0, tUs, undefined, {
              purpose: 'preview',
              maxDimension: 240,
              transient: true,
            });
            try {
              const png = await bitmapToPngBytes(frame, 240);
              filmstrip.push({
                timeUs: tUs,
                dataUrl: `data:image/png;base64,${bytesToBase64(png.bytes)}`,
                width: png.width,
                height: png.height,
              });
            } finally {
              frame.close();
            }
          } catch {
            // Skip failed frame
          }
        }
      }
    }

    let sampleRate: number | undefined;
    let channels: number | undefined;
    let audioExtras: Pick<VideoMediaProbe, 'waveform' | 'silences' | 'beats' | 'loudness'> = {};

    if (audioTrack) {
      const needAudioScan = Boolean(
        payload.includeWaveform || payload.detectSilence || payload.detectBeats || payload.measureLoudness,
      );
      try {
        const probeBlock = await provider.pcmRange(assetId, 0, 0, Math.min(durationUs, 100_000));
        sampleRate = probeBlock.sampleRate;
        channels = probeBlock.channelCount;
        if (needAudioScan && sampleRate > 0 && channels > 0) {
          const totalFrames = Math.max(0, Math.floor((durationUs * sampleRate) / 1_000_000));
          const sr = sampleRate;
          const ch = channels;
          const readFrames = async (startFrame: number, frameCount: number, signal?: AbortSignal) => {
            const startUs = Math.round((startFrame / sr) * 1_000_000);
            const durUs = Math.max(1, Math.ceil((frameCount / sr) * 1_000_000));
            const block = await provider.pcmRange(assetId, 0, startUs, durUs, signal);
            const out = new Float32Array(frameCount * ch);
            const copyLen = Math.min(out.length, block.interleaved.length);
            if (copyLen > 0) out.set(block.interleaved.subarray(0, copyLen), 0);
            return out;
          };
          audioExtras = await runAudioAnalysis(sr, ch, totalFrames, readFrames, payload);
        }
      } catch {
        // Non-fatal if PCM decode fails
      }
    }

    return {
      ...(payload.mimeType ? { mimeType: payload.mimeType } : {}),
      ...(payload.byteLength !== undefined ? { byteLength: payload.byteLength } : {}),
      durationUs,
      ...(videoTrack ? { width: videoTrack.codedWidth, height: videoTrack.codedHeight } : {}),
      ...(fps !== undefined ? { fps } : {}),
      hasVideo: Boolean(videoTrack),
      hasAudio: Boolean(audioTrack),
      ...(sampleRate !== undefined ? { sampleRate } : {}),
      ...(channels !== undefined ? { channels } : {}),
      codecs: {
        ...(videoTrack?.codec ? { video: videoTrack.codec } : {}),
        ...(audioTrack?.codec ? { audio: audioTrack.codec } : {}),
      },
      ...(posterDataUrl ? { posterDataUrl } : {}),
      ...(filmstrip ? { filmstrip } : {}),
      ...audioExtras,
    };
  } finally {
    await provider.dispose();
  }
}

async function handleRenderFrames(payload: EngineRenderFramesPayload): Promise<EngineRenderFramesResult> {
  const provider = new ProductionMediaProvider({ maxConcurrentOperations: 2 });
  registerProjectAssets(provider, payload.assets);
  const session = await Aelion.createSession({
    media: provider,
    materials: materialRegistry,
    runtimeAssets: RUNTIME_ASSETS,
    skipAjvCompile: true,
    schemaValidationMode: 'structural',
  });

  const bitmapsToClose: Array<ImageBitmap | VideoFrame> = [];
  try {
    await session.loadProject(payload.projectJson);
    const seq = payload.projectJson.sequences[payload.projectJson.settings.defaultSequenceId];
    const seqWidth = seq?.format.width ?? 1920;
    const renderScale =
      payload.maxWidth && seqWidth > payload.maxWidth ? Math.max(0.1, Math.min(1, payload.maxWidth / seqWidth)) : 1;

    const frames: VideoFilmstripFrame[] = [];
    const sheetInputs: Array<{ timeUs: number; bitmap: ImageBitmap | VideoFrame; width: number; height: number }> = [];

    for (const rawTimeUs of payload.timestampsUs) {
      const timeUs = Math.max(0, Math.round(rawTimeUs));
      const rendered = await session.preview.renderFrame({
        timeUs,
        quality: 'full',
        renderScale,
      });
      if (payload.contactSheet) {
        bitmapsToClose.push(rendered.bitmap);
        const png = await bitmapToPngBytes(rendered.bitmap, payload.maxWidth);
        frames.push({
          timeUs,
          dataUrl: `data:image/png;base64,${bytesToBase64(png.bytes)}`,
          width: png.width,
          height: png.height,
        });
        sheetInputs.push({ timeUs, bitmap: rendered.bitmap, width: png.width, height: png.height });
      } else {
        try {
          const png = await bitmapToPngBytes(rendered.bitmap, payload.maxWidth);
          frames.push({
            timeUs,
            dataUrl: `data:image/png;base64,${bytesToBase64(png.bytes)}`,
            width: png.width,
            height: png.height,
          });
        } finally {
          rendered.bitmap.close();
        }
      }
    }

    if (payload.contactSheet && sheetInputs.length > 0) {
      const sheet = await buildContactSheet(sheetInputs);
      return {
        frames,
        contactSheetPng: sheet.bytes,
        contactSheetWidth: sheet.width,
        contactSheetHeight: sheet.height,
      };
    }

    return { frames };
  } finally {
    for (const bmp of bitmapsToClose) bmp.close();
    await session.dispose();
    await provider.dispose();
  }
}

function scaleProjectForExport(
  projectJson: AelionProject,
  targetWidth: number,
  targetHeight: number,
  targetFps?: number,
): AelionProject {
  const cloned = structuredClone(projectJson);
  const seq = cloned.sequences[cloned.settings.defaultSequenceId];
  if (!seq) return cloned;
  const origW = seq.format.width;
  const origH = seq.format.height;
  const evenW = Math.max(2, Math.round(targetWidth / 2) * 2);
  const evenH = Math.max(2, Math.round(targetHeight / 2) * 2);

  if (targetFps && targetFps > 0) {
    seq.format.frameRate = { numerator: Math.round(targetFps), denominator: 1 };
  }

  if (evenW === origW && evenH === origH) return cloned;

  const sx = evenW / origW;
  const sy = evenH / origH;
  const sFont = Math.min(sx, sy);
  seq.format.width = evenW;
  seq.format.height = evenH;

  const scalePoint = (pt: unknown) => {
    if (pt && typeof pt === 'object' && !Array.isArray(pt)) {
      const o = pt as Record<string, unknown>;
      if (typeof o.x === 'number' && typeof o.y === 'number') {
        o.x = o.x * sx;
        o.y = o.y * sy;
      }
    }
  };
  const scaleBox = (box: unknown) => {
    if (box && typeof box === 'object' && !Array.isArray(box)) {
      const o = box as Record<string, unknown>;
      if (typeof o.x === 'number') o.x *= sx;
      if (typeof o.y === 'number') o.y *= sy;
      if (typeof o.width === 'number') o.width = Math.max(1, o.width * sx);
      if (typeof o.height === 'number') o.height = Math.max(1, o.height * sy);
    }
  };
  const scaleTextStyle = (style: unknown) => {
    if (style && typeof style === 'object' && !Array.isArray(style)) {
      const o = style as Record<string, unknown>;
      if (typeof o.fontSizePx === 'number') o.fontSizePx = Math.max(6, o.fontSizePx * sFont);
      if (typeof o.strokeWidthPx === 'number') o.strokeWidthPx *= sFont;
      if (typeof o.lineHeightPx === 'number') o.lineHeightPx *= sFont;
      if (typeof o.letterSpacingPx === 'number') o.letterSpacingPx *= sFont;
    }
  };

  for (const item of Object.values(cloned.items)) {
    const rec = item as JsonObject;
    scaleBox(rec.box);
    scaleTextStyle(rec.style);
    if (Array.isArray(rec.paragraphs)) {
      for (const p of rec.paragraphs) {
        if (p && typeof p === 'object' && !Array.isArray(p) && Array.isArray((p as JsonObject).runs)) {
          for (const run of (p as JsonObject).runs as JsonObject[]) {
            scaleTextStyle(run.style);
          }
        }
      }
    }
    const visual = rec.visual as JsonObject | undefined;
    const transform = visual?.transform as JsonObject | undefined;
    if (transform?.positionPx) {
      const pos = transform.positionPx as JsonObject;
      if (pos.animation && typeof pos.animation === 'object' && !Array.isArray(pos.animation)) {
        const kfs = (pos.animation as JsonObject).keyframes;
        if (Array.isArray(kfs)) {
          for (const kf of kfs) {
            if (kf && typeof kf === 'object') scalePoint((kf as JsonObject).value);
          }
        }
      } else {
        scalePoint(pos);
      }
    }
  }
  return cloned;
}

function qualityBitrates(quality: VideoExportQuality): { videoBitrate: number; audioBitrate: number } {
  switch (quality) {
    case 'draft':
      return { videoBitrate: 2_500_000, audioBitrate: 128_000 };
    case 'high':
      return { videoBitrate: 12_000_000, audioBitrate: 256_000 };
    default:
      return { videoBitrate: 6_000_000, audioBitrate: 192_000 };
  }
}

async function handleExportProject(
  payload: EngineExportPayload,
  bridge: VideoEngineBridge,
): Promise<EngineExportResult> {
  const controller = new AbortController();
  activeExportAborts.set(payload.jobId, controller);

  const seq = payload.projectJson.sequences[payload.projectJson.settings.defaultSequenceId]!;
  let targetW = payload.width ?? seq.format.width;
  let targetH = payload.height ?? seq.format.height;
  let targetFps = payload.fps;

  if (payload.format === 'gif') {
    const maxGifW = Math.min(480, targetW);
    const scale = maxGifW / targetW;
    targetW = maxGifW;
    targetH = Math.max(2, Math.round(targetH * scale));
    const currentFps = seq.format.frameRate.numerator / seq.format.frameRate.denominator;
    targetFps = Math.min(payload.fps ?? 12, Math.min(12, Math.max(1, Math.round(currentFps))));
  } else if (payload.quality === 'draft' && !payload.width && !payload.height && targetH > 720) {
    const scale = 720 / targetH;
    targetH = 720;
    targetW = Math.max(2, Math.round(targetW * scale));
  }

  const effectiveProject = scaleProjectForExport(payload.projectJson, targetW, targetH, targetFps);
  const provider = new ProductionMediaProvider({ maxConcurrentOperations: 2 });
  registerProjectAssets(provider, payload.assets);

  const session = await Aelion.createSession({
    media: provider,
    materials: materialRegistry,
    runtimeAssets: RUNTIME_ASSETS,
    skipAjvCompile: true,
    schemaValidationMode: 'structural',
  });

  try {
    bridge.sendProgress({ jobId: payload.jobId, progress: 0.02, stage: 'preparing' });
    await session.loadProject(effectiveProject);

    let bytesWritten = 0;
    const createChunkSink = () =>
      new WritableStream<StreamTargetChunk>({
        async write(chunk) {
          if (controller.signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
          const copy = new Uint8Array(chunk.data.byteLength);
          copy.set(chunk.data);
          bytesWritten = Math.max(bytesWritten, chunk.position + copy.byteLength);
          await bridge.sendExportChunk({
            jobId: payload.jobId,
            position: chunk.position,
            data: copy,
          });
        },
      });

    const noopSink = () => new WritableStream<StreamTargetChunk>({});
    const bitrates = qualityBitrates(payload.quality);

    let negotiatedFormat: VideoExportFormat = payload.format;
    let negotiatedCodec = '';
    let exportOpts: AelionProfileExportOptions;

    if (payload.format === 'mp4') {
      const mp4Preflight = await session.export.preflightProfile({
        profile: 'mp4-h264-aac',
        sink: noopSink(),
        videoBitrate: bitrates.videoBitrate,
        audioBitrate: bitrates.audioBitrate,
        execution: 'worker',
      });
      if (mp4Preflight.ok) {
        negotiatedCodec = 'h264/aac';
        exportOpts = {
          profile: 'mp4-h264-aac',
          sink: createChunkSink(),
          videoBitrate: bitrates.videoBitrate,
          audioBitrate: bitrates.audioBitrate,
          execution: 'worker',
          signal: controller.signal,
          onProgress: (p) => bridge.sendProgress({ jobId: payload.jobId, progress: p, stage: 'encoding' }),
        };
      } else {
        const webmPreflight = await session.export.preflightProfile({
          profile: 'webm-vp9-opus',
          sink: noopSink(),
          videoBitrate: bitrates.videoBitrate,
          audioBitrate: bitrates.audioBitrate,
          execution: 'worker',
        });
        if (!webmPreflight.ok) {
          const reason = mp4Preflight.issues.map((i) => i.message).join('; ') || 'No supported video encoder';
          throw new Error(`Export preflight failed: ${reason}`);
        }
        negotiatedFormat = 'webm';
        negotiatedCodec = 'vp9/opus (fallback from mp4)';
        exportOpts = {
          profile: 'webm-vp9-opus',
          sink: createChunkSink(),
          videoBitrate: bitrates.videoBitrate,
          audioBitrate: bitrates.audioBitrate,
          execution: 'worker',
          signal: controller.signal,
          onProgress: (p) => bridge.sendProgress({ jobId: payload.jobId, progress: p, stage: 'encoding' }),
        };
      }
    } else if (payload.format === 'webm') {
      negotiatedCodec = 'vp9/opus';
      exportOpts = {
        profile: 'webm-vp9-opus',
        sink: createChunkSink(),
        videoBitrate: bitrates.videoBitrate,
        audioBitrate: bitrates.audioBitrate,
        execution: 'worker',
        signal: controller.signal,
        onProgress: (p) => bridge.sendProgress({ jobId: payload.jobId, progress: p, stage: 'encoding' }),
      };
    } else if (payload.format === 'wav') {
      negotiatedCodec = 'pcm-s16';
      exportOpts = {
        profile: 'audio-wav',
        sampleFormat: 's16',
        sink: createChunkSink(),
        signal: controller.signal,
        onProgress: (p) => bridge.sendProgress({ jobId: payload.jobId, progress: p, stage: 'mixing' }),
      };
    } else if (payload.format === 'gif') {
      negotiatedCodec = 'gif';
      exportOpts = {
        profile: 'animated-gif',
        loopCount: 0,
        sink: createChunkSink(),
        signal: controller.signal,
        onProgress: (p) => bridge.sendProgress({ jobId: payload.jobId, progress: p, stage: 'encoding' }),
      };
    } else {
      negotiatedCodec = 'png';
      exportOpts = {
        profile: 'still-png',
        timeUs: Math.max(0, Math.round(payload.timeUs ?? 0)),
        sink: createChunkSink(),
        signal: controller.signal,
        onProgress: (p) => bridge.sendProgress({ jobId: payload.jobId, progress: p, stage: 'rendering' }),
      };
    }

    bridge.sendProgress({ jobId: payload.jobId, progress: 0.05, stage: 'encoding' });
    const job = session.export.startProfile(exportOpts);
    await job;
    bridge.sendProgress({ jobId: payload.jobId, progress: 1, stage: 'completed' });
    return { negotiatedFormat, negotiatedCodec, bytesWritten };
  } finally {
    activeExportAborts.delete(payload.jobId);
    await session.dispose();
    await provider.dispose();
  }
}

function bootstrap(): void {
  const bridge = window.videoEngineBridge;
  if (!bridge) return;

  bridge.onCancel((jobId) => {
    activeExportAborts.get(jobId)?.abort(new DOMException('Export cancelled by user', 'AbortError'));
  });

  bridge.onRequest((req: VideoEngineRpcRequest) => {
    void (async () => {
      try {
        let result: unknown;
        switch (req.action) {
          case 'capabilities':
            result = await handleCapabilities();
            break;
          case 'analyzeMedia':
            result = await handleAnalyzeMedia(req.payload as EngineAnalyzeMediaPayload);
            break;
          case 'renderFrames':
            result = await handleRenderFrames(req.payload as EngineRenderFramesPayload);
            break;
          case 'exportProject':
            result = await handleExportProject(req.payload as EngineExportPayload, bridge);
            break;
          default:
            throw new Error(`Unknown video engine action: ${String(req.action)}`);
        }
        bridge.sendResponse({ id: req.id, ok: true, result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        bridge.sendResponse({ id: req.id, ok: false, error: message });
      }
    })();
  });

  bridge.ready();
}

bootstrap();
