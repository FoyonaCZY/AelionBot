import type {
  AudioEnergyBoundary,
  AudioEnergyChangeDetectionResult,
  BeatDetectionResult,
  LoudnessReport,
  PcmSourceBlock,
  SilenceDetectionResult,
  WaveformPeakResult,
} from '@aelionsdk/audio';
import type { CapabilityReport } from '@aelionsdk/capability';
import type { Diagnostic, JsonObject, JsonValue } from '@aelionsdk/core';
import type {
  ExportProfileId,
  ExportProfileSelection,
  ExportPreflightReport,
  GifExportResult,
  RemoteExportAsset,
  RemoteExportAssetAuthorizer,
  RemoteExportAuthorizer,
  RemoteExportProvider,
  RemoteExportResult,
  StillImageExportResult,
  SelectExportProfileOptions,
  WavExportResult,
  WebMExportOptions,
  WebMExportResult,
} from '@aelionsdk/export';
import type { WebGl2MaterialProgram } from '@aelionsdk/material-compiler';
import type { AelionProject } from '@aelionsdk/project-schema';
import type { CompileStats, IrMaterialDefinition, RenderIr } from '@aelionsdk/render-ir';
import type {
  RendererWorkerResourceSnapshot,
  RendererWorkerTiming,
  RenderIrFrameResult,
} from '@aelionsdk/renderer-worker';
import type { EditingCommands, TransactionBuilder, TransactionCommit } from '@aelionsdk/transaction';

export interface AelionProjectSchemas {
  /** Canonical schema for newly created and migrated Project documents. */
  readonly project: JsonObject;
  /** Frozen immutable v1.2 schema for explicitly validating stable 1.2 documents. */
  readonly previousProject?: JsonObject;
  /** Frozen immutable v1.0 schema for explicitly validating pre-1.1 documents. */
  readonly legacyProject?: JsonObject;
  readonly materialInstance: JsonObject;
}

export interface AelionMediaRequest {
  /** Preview may use an appropriate proxy. Export always requests the original representation. */
  readonly purpose: 'preview' | 'export';
  /** Largest requested output dimension, used to choose a right-sized preview proxy. */
  readonly maxDimension: number;
  /**
   * Thumbnail/filmstrip decodes must not share the persistent playback
   * decoder. Aborting those callers otherwise leaves the serial decode queue
   * walking toward a late timestamp and freezes preview.
   */
  readonly transient?: boolean;
}

export interface AelionMediaProvider {
  frameAt(
    assetId: string,
    streamIndex: number,
    sourceTimeUs: number,
    signal?: AbortSignal,
    request?: AelionMediaRequest,
  ): Promise<VideoFrame>;
  pcmRange(
    assetId: string,
    streamIndex: number,
    startUs: number,
    durationUs: number,
    signal?: AbortSignal,
  ): Promise<PcmSourceBlock>;
  /** Optional bounded, JSON-safe resource snapshot used by privacy-safe support reports. */
  getDiagnosticSnapshot?(): JsonObject;
}

export interface AelionRuntimeMaterialRegistry {
  resolveProgram(
    definition: IrMaterialDefinition,
    parameters: Readonly<Record<string, JsonValue>>,
  ): WebGl2MaterialProgram | undefined;
}

export interface AelionRuntimeAssets {
  readonly rendererWorker?: string | URL;
  readonly exportWorker?: string | URL;
  readonly sharedAudioWorklet?: string | URL;
  readonly transferableAudioWorklet?: string | URL;
}

export interface AelionSessionOptions {
  /** Overrides the v1 schemas bundled with `@aelionsdk/sdk`. */
  readonly schemas?: AelionProjectSchemas;
  readonly media?: AelionMediaProvider;
  readonly materials?: AelionRuntimeMaterialRegistry;
  readonly sequenceId?: string;
  readonly preferredBackend?: 'auto' | 'webgpu' | 'webgl2';
  readonly allowBackendFallback?: boolean;
  /** Explicit runtime assets remove any dependency on a particular bundler plugin. */
  readonly runtimeAssets?: AelionRuntimeAssets;
  /** Maximum full Preview/Player/Export frame evaluations in flight. Defaults to 2. */
  readonly maxPendingFrames?: number;
  /** Maximum retained diagnostic history entries. Defaults to 256. */
  readonly maxDiagnostics?: number;
  /** Skip Ajv `new Function()` compilation in strict-CSP renderers (uses structural + full semantic validation). */
  readonly skipAjvCompile?: boolean;
  /** Schema validation mode forwarded to ProjectValidator (`'auto' | 'ajv' | 'structural'`). */
  readonly schemaValidationMode?: 'auto' | 'ajv' | 'structural';
}

export interface AelionAudioSelection {
  readonly trackIds?: readonly string[];
  readonly itemIds?: readonly string[];
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: number) => void;
}

export interface AelionAudioAnalysisOptions extends AelionAudioSelection {
  readonly blockFrames?: number;
}

export interface AelionAudioWaveformOptions extends AelionAudioSelection {
  readonly windowFrames?: number;
  readonly maxPoints?: number;
}

export interface AelionAudioRemoveSilenceOptions {
  readonly itemId: string;
  readonly thresholdDb?: number;
  readonly minimumSilenceUs?: number;
  readonly paddingUs?: number;
  readonly windowFrames?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: number) => void;
}

export interface AelionAudioDuckingOptions {
  readonly programTrackIds: readonly string[];
  readonly sidechainTrackIds: readonly string[];
  readonly thresholdDb?: number;
  readonly reductionDb?: number;
  readonly attackUs?: number;
  readonly releaseUs?: number;
  /** Defaults to zero during export to avoid changing timeline duration. */
  readonly lookaheadUs?: number;
}

export interface AelionAudioMasteringOptions {
  readonly targetLufs?: number;
  readonly maximumGainDb?: number;
  readonly limiter?:
    | false
    | {
        readonly ceilingDbtp?: number;
        readonly releaseUs?: number;
        readonly lookaheadUs?: number;
      };
  readonly ducking?: readonly AelionAudioDuckingOptions[];
}

export interface AelionAudioRemoveSilenceResult {
  readonly commit: TransactionCommit;
  readonly detection: SilenceDetectionResult;
  readonly itemIds: readonly string[];
  readonly removedUs: number;
}

/** Structural result retained by the deprecated audio-only `analyzeScenes` wrapper. */
export interface AelionAudioSceneCompatibilityResult {
  readonly sampleRate: number;
  readonly totalFrames: number;
  readonly scenes: readonly AudioEnergyBoundary[];
}

export interface AelionAudioApi {
  analyze(options?: AelionAudioAnalysisOptions): Promise<LoudnessReport>;
  waveform(options?: AelionAudioWaveformOptions): Promise<WaveformPeakResult>;
  detectSilence(options: AelionAudioRemoveSilenceOptions): Promise<SilenceDetectionResult>;
  analyzeBeats(options?: AelionAudioAnalysisOptions): Promise<BeatDetectionResult>;
  analyzeAudioEnergyChanges(options?: AelionAudioAnalysisOptions): Promise<AudioEnergyChangeDetectionResult>;
  /** @deprecated Audio-only input cannot detect video scenes; use analyzeAudioEnergyChanges. */
  analyzeScenes(options?: AelionAudioAnalysisOptions): Promise<AelionAudioSceneCompatibilityResult>;
  removeSilence(options: AelionAudioRemoveSilenceOptions): Promise<AelionAudioRemoveSilenceResult>;
  configureMastering(options: AelionAudioMasteringOptions): TransactionCommit;
  getMastering(): AelionAudioMasteringOptions | undefined;
}

export type AelionSessionState = 'empty' | 'ready' | 'disposed';
export type AelionPlayerState = 'idle' | 'paused' | 'playing' | 'ended' | 'error' | 'disposed';

export type AelionSessionEvent =
  | { readonly type: 'project-loaded'; readonly projectId: string; readonly revision: bigint }
  | { readonly type: 'project-changed'; readonly commit: TransactionCommit }
  | {
      readonly type: 'state-changed';
      readonly previousState: AelionSessionState;
      readonly state: AelionSessionState;
    }
  | { readonly type: 'capability-changed'; readonly capability: CapabilityReport }
  | { readonly type: 'stats-changed'; readonly stats: AelionSessionStats }
  | { readonly type: 'diagnostic'; readonly diagnostic: Diagnostic };

export type AelionSessionEventType = AelionSessionEvent['type'];
export type AelionSessionEventOf<T extends AelionSessionEventType> = Extract<AelionSessionEvent, { readonly type: T }>;

export interface AelionPreviewQualityOptions {
  /** Draft defaults to half-resolution; full defaults to Project resolution. */
  readonly quality?: 'draft' | 'full';
  /** Explicit preview scale in (0, 1]. Overrides the quality default. */
  readonly renderScale?: number;
}

export interface AelionPreviewOptions extends AelionPreviewQualityOptions {
  readonly timeUs: number;
  readonly signal?: AbortSignal;
  /**
   * Renders an edit that has not been made.
   *
   * The callback describes a transaction exactly as `transaction.edit` would,
   * but nothing is committed: no revision, no history entry, no change event.
   * The frame shows the Project as it *would* be, and the loaded Project is
   * untouched whether the interaction is completed or abandoned.
   *
   * This is what a drag needs. Committing on every pointer move to see the
   * result rearranges the timeline under the cursor and fills the undo stack
   * with states nobody chose; without it, a host can only preview a proposed
   * edit by making it. Pair with `transaction.commands.applyPlacements` on
   * release to write the layout the user was looking at.
   */
  readonly overlay?: (transaction: TransactionBuilder) => void;
}

export interface AelionPlayerFrame {
  readonly generation: number;
  readonly frameIndex: number;
  readonly timestampUs: number;
  readonly droppedFrames: number;
  readonly result: RenderIrFrameResult;
}

/** A playhead observation. Carries no frame, so any number of listeners may take it. */
export interface AelionPlayerTime {
  readonly timeUs: number;
  readonly state: AelionPlayerState;
}

export interface AelionPlayerApi {
  readonly state: AelionPlayerState;
  readonly currentTimeUs: number;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(timeUs: number): Promise<void>;
  scrub(timeUs: number): Promise<RenderIrFrameResult>;
  setPreviewQuality(options: AelionPreviewQualityOptions): void;
  getStats(): AelionPlayerStats;
  /**
   * Takes ownership of presented frames. Exclusive: the listener must close
   * each `result.bitmap`, and exactly one consumer can be responsible for that.
   */
  subscribe(listener: (frame: AelionPlayerFrame) => void): () => void;
  /** Follows the playhead without owning a frame. Any number of listeners. */
  subscribeTime(listener: (time: AelionPlayerTime) => void): () => void;
  /**
   * Releases the audio and video transport and returns the Player to `idle`.
   *
   * Pausing keeps the runtime alive so playback can resume instantly. Resetting
   * gives it back, which is what a host wants when the timeline is no longer
   * being watched -- switching Projects, closing the editor, or settling after
   * a batch of edits.
   */
  reset(): Promise<void>;
}

export interface AelionPlayerStats {
  readonly state: AelionPlayerState;
  /** Last playhead timestamp observed by a state or rendered-frame update. */
  readonly currentTimeUs: number;
  readonly generation: number;
  readonly renderedFrames: number;
  readonly droppedFrames: number;
  readonly errors: number;
  readonly lastErrorCode: string | null;
  readonly previewQuality: {
    readonly quality: 'draft' | 'full';
    readonly renderScale: number;
  };
  /** Bounded runtime ownership state for diagnostics and leak conformance. */
  readonly resources: AelionPlayerResourceStats;
}

export interface AelionPlayerResourceStats {
  readonly listeners: number;
  readonly runtimeInitializing: boolean;
  readonly audioFillScheduled: boolean;
  readonly audioFillInFlight: boolean;
  readonly scheduler: {
    readonly present: boolean;
    readonly disposed: boolean;
    readonly scheduled: boolean;
    readonly rendering: boolean;
  };
  readonly audio: {
    readonly mode: 'none' | 'shared-ring' | 'transferable-queue';
    readonly disposed: boolean;
    readonly contextState: AudioContextState | 'interrupted' | null;
    readonly bufferedFrames: number;
    readonly closed: boolean;
  };
  /** Actual terminal state captured from the most recently released runtime. */
  readonly lastDisposedRuntime: {
    readonly schedulerDisposed: boolean;
    readonly audioDisposed: boolean;
    readonly audioContextClosed: boolean;
    readonly transportClosed: boolean;
    readonly bufferedFrames: number;
  } | null;
}

export interface AelionTransactionApi {
  readonly commands: EditingCommands;
  edit(
    callback: (transaction: TransactionBuilder) => void,
    options?: { readonly label?: string; readonly baseRevision?: bigint },
  ): TransactionCommit;
  beginInteractive(options?: AelionInteractiveEditOptions): AelionInteractiveEdit;
  undo(): TransactionCommit;
  redo(): TransactionCommit;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export interface AelionInteractiveEditOptions {
  readonly label?: string;
  /** Optimistic revision checked by the first update in the interaction. */
  readonly baseRevision?: bigint;
}

export interface AelionInteractiveEdit {
  readonly active: boolean;
  readonly updateCount: number;
  update(callback: (transaction: TransactionBuilder) => void): TransactionCommit;
  /** Seals the coalesced undo entry. No extra Project revision is created. */
  commit(): void;
  /** Restores the pre-interaction Project without leaving a redo entry. */
  cancel(): TransactionCommit | null;
}

export interface AelionExportOptions {
  readonly sink: WebMExportOptions['sink'];
  readonly videoBitrate?: number;
  readonly audioBitrate?: number;
  readonly signal?: AbortSignal;
  readonly cleanupSink?: (reason: unknown) => void | Promise<void>;
  readonly onProgress?: (progress: number) => void;
  /** Moves WebCodecs encode/mux work off the page main thread when supported. */
  readonly execution?: 'worker' | 'inline';
  /** Overrides revisioned Project mastering settings for this export. */
  readonly audioProcessing?: AelionAudioMasteringOptions;
}

export interface AelionExportApi {
  preflight(options: AelionExportOptions): Promise<ExportPreflightReport>;
  preflightProfile(options: AelionProfileExportOptions): Promise<ExportPreflightReport>;
  /** Negotiates exact local codec support against the loaded Sequence format. */
  negotiate(
    options: Pick<
      SelectExportProfileOptions,
      'preferred' | 'fallbacks' | 'remoteAvailable' | 'videoBitrate' | 'audioBitrate'
    >,
  ): Promise<ExportProfileSelection>;
  /** Starts one frozen-revision export. The returned job remains await-compatible. */
  start(options: AelionExportOptions): AelionExportJob;
  /** Starts a non-default production export profile from the same frozen Render IR. */
  startProfile(options: AelionProfileExportOptions): AelionProfileExportJob;
  /** Starts a provider-backed export from one canonical, frozen Project manifest. */
  startRemote(options: AelionRemoteExportOptions): AelionRemoteExportJob;
  /** Cancels the active job, if one exists, and waits for pipeline cleanup. */
  cancel(reason?: unknown): Promise<void>;
  readonly activeJob: AelionExportJob | AelionProfileExportJob | AelionRemoteExportJob | null;
}

export type AelionExportJobState = 'running' | 'completed' | 'failed' | 'cancelled';

export interface AelionExportJobSnapshot {
  readonly id: string;
  readonly state: AelionExportJobState;
  readonly progress: number;
}

interface AelionProfileExportBaseOptions {
  readonly sink: WebMExportOptions['sink'];
  readonly signal?: AbortSignal;
  readonly cleanupSink?: (reason: unknown) => void | Promise<void>;
  readonly onProgress?: (progress: number) => void;
  /** Moves muxed WebCodecs encode/mux work off the page main thread when supported. */
  readonly execution?: 'worker' | 'inline';
  readonly audioProcessing?: AelionAudioMasteringOptions;
}

export type AelionProfileExportOptions =
  | (AelionProfileExportBaseOptions & {
      readonly profile: 'webm-vp9-opus' | 'mp4-h264-aac' | 'mp4-av1-aac' | 'mp4-hevc-aac';
      readonly videoBitrate?: number;
      readonly audioBitrate?: number;
    })
  | (AelionProfileExportBaseOptions & {
      readonly profile: 'audio-wav';
      readonly sampleFormat?: 's16' | 'f32';
    })
  | (AelionProfileExportBaseOptions & {
      readonly profile: 'still-png' | 'still-jpeg' | 'still-webp';
      readonly timeUs: number;
      readonly quality?: number;
    })
  | (AelionProfileExportBaseOptions & {
      readonly profile: 'animated-gif';
      readonly loopCount?: number;
    });

export type AelionProfileExportResult = WebMExportResult | WavExportResult | StillImageExportResult | GifExportResult;

export interface AelionTypedExportJob<TResult> extends Promise<TResult> {
  readonly id: string;
  readonly state: AelionExportJobState;
  readonly result: Promise<TResult>;
  cancel(reason?: unknown): Promise<void>;
  getSnapshot(): AelionExportJobSnapshot;
  subscribe(listener: (snapshot: AelionExportJobSnapshot) => void): () => void;
}

/**
 * A cancellable export handle. It implements Promise so existing
 * `await session.export.start(options)` consumers remain source-compatible.
 */
export type AelionExportJob = AelionTypedExportJob<WebMExportResult>;

export type AelionProfileExportJob = AelionTypedExportJob<AelionProfileExportResult>;

export interface AelionRemoteExportOptions {
  readonly profile: ExportProfileId;
  readonly provider: RemoteExportProvider;
  readonly authorizer: RemoteExportAuthorizer;
  /** Content-addressed source assets required by the remote renderer. */
  readonly assets?: readonly RemoteExportAsset[];
  /** Issues short-lived, per-asset credentials after protocol negotiation succeeds. */
  readonly assetAuthorizer?: RemoteExportAssetAuthorizer;
  /** Replaces the default canonical Project manifest when a provider needs extra bindings. */
  readonly manifest?: JsonObject;
  /** Overrides the content-derived idempotency key for an existing provider workflow. */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: number, stage?: string) => void;
}

export type AelionRemoteExportJob = AelionTypedExportJob<RemoteExportResult>;

export interface AelionPreviewApi {
  renderFrame(options: AelionPreviewOptions): Promise<RenderIrFrameResult>;
}

/** Sampling window and bounded output dimensions for a timeline filmstrip. */
export interface AelionFilmstripOptions {
  /** Visual Item to sample. Sampling follows its time mapping, so speed ramps stay honest. */
  readonly itemId: string;
  /** Number of evenly spaced samples across the Item's timeline range, from 1 to 128. */
  readonly count: number;
  /** Height of each sample in pixels, from 1 to 512. Width follows the source aspect. */
  readonly frameHeight?: number;
  readonly signal?: AbortSignal;
}

/** Owned filmstrip bitmap plus the exact source times sampled into it. */
export interface AelionFilmstripResult {
  readonly itemId: string;
  /** Samples composed left to right into one image. The caller closes it. */
  readonly bitmap: ImageBitmap;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly frameCount: number;
  /** Item-local time each sample was taken at, in Sequence time. */
  readonly timesUs: readonly number[];
}

/** Source location and maximum output dimension for one thumbnail. */
export interface AelionThumbnailOptions {
  readonly assetId: string;
  readonly streamIndex?: number;
  readonly sourceTimeUs?: number;
  /** Largest output dimension, from 1 to 8192. Defaults to 320. */
  readonly maxDimension?: number;
  readonly signal?: AbortSignal;
}

/**
 * Decoding for the parts of an editor that are not the program monitor.
 *
 * Clip filmstrips and library thumbnails have to share one media pipeline with
 * playback without stalling it, which means a transient decode budget, serial
 * ordering, and cancellation the moment playback starts. Every host needs the
 * same thing, and a host that reaches for `frameAt` directly gets none of it --
 * it competes with the playback decoder and freezes preview.
 */
export interface AelionMediaApi {
  /** One decoded still, right-sized. The caller closes the returned bitmap. */
  thumbnail(options: AelionThumbnailOptions): Promise<ImageBitmap>;
  /** Evenly spaced samples across an Item, composed into one strip. */
  filmstrip(options: AelionFilmstripOptions): Promise<AelionFilmstripResult>;
}

export interface AelionSessionStats {
  readonly schemaVersion: '1.0.0';
  readonly revision: bigint | null;
  readonly diagnostics: {
    readonly retained: number;
    readonly dropped: number;
    readonly limit: number;
  };
  readonly compile: CompileStats | null;
  readonly preview: {
    readonly requestedFrames: number;
    readonly renderedFrames: number;
    readonly failedFrames: number;
    readonly lastBackend: 'webgpu' | 'webgl2' | null;
    readonly lastWidth: number | null;
    readonly lastHeight: number | null;
    readonly lastRenderScale: number | null;
    readonly lastTiming: RendererWorkerTiming | null;
    readonly lastResources: RendererWorkerResourceSnapshot | null;
    readonly pendingFrames: number;
    readonly maxPendingFrames: number;
    readonly rendererPresent: boolean;
    readonly rendererDisposed: boolean;
    readonly workerPendingRequests: number;
    readonly workerActiveRequests: number;
    readonly workerCancelledRequests: number;
    /** Actual terminal snapshot captured before releasing the disposed renderer wrapper. */
    readonly lastDisposedRenderer: {
      readonly disposed: boolean;
      readonly pendingFrames: number;
      readonly workerDisposed: boolean;
      readonly workerPendingRequests: number;
      readonly workerActiveRequests: number;
      readonly workerCancelledRequests: number;
    } | null;
  };
  readonly player: AelionPlayerStats;
  readonly export: {
    readonly jobsStarted: number;
    readonly jobsCompleted: number;
    readonly jobsFailed: number;
    readonly jobsCancelled: number;
    readonly activeJobId: string | null;
    readonly progress: number;
  };
  readonly timings: {
    readonly projectLoad: AelionOperationTimingStats;
    readonly capabilityProbe: AelionOperationTimingStats;
    readonly preview: AelionOperationTimingStats;
    readonly export: AelionOperationTimingStats;
  };
}

export interface AelionOperationTimingStats {
  readonly count: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly totalUs: number;
  readonly maximumUs: number;
  readonly lastUs: number | null;
}

export interface AelionSessionSnapshot {
  readonly state: AelionSessionState;
  readonly revision: bigint | null;
  readonly project: Readonly<AelionProject> | null;
  readonly renderIr: RenderIr | null;
  readonly capability: CapabilityReport | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly stats: AelionSessionStats;
}

export interface AelionSessionApi {
  readonly state: AelionSessionState;
  readonly revision: bigint | null;
  readonly transaction: AelionTransactionApi;
  readonly player: AelionPlayerApi;
  readonly preview: AelionPreviewApi;
  readonly media: AelionMediaApi;
  readonly export: AelionExportApi;
  readonly audio: AelionAudioApi;
  loadProject(project: unknown): Promise<void>;
  /** @deprecated Use `session.preview.renderFrame()` for new integrations. */
  renderFrame(options: AelionPreviewOptions): Promise<RenderIrFrameResult>;
  probeCapabilities(signal?: AbortSignal): Promise<CapabilityReport>;
  getSnapshot(): AelionSessionSnapshot;
  getCapabilitySnapshot(): CapabilityReport | null;
  getDiagnostics(): readonly Diagnostic[];
  getStats(): AelionSessionStats;
  createDiagnosticReport(options?: AelionDiagnosticReportOptions): AelionDiagnosticReport;
  subscribe(listener: (event: AelionSessionEvent) => void): () => void;
  subscribe<T extends AelionSessionEventType>(type: T, listener: (event: AelionSessionEventOf<T>) => void): () => void;
  dispose(): Promise<void>;
}

export interface AelionDiagnosticReportOptions {
  /**
   * `safe` omits messages, entity ids, free-form details and identifying
   * environment strings. `full` is an explicit opt-in for local debugging.
   */
  readonly privacy?: 'safe' | 'full';
}

export interface AelionDiagnosticReport {
  readonly schemaVersion: '1.0.0';
  readonly generatedAt: string;
  readonly privacy: 'safe' | 'full';
  readonly session: {
    readonly state: AelionSessionState;
    readonly revision: string | null;
  };
  readonly capability: JsonObject | null;
  readonly diagnostics: readonly JsonObject[];
  readonly stats: JsonObject;
  readonly media: JsonObject | null;
}

export interface AelionApi {
  createSession(options?: AelionSessionOptions): Promise<AelionSessionApi>;
}
