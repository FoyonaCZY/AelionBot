// Shared Video Studio contracts between the Electron main process (video-engine) and the React renderer (video-ui).
// Keep framework-free (no React or DOM runtime dependencies).

export const VIDEO_RUNTIME_DIR = 'video-runtime';

export const VIDEO_RUNTIME_ASSETS = {
  rendererWorker: 'webgl2-worker.js',
  exportWorker: 'mux-export-worker.js',
  sharedAudioWorklet: 'pcm-player.worklet.js',
  transferableAudioWorklet: 'pcm-message-player.worklet.js',
} as const;

export type VideoAspectPreset = '16:9' | '9:16' | '1:1' | '4:5' | '4:3' | 'custom';

export const VIDEO_ASPECT_DIMENSIONS: Readonly<
  Record<Exclude<VideoAspectPreset, 'custom'>, { readonly width: number; readonly height: number }>
> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
  '4:3': { width: 1440, height: 1080 },
};

export type VideoTransitionPreset = 'cross-dissolve' | 'fade-black' | 'fade-white' | 'slide-left' | 'slide-right';

export type VideoEffectPreset =
  | 'warm-film'
  | 'soft-glow'
  | 'grayscale'
  | 'sepia'
  | 'cinematic'
  | 'blur'
  | 'brightness'
  | 'contrast'
  | 'saturate'
  | 'hue-rotate';

export type VideoExportFormat = 'mp4' | 'webm' | 'wav' | 'gif' | 'png';
export type VideoExportQuality = 'draft' | 'standard' | 'high';
export type VideoExportStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type VideoClipFit = 'contain' | 'cover' | 'fill' | 'none';
export type VideoTrackKind = 'visual' | 'audio' | 'caption';
export type VideoClipKind =
  'video' | 'audio' | 'image' | 'text' | 'caption' | 'shape' | 'generator' | 'adjustment' | 'gap';

export interface VideoSilenceSegment {
  startUs: number;
  endUs: number;
  durationUs: number;
  peakDb?: number;
}

export interface VideoBeatMarker {
  timeUs: number;
  strength: number;
}

export interface VideoLoudnessSummary {
  integratedLufs: number;
  truePeakDbtp: number;
  loudnessRangeLu?: number;
}

export interface VideoFilmstripFrame {
  timeUs: number;
  dataUrl: string;
  width: number;
  height: number;
}

export interface VideoMediaProbe {
  path?: string;
  attachmentId?: string;
  mimeType?: string;
  byteLength?: number;
  durationUs: number;
  width?: number;
  height?: number;
  fps?: number;
  hasVideo?: boolean;
  hasAudio: boolean;
  sampleRate?: number;
  channels?: number;
  codecs?: {
    video?: string;
    audio?: string;
  };
  posterDataUrl?: string;
  filmstrip?: VideoFilmstripFrame[];
  waveform?: number[];
  silences?: VideoSilenceSegment[];
  beats?: VideoBeatMarker[];
  loudness?: VideoLoudnessSummary;
}

export interface VideoAssetInfo {
  id: string;
  kind: 'video' | 'audio' | 'image' | 'font' | 'image-sequence';
  name: string;
  sourcePath?: string;
  attachmentId?: string;
  streamUrl?: string;
  mimeType?: string;
  byteLength?: number;
  durationUs?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
  sampleRate?: number;
  channels?: number;
  posterDataUrl?: string;
  waveform?: number[];
}

export interface VideoClipCrop {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
}

export interface VideoClipStyle {
  fit?: VideoClipFit;
  opacity?: number;
  positionPx?: { x: number; y: number };
  anchor?: { x: number; y: number };
  scale?: { x: number; y: number };
  rotationDeg?: number;
  crop?: VideoClipCrop;
  blendMode?: string;
}

export interface VideoTextBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VideoTextStyle {
  fontFamily?: string;
  fontSizePx?: number;
  fontWeight?: number;
  fontStyle?: 'normal' | 'italic';
  fill?: string;
  stroke?: string;
  strokeWidthPx?: number;
  align?: 'start' | 'center' | 'end';
  backgroundFill?: string;
  backgroundOpacity?: number;
  backgroundPaddingPx?: number;
  backgroundRadiusPx?: number;
  lineHeightPx?: number;
  letterSpacingPx?: number;
}

export interface VideoClipEffect {
  id: string;
  preset: VideoEffectPreset;
  intensity?: number;
  enabled?: boolean;
  params?: Record<string, number>;
}

export interface VideoKeyframe {
  timeUs: number;
  value: number | { x: number; y: number };
  interpolation?: 'linear' | 'hold' | 'cubic';
}

export type VideoKeyframeProperty = 'opacity' | 'position' | 'scale' | 'rotation' | 'gain' | 'pan';

export interface VideoClipTransitionRef {
  id: string;
  preset: VideoTransitionPreset;
  durationUs: number;
}

export interface VideoClipSummary {
  id: string;
  trackId: string;
  kind: VideoClipKind;
  name?: string;
  assetId?: string;
  startUs: number;
  durationUs: number;
  sourceStartUs?: number;
  sourceDurationUs?: number;
  rate?: number;
  enabled: boolean;
  style?: VideoClipStyle;
  gainDb?: number;
  pan?: number;
  fadeInUs?: number;
  fadeOutUs?: number;
  text?: string;
  textBox?: VideoTextBox;
  textStyle?: VideoTextStyle;
  effects?: VideoClipEffect[];
  transitionIn?: VideoClipTransitionRef;
  transitionOut?: VideoClipTransitionRef;
  posterDataUrl?: string;
}

export interface VideoTrackSummary {
  id: string;
  kind: VideoTrackKind;
  name: string;
  role?: 'storyline' | 'overlay';
  enabled: boolean;
  locked: boolean;
  muted?: boolean;
  solo?: boolean;
  gainDb?: number;
  clips: VideoClipSummary[];
}

export interface VideoProjectSummary {
  id: string;
  botId?: string;
  sessionId?: string;
  title: string;
  aspect: VideoAspectPreset;
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
  durationUs: number;
  revision: string;
  trackCount: number;
  clipCount: number;
  assetCount: number;
  posterDataUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VideoExportJob {
  id: string;
  projectId: string;
  status: VideoExportStatus;
  format: VideoExportFormat;
  quality: VideoExportQuality;
  progress: number;
  stage: string;
  outputPath?: string;
  artifactId?: string;
  error?: string;
  negotiatedCodec?: string;
  startedAt: string;
  endedAt?: string;
}

export interface VideoProjectDetail extends VideoProjectSummary {
  sequenceId: string;
  canUndo: boolean;
  canRedo: boolean;
  tracks: VideoTrackSummary[];
  assets: VideoAssetInfo[];
  /** Canonical AelionSDK v2.0 project JSON document for renderer preview/editing. */
  projectJson: Record<string, unknown>;
  /** Asset ID to streamable URL (e.g. aelion-video:// or aelion-media://) map for renderer playback. */
  assetUrls: Record<string, string>;
  recentExports?: VideoExportJob[];
}

export interface VideoProjectCreateInput {
  botId?: string;
  sessionId?: string;
  title?: string;
  aspect?: VideoAspectPreset;
  width?: number;
  height?: number;
  fps?: number;
  sampleRate?: 44_100 | 48_000 | 96_000;
  backgroundColor?: string;
}

export interface VideoAssetImportInput {
  projectId: string;
  source:
    | { kind: 'host'; path: string }
    | { kind: 'workspace'; botId: string; path: string }
    | { kind: 'attachment'; attachmentId: string };
  name?: string;
  assetId?: string;
  analyze?: boolean;
}

export interface VideoSubtitleCue {
  startUs: number;
  endUs: number;
  text: string;
}

export type VideoEditOperation =
  | {
      op: 'add_clip';
      clipId?: string;
      trackId?: string;
      trackKind?: VideoTrackKind;
      assetId: string;
      kind?: 'video' | 'audio' | 'image';
      startUs?: number;
      durationUs?: number;
      sourceStartUs?: number;
      name?: string;
      style?: VideoClipStyle;
      gainDb?: number;
      fadeInUs?: number;
      fadeOutUs?: number;
      rate?: number;
    }
  | {
      op: 'move_clip';
      clipId: string;
      startUs: number;
      trackId?: string;
      ripple?: boolean;
    }
  | {
      op: 'trim_clip';
      clipId: string;
      startUs?: number;
      durationUs?: number;
      sourceStartUs?: number;
      ripple?: boolean;
    }
  | {
      op: 'split_clip';
      clipId: string;
      atUs: number;
      rightClipId?: string;
    }
  | {
      op: 'delete_clip';
      clipId: string;
      ripple?: boolean;
    }
  | {
      op: 'replace_asset';
      clipId: string;
      assetId: string;
      sourceStartUs?: number;
      keepDuration?: boolean;
    }
  | {
      op: 'add_text';
      clipId?: string;
      trackId?: string;
      text: string;
      startUs: number;
      durationUs: number;
      role?: 'text' | 'caption';
      box?: VideoTextBox;
      style?: VideoTextStyle;
      clipStyle?: VideoClipStyle;
    }
  | {
      op: 'update_text';
      clipId: string;
      text?: string;
      box?: Partial<VideoTextBox>;
      style?: Partial<VideoTextStyle>;
    }
  | {
      op: 'import_subtitles';
      trackId?: string;
      format?: 'srt' | 'vtt' | 'cues';
      content?: string;
      cues?: VideoSubtitleCue[];
      replaceExisting?: boolean;
      box?: VideoTextBox;
      style?: VideoTextStyle;
    }
  | {
      op: 'set_transition';
      fromClipId: string;
      toClipId: string;
      preset: VideoTransitionPreset | null;
      durationUs?: number;
    }
  | {
      op: 'set_effect';
      clipId: string;
      preset: VideoEffectPreset;
      enabled?: boolean;
      intensity?: number;
      params?: Record<string, number>;
      remove?: boolean;
    }
  | {
      op: 'set_keyframes';
      clipId: string;
      property: VideoKeyframeProperty;
      keyframes: VideoKeyframe[];
    }
  | {
      op: 'remove_silence';
      clipId: string;
      thresholdDb?: number;
      minimumSilenceUs?: number;
      paddingUs?: number;
    }
  | {
      op: 'auto_duck';
      /** Required unless removing; removing without it clears every rule. */
      programTrackIds?: string[];
      sidechainTrackIds?: string[];
      thresholdDb?: number;
      reductionDb?: number;
      attackUs?: number;
      releaseUs?: number;
      /** Turn ducking off instead of on. */
      remove?: boolean;
    }
  | {
      op: 'normalize_loudness';
      targetLufs?: number;
      maximumGainDb?: number;
      ceilingDbtp?: number;
      /** Turn loudness normalization off. */
      remove?: boolean;
    }
  | {
      op: 'snap_to_beats';
      audioTrackId?: string;
      audioClipId?: string;
      clipIds?: string[];
      maxOffsetUs?: number;
    }
  | {
      op: 'set_track_audio';
      trackId: string;
      muted?: boolean;
      solo?: boolean;
      enabled?: boolean;
      locked?: boolean;
      gainDb?: number;
    }
  | {
      op: 'set_clip_style';
      clipId: string;
      style: Partial<VideoClipStyle>;
      gainDb?: number;
      pan?: number;
      fadeInUs?: number;
      fadeOutUs?: number;
      rate?: number;
    }
  | {
      op: 'undo';
    }
  | {
      op: 'redo';
    };

export interface VideoEditRequest {
  projectId: string;
  expectedRevision?: string;
  operations: VideoEditOperation[];
  historyLabel?: string;
}

export interface VideoEditResult {
  project: VideoProjectDetail;
  revision: string;
  applied: number;
  warnings?: string[];
}

export interface VideoExportRequest {
  projectId: string;
  format: VideoExportFormat;
  quality?: VideoExportQuality;
  outputPath?: string;
  attachToChat?: boolean;
  /** Required when format === 'png' (defaults to 0). */
  timeUs?: number;
  /** Optional FPS override for GIF/video exports. */
  fps?: number;
  /** Optional width/height override (defaults to project format or quality preset). */
  width?: number;
  height?: number;
}

export interface VideoMediaSourceRef {
  kind: 'host' | 'workspace' | 'attachment' | 'artifact';
  path?: string;
  botId?: string;
  attachmentId?: string;
  artifactId?: string;
}

export interface VideoMediaAnalyzeInput {
  source: VideoMediaSourceRef;
  includeFilmstrip?: boolean;
  filmstripCount?: number;
  includeWaveform?: boolean;
  waveformPoints?: number;
  detectSilence?: boolean;
  detectBeats?: boolean;
  measureLoudness?: boolean;
}

export interface VideoMediaPosterInput {
  source: VideoMediaSourceRef;
  timeSec?: number;
  maxWidth?: number;
}

export interface VideoMediaPosterResult {
  posterDataUrl: string;
  durationSec?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
}

export type VideoQuickEditAction =
  | {
      action: 'trim';
      startSec: number;
      endSec: number;
      format?: 'mp4' | 'webm';
      quality?: VideoExportQuality;
      outputPath?: string;
    }
  | {
      action: 'remove_silence';
      thresholdDb?: number;
      minimumSilenceMs?: number;
      paddingMs?: number;
      format?: 'mp4' | 'webm';
      quality?: VideoExportQuality;
      outputPath?: string;
    }
  | {
      action: 'capture_frame';
      timeSec: number;
      outputPath?: string;
    }
  | {
      action: 'promote_to_project';
      title?: string;
      botId?: string;
      sessionId?: string;
    };

export interface VideoQuickEditRequest {
  source: VideoMediaSourceRef;
  edit: VideoQuickEditAction;
}

export interface VideoQuickEditResult {
  action: VideoQuickEditAction['action'];
  outputPath?: string;
  attachmentId?: string;
  posterDataUrl?: string;
  project?: VideoProjectDetail;
  job?: VideoExportJob;
  removedSec?: number;
}

export interface VideoProjectFrameInput {
  projectId: string;
  timestampsUs: number[];
  maxWidth?: number;
}

export interface VideoProjectFrameResult {
  projectId: string;
  revision: string;
  frames: VideoFilmstripFrame[];
}

export interface VideoEngineState {
  ready: boolean;
  runtimeOrigin?: string;
  supportedExportFormats: VideoExportFormat[];
  codecs: {
    h264: boolean;
    vp9: boolean;
    av1: boolean;
    hevc: boolean;
    aac: boolean;
    opus: boolean;
  };
  activeExports: VideoExportJob[];
  projectCount: number;
}
