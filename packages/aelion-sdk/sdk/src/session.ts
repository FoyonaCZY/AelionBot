import { renderIrAudio } from '@aelionsdk/audio';
import { probeCapabilities } from '@aelionsdk/capability';
import { AelionError, type Diagnostic, type JsonObject } from '@aelionsdk/core';
import {
  createRemoteExportContentId,
  exportFrozenRenderIrAv1Mp4,
  exportFrozenRenderIrHevcMp4,
  exportFrozenRenderIrMp4,
  exportFrozenRenderIrWebM,
  exportGif,
  exportStillImage,
  exportWav,
  preflightProfileExport,
  preflightWebMExport,
  runRemoteExport,
  selectExportProfile,
  type FrozenWebMExportOptions,
} from '@aelionsdk/export';
import { canonicalStringify, ProjectValidator, type AelionProject } from '@aelionsdk/project-schema';
import {
  evaluateAnimatedValue,
  resolveMediaSourceFrame,
  evaluateVisualState,
  mapClipSourceTime,
  IncrementalRenderCompiler,
  type CompileStats,
  type RenderIr,
} from '@aelionsdk/render-ir';
import {
  RenderIrFrameRenderer,
  type RenderIrFrameRendererSnapshot,
  type RenderIrFrameResult,
} from '@aelionsdk/renderer-worker';
import {
  EditingCommands,
  speculateProjectChange,
  TransactionEngine,
  TransactionHistory,
  type TransactionBuilder,
  type TransactionCommit,
} from '@aelionsdk/transaction';

import { SessionAudioController, projectAudioMastering } from './audio-controller.js';
import { createMasteredAudioRenderer } from './audio-mastering.js';
import { createAelionDiagnosticReport } from './diagnostic-report.js';
import { AelionPlayer } from './player.js';
import { normalizePreviewQuality } from './preview-quality.js';
import { defaultSchemas } from './default-schemas.js';
import { ExportJob } from './export-job.js';
import type {
  AelionAudioApi,
  AelionAudioMasteringOptions,
  AelionDiagnosticReport,
  AelionDiagnosticReportOptions,
  AelionExportApi,
  AelionExportJob,
  AelionExportJobSnapshot,
  AelionExportOptions,
  AelionInteractiveEdit,
  AelionInteractiveEditOptions,
  AelionFilmstripOptions,
  AelionFilmstripResult,
  AelionMediaApi,
  AelionMediaProvider,
  AelionThumbnailOptions,
  AelionProfileExportJob,
  AelionProfileExportOptions,
  AelionProfileExportResult,
  AelionRemoteExportJob,
  AelionRemoteExportOptions,
  AelionPreviewApi,
  AelionPreviewOptions,
  AelionSessionApi,
  AelionSessionEvent,
  AelionSessionEventOf,
  AelionSessionEventType,
  AelionSessionOptions,
  AelionSessionSnapshot,
  AelionSessionStats,
  AelionSessionState,
  AelionTransactionApi,
} from './types.js';

function unloaded(): Error {
  return new Error('Load an Aelion Project before using this session');
}

function channelCountForLayout(layout: string): number {
  if (layout === 'mono') return 1;
  if (layout === 'stereo') return 2;
  if (layout === '5.1') return 6;
  throw new RangeError(`Unsupported channel layout ${layout}`);
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function finiteValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function directOpaqueVisualSource(
  ir: RenderIr,
  timeUs: number,
):
  | {
      readonly assetId: string;
      readonly streamIndex: number;
      readonly sourceTimeUs: number;
    }
  | undefined {
  const state = evaluateVisualState(ir, timeUs);
  const active = state.clips[0];
  if (
    state.transition !== undefined ||
    state.clips.length !== 1 ||
    active?.clip.kind !== 'visual-clip' ||
    active.sourceTimeUs === null ||
    active.materials.length !== 0
  ) {
    return undefined;
  }
  const clip = active.clip;
  const visual = clip.visual;
  // `fit: 'none'` preserves source pixel dimensions and must never be bypassed into
  // a full-frame `sameDisplayAspect` resize.
  if (
    visual.fit === 'none' ||
    visual.blendMode !== 'normal' ||
    visual.mask !== undefined ||
    clip.materialInstanceIds.length !== 0
  ) {
    return undefined;
  }
  const evaluate = (value: import('@aelionsdk/core').JsonValue): unknown =>
    evaluateAnimatedValue(value, timeUs, clip.range.startUs);
  const transform = visual.transform;
  const position = objectValue(evaluate(transform.positionPx as import('@aelionsdk/core').JsonValue));
  const anchor = objectValue(evaluate(transform.anchor as import('@aelionsdk/core').JsonValue));
  const scale = objectValue(evaluate(transform.scale as import('@aelionsdk/core').JsonValue));
  const skew = objectValue(evaluate(transform.skewDeg as import('@aelionsdk/core').JsonValue));
  const crop = objectValue(evaluate(visual.crop as import('@aelionsdk/core').JsonValue));
  if (
    finiteValue(position.x, ir.width / 2) !== ir.width / 2 ||
    finiteValue(position.y, ir.height / 2) !== ir.height / 2 ||
    finiteValue(anchor.x, 0.5) !== 0.5 ||
    finiteValue(anchor.y, 0.5) !== 0.5 ||
    finiteValue(scale.x, 1) !== 1 ||
    finiteValue(scale.y, 1) !== 1 ||
    finiteValue(skew.x, 0) !== 0 ||
    finiteValue(skew.y, 0) !== 0 ||
    finiteValue(evaluate(transform.rotationDeg as import('@aelionsdk/core').JsonValue), 0) !== 0 ||
    finiteValue(evaluate(visual.opacity as import('@aelionsdk/core').JsonValue), 1) !== 1 ||
    finiteValue(crop.left, 0) !== 0 ||
    finiteValue(crop.top, 0) !== 0 ||
    finiteValue(crop.right, 0) !== 0 ||
    finiteValue(crop.bottom, 0) !== 0
  ) {
    return undefined;
  }
  return resolveMediaSourceFrame(clip.source, active.sourceTimeUs) ?? undefined;
}

function frameHasAlpha(frame: VideoFrame): boolean {
  return frame.format === 'I420A' || frame.format === 'RGBA' || frame.format === 'BGRA';
}

function sameDisplayAspect(widthA: number, heightA: number, widthB: number, heightB: number): boolean {
  return widthA > 0 && heightA > 0 && widthB > 0 && heightB > 0 && widthA * heightB === heightA * widthB;
}

const DEFAULT_MAX_DIAGNOSTICS = 256;

interface MutableOperationTiming {
  count: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  totalUs: number;
  maximumUs: number;
  lastUs: number | null;
}

function emptyOperationTiming(): MutableOperationTiming {
  return {
    count: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    totalUs: 0,
    maximumUs: 0,
    lastUs: null,
  };
}

function recordOperationTiming(
  timing: MutableOperationTiming,
  startedAt: number,
  outcome: 'succeeded' | 'failed' | 'cancelled',
): void {
  const durationUs = Math.max(0, Math.round((performance.now() - startedAt) * 1_000));
  timing.count += 1;
  timing[outcome] += 1;
  timing.totalUs += durationUs;
  timing.maximumUs = Math.max(timing.maximumUs, durationUs);
  timing.lastUs = durationUs;
}

function operationTimingSnapshot(timing: MutableOperationTiming) {
  return Object.freeze({ ...timing });
}

function diagnosticHistoryLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_MAX_DIAGNOSTICS;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError('maxDiagnostics must be a positive safe integer');
  }
  return limit;
}

interface ActiveInteractiveEdit {
  readonly id: string;
  readonly label?: string;
  readonly baseRevision?: bigint;
  active: boolean;
  updateCount: number;
}

export class AelionSession implements AelionSessionApi {
  readonly #options: AelionSessionOptions;
  readonly #validator: ProjectValidator;
  #compiler = new IncrementalRenderCompiler();
  #renderer: RenderIrFrameRenderer | undefined;
  #lastDisposedRenderer: RenderIrFrameRendererSnapshot | undefined;
  readonly #listeners = new Set<(event: AelionSessionEvent) => void>();
  #state: AelionSessionState = 'empty';
  #capability: Awaited<ReturnType<typeof probeCapabilities>> | undefined;
  readonly #diagnostics: Diagnostic[] = [];
  readonly #maxDiagnostics: number;
  #droppedDiagnostics = 0;
  #engine: TransactionEngine | undefined;
  #history: TransactionHistory | undefined;
  #commands: EditingCommands | undefined;
  #unsubscribeHistory: (() => void) | undefined;
  #ir: RenderIr | undefined;
  #compileStats: CompileStats | undefined;
  #speculationCompiler: IncrementalRenderCompiler | undefined;
  #speculationBase: IncrementalRenderCompiler | undefined;
  #speculationPreviousIds: readonly string[] = [];
  #transientMediaTail: Promise<unknown> = Promise.resolve();
  #transientMediaAbort = new AbortController();
  #sequenceId: string | undefined;
  #previewRequestedFrames = 0;
  #previewRenderedFrames = 0;
  #previewFailedFrames = 0;
  #lastPreviewBackend: 'webgpu' | 'webgl2' | undefined;
  #lastPreviewWidth: number | undefined;
  #lastPreviewHeight: number | undefined;
  #lastPreviewRenderScale: number | undefined;
  #lastPreviewTiming: import('@aelionsdk/renderer-worker').RendererWorkerTiming | undefined;
  #lastPreviewResources: import('@aelionsdk/renderer-worker').RendererWorkerResourceSnapshot | undefined;
  #exportJobsStarted = 0;
  #exportJobsCompleted = 0;
  #exportJobsFailed = 0;
  #exportJobsCancelled = 0;
  #activeExportJob: AelionExportJob | AelionProfileExportJob | AelionRemoteExportJob | undefined;
  #activeExportStartedAt: number | undefined;
  #nextExportJobId = 1;
  #loadGeneration = 0;
  #loadInProgress = 0;
  #loadTail: Promise<void> = Promise.resolve();
  #disposeTask: Promise<void> | undefined;
  #activeInteractiveEdit: ActiveInteractiveEdit | undefined;
  #nextInteractiveEditId = 1;
  readonly #operationTimings = {
    projectLoad: emptyOperationTiming(),
    capabilityProbe: emptyOperationTiming(),
    preview: emptyOperationTiming(),
    export: emptyOperationTiming(),
  };

  public readonly player: AelionPlayer;
  public readonly audio: AelionAudioApi;
  public readonly transaction: AelionTransactionApi;
  public readonly preview: AelionPreviewApi;
  public readonly media: AelionMediaApi;
  public readonly export: AelionExportApi;

  public constructor(options: AelionSessionOptions = {}) {
    this.#options = options;
    this.#maxDiagnostics = diagnosticHistoryLimit(options.maxDiagnostics);
    if (
      options.maxPendingFrames !== undefined &&
      (!Number.isSafeInteger(options.maxPendingFrames) || options.maxPendingFrames <= 0)
    ) {
      throw new RangeError('maxPendingFrames must be a positive safe integer');
    }
    this.#validator = new ProjectValidator({
      projectSchema: (options.schemas ?? defaultSchemas).project,
      materialInstanceSchema: (options.schemas ?? defaultSchemas).materialInstance,
      ...(options.skipAjvCompile === undefined ? {} : { skipAjvCompile: options.skipAjvCompile }),
      ...(options.schemaValidationMode === undefined ? {} : { schemaMode: options.schemaValidationMode }),
    });
    this.player = new AelionPlayer(this, (error: unknown) => this.#acceptPlayerError(error), options.runtimeAssets);
    this.audio = new SessionAudioController({
      ir: () => this.requireIr(),
      project: () => {
        const value = this.#engine?.getSnapshot();
        if (value === undefined) throw unloaded();
        return value;
      },
      media: () => this.requireMedia(),
      revision: () => {
        const value = this.revision;
        if (value === null) throw unloaded();
        return value;
      },
      edit: (label, callback) => this.#edit(callback, { label }),
    });
    this.preview = {
      renderFrame: (options) => this.#renderPreviewFrame(options),
    };
    this.media = {
      thumbnail: (mediaOptions) => this.#thumbnail(mediaOptions),
      filmstrip: (mediaOptions) => this.#filmstrip(mediaOptions),
    };
    const commands = (): EditingCommands => this.#requireCommands();
    const canUndo = (): boolean => this.#history?.state.canUndo ?? false;
    const canRedo = (): boolean => this.#history?.state.canRedo ?? false;
    this.transaction = {
      edit: (callback, editOptions = {}) => this.#edit(callback, editOptions),
      beginInteractive: (editOptions) => this.#beginInteractiveEdit(editOptions),
      undo: () => this.#undoChange(),
      redo: () => this.#redoChange(),
      get commands() {
        return commands();
      },
      get canUndo() {
        return canUndo();
      },
      get canRedo() {
        return canRedo();
      },
    };
    const activeExportJob = () => this.#activeExportJob ?? null;
    this.export = {
      preflight: (options) => this.#preflight(options),
      preflightProfile: (options) => this.#preflightProfile(options),
      negotiate: (options) => this.#negotiateExport(options),
      start: (options) => this.#startExport(options),
      startProfile: (options) => this.#startProfileExport(options),
      startRemote: (options) => this.#startRemoteExport(options),
      cancel: (reason) => this.#cancelExport(reason),
      get activeJob() {
        return activeExportJob();
      },
    };
  }

  public get state(): AelionSessionState {
    return this.#state;
  }

  public get revision(): bigint | null {
    return this.#engine?.revision ?? null;
  }

  public async loadProject(value: unknown): Promise<void> {
    const startedAt = performance.now();
    this.#assertActive();
    const validation = this.#validator.validate(value);
    if (!validation.ok) {
      for (const diagnostic of validation.diagnostics) this.#recordDiagnostic(diagnostic);
      recordOperationTiming(this.#operationTimings.projectLoad, startedAt, 'failed');
      throw new AelionError(validation.diagnostics);
    }

    const generation = this.#loadGeneration + 1;
    this.#loadGeneration = generation;
    this.#loadInProgress += 1;
    const task = this.#loadTail.then(() => this.#installProject(validation.value.project, generation));
    // Serialize reset/install work so a superseded load cannot finish resetting
    // Player resources after a newer Project has already become visible. Keep the
    // tail fulfilled so one failed/superseded load cannot block the next request.
    this.#loadTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task
      .then(
        () => recordOperationTiming(this.#operationTimings.projectLoad, startedAt, 'succeeded'),
        (error: unknown) => {
          recordOperationTiming(
            this.#operationTimings.projectLoad,
            startedAt,
            error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'failed',
          );
          throw error;
        },
      )
      .finally(() => {
        this.#loadInProgress -= 1;
      });
  }

  async #installProject(project: AelionProject, generation: number): Promise<void> {
    this.#assertLoadCurrent(generation);
    this.#invalidateInteractiveEdit();
    // Timeline decorations from the previous Project must not decode against
    // the new Project's IR or keep its media work alive after replacement.
    this.#transientMediaAbort.abort(new DOMException('Project media sampling was replaced', 'AbortError'));
    this.#transientMediaAbort = new AbortController();
    await this.player.reset();
    this.#assertLoadCurrent(generation);

    const engineRef: { current?: TransactionEngine } = {};
    const engine = new TransactionEngine(
      project,
      // `project` was admitted by `loadProject`, and TransactionBuilder admits
      // every caller-supplied operation payload, so a commit candidate is an
      // owned JSON snapshot by construction. Re-cloning the whole document here
      // dominated the cost of interactive edits — a drag commits once per frame.
      (candidate) => {
        const result = this.#validator.validateAdmitted(candidate);
        return { ok: result.ok, diagnostics: result.diagnostics };
      },
      {
        // `loadProject` validated this exact snapshot, and nothing else holds a
        // reference to it, so copying and revalidating it here would repeat the
        // most expensive half of opening a Project for no added guarantee.
        adoptValidatedProject: true,
        prepareCommit: (commit) => {
          const current = engineRef.current;
          if (current === undefined) throw new Error('Transaction engine is not installed');
          return this.#prepareCommit(current, commit);
        },
      },
    );
    engineRef.current = engine;
    const history = new TransactionHistory(engine);
    const commands = new EditingCommands({
      get revision() {
        return history.revision;
      },
      getSnapshot: () => history.getSnapshot(),
      subscribe: (listener) => history.subscribe(listener),
      edit: (editOptions, callback) => {
        this.#assertTransactionAvailable();
        if (this.#history !== history) throw new Error('Editing command belongs to a stale Project');
        if (this.#activeInteractiveEdit?.active === true) {
          throw new Error('Finish or cancel the active interactive edit before starting another edit');
        }
        return history.edit(editOptions, callback);
      },
    });
    const sequenceId = this.#options.sequenceId ?? project.settings.defaultSequenceId;
    const compiler = new IncrementalRenderCompiler();
    const compilation = compiler.compile(engine.getSnapshot(), sequenceId, engine.revision, {
      resolveMaterialProgram: (definition, parameters) =>
        this.#options.materials?.resolveProgram(definition, parameters),
    });
    // A synchronous host Material resolver may re-enter the Session and dispose
    // it (or request a newer load) while compilation is running.
    this.#assertLoadCurrent(generation);

    const unsubscribeHistory = history.subscribe((commit) => this.#publishCommit(engine, commit));
    this.#unsubscribeHistory?.();
    this.#engine = engine;
    this.#unsubscribeHistory = unsubscribeHistory;
    this.#history = history;
    this.#commands = commands;
    this.#sequenceId = sequenceId;
    this.#compiler = compiler;
    this.#compileStats = compilation.stats;
    this.#ir = compilation.ir;
    this.#setState('ready');
    // `state-changed` listeners are user callbacks and may synchronously dispose
    // the Session or request another Project. Roll back this just-installed
    // candidate before surfacing the stale load so no engine survives disposal.
    try {
      this.#assertLoadCurrent(generation);
    } catch (error) {
      unsubscribeHistory();
      if (this.#engine === engine) {
        this.#engine = undefined;
        this.#unsubscribeHistory = undefined;
        this.#history = undefined;
        this.#commands = undefined;
        this.#sequenceId = undefined;
        this.#ir = undefined;
        this.#compileStats = undefined;
      }
      throw error;
    }
    this.#emit({
      type: 'project-loaded',
      projectId: project.projectId,
      revision: engine.revision,
    });
  }

  public async renderFrame(options: AelionPreviewOptions) {
    return this.#renderPreviewFrame(options);
  }

  /**
   * Compiles a Project that has not been committed, reusing what did not change.
   *
   * Forked from the live compiler so speculation cannot disturb the committed
   * Render IR, and kept across calls so a drag recompiling on every pointer move
   * pays only for the clips the move actually touched.
   *
   * The declared ids are the union of this speculation's and the previous one's,
   * because the fork's baseline is whatever it last compiled. Every speculation
   * starts again from the committed Project, so the clips the previous one moved
   * have to be named as changed a second time in order to move back -- naming
   * only the current ones would leave them reused at a position the pointer has
   * already left.
   */
  #speculativeIr(overlay: (transaction: TransactionBuilder) => void): RenderIr {
    const engine = this.#engine;
    const sequenceId = this.#sequenceId;
    if (engine === undefined || sequenceId === undefined) throw unloaded();
    const project = engine.getSnapshot();
    const speculated = speculateProjectChange(project, overlay);
    if (speculated.project === project) return this.requireIr();
    if (this.#speculationBase !== this.#compiler || this.#speculationCompiler === undefined) {
      this.#speculationCompiler = this.#compiler.fork();
      this.#speculationBase = this.#compiler;
      this.#speculationPreviousIds = [];
    }
    const affectedEntityIds = [...new Set([...this.#speculationPreviousIds, ...speculated.affectedEntityIds])];
    this.#speculationPreviousIds = speculated.affectedEntityIds;
    return this.#speculationCompiler.compile(speculated.project as AelionProject, sequenceId, engine.revision, {
      affectedEntityIds,
      resolveMaterialProgram: (definition, parameters) =>
        this.#options.materials?.resolveProgram(definition, parameters),
    }).ir;
  }

  /**
   * A frame of nothing, at the Sequence's own size and background.
   *
   * An empty timeline is an ordinary state -- a new Project, or one whose last
   * clip was just deleted -- and asking for a frame of it is an ordinary
   * request. Throwing instead forces every host to special-case emptiness and
   * to suppress the resulting diagnostic, so preview answers with the picture
   * an empty Sequence actually has.
   */
  async #blankPreviewFrame(ir: RenderIr, renderScale: number): Promise<RenderIrFrameResult> {
    const width = Math.max(1, Math.round(ir.width * renderScale));
    const height = Math.max(1, Math.round(ir.height * renderScale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('OffscreenCanvas 2D context is unavailable');
    const raw: unknown = objectValue(ir.backgroundColor).rgba;
    const rgba: readonly unknown[] = Array.isArray(raw) ? (raw as readonly unknown[]) : [];
    const component = (index: number): number => {
      const value = rgba[index];
      return typeof value === 'number' && Number.isFinite(value) ? value : index === 3 ? 1 : 0;
    };
    const channel = (index: number): number => Math.round(Math.min(1, Math.max(0, component(index))) * 255);
    context.fillStyle = `rgba(${channel(0)}, ${channel(1)}, ${channel(2)}, ${component(3)})`;
    context.fillRect(0, 0, width, height);
    return {
      bitmap: await createImageBitmap(canvas),
      backend:
        this.#renderer?.snapshot().adaptiveBackend.selected ??
        (this.#options.preferredBackend === 'webgpu' ? 'webgpu' : 'webgl2'),
      materialIds: [],
      width,
      height,
      renderScale,
    };
  }

  /**
   * Runs a transient decode after every other transient decode.
   *
   * Filmstrips and thumbnails are speculative work for parts of the UI nobody
   * is staring at, and they share the media pipeline with the frame the user
   * *is* staring at. Serialising them keeps a burst of clip strips from
   * saturating the decoder, and `transient` keeps them off the persistent
   * playback decoder entirely -- aborting them there would otherwise leave its
   * serial queue walking toward a late timestamp and freeze preview.
   */
  #transientDecode<T>(work: () => Promise<T>): Promise<T> {
    const task = this.#transientMediaTail.then(work, work);
    this.#transientMediaTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  #transientSignal(signal: AbortSignal | undefined): AbortSignal {
    const sessionSignal = this.#transientMediaAbort.signal;
    return signal === undefined ? sessionSignal : AbortSignal.any([signal, sessionSignal]);
  }

  static #fit(frame: VideoFrame, maxDimension: number): { readonly width: number; readonly height: number } {
    const sourceWidth = Math.max(1, frame.displayWidth);
    const sourceHeight = Math.max(1, frame.displayHeight);
    const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
    return {
      width: Math.max(1, Math.round(sourceWidth * scale)),
      height: Math.max(1, Math.round(sourceHeight * scale)),
    };
  }

  async #thumbnail(options: AelionThumbnailOptions): Promise<ImageBitmap> {
    const media = this.requireMedia();
    const maxDimension = options.maxDimension ?? 320;
    if (!Number.isFinite(maxDimension) || maxDimension <= 0 || maxDimension > 8_192) {
      throw new RangeError('maxDimension must be from 1 to 8192');
    }
    if (
      options.sourceTimeUs !== undefined &&
      (!Number.isSafeInteger(options.sourceTimeUs) || options.sourceTimeUs < 0)
    ) {
      throw new RangeError('sourceTimeUs must be a non-negative safe integer');
    }
    if (options.streamIndex !== undefined && (!Number.isSafeInteger(options.streamIndex) || options.streamIndex < 0)) {
      throw new RangeError('streamIndex must be a non-negative safe integer');
    }
    const signal = this.#transientSignal(options.signal);
    const frame = await this.#transientDecode(() => {
      signal.throwIfAborted();
      return media.frameAt(options.assetId, options.streamIndex ?? 0, options.sourceTimeUs ?? 0, signal, {
        purpose: 'preview',
        maxDimension,
        transient: true,
      });
    });
    try {
      const size = AelionSession.#fit(frame, maxDimension);
      const bitmap = await createImageBitmap(frame, {
        resizeWidth: size.width,
        resizeHeight: size.height,
        resizeQuality: 'medium',
      });
      if (signal.aborted) {
        bitmap.close();
        signal.throwIfAborted();
      }
      return bitmap;
    } finally {
      frame.close();
    }
  }

  async #filmstrip(options: AelionFilmstripOptions): Promise<AelionFilmstripResult> {
    const ir = this.requireIr();
    const media = this.requireMedia();
    if (!Number.isSafeInteger(options.count) || options.count < 1 || options.count > 128) {
      throw new RangeError('count must be an integer from 1 to 128');
    }
    const count = options.count;
    const requestedHeight = options.frameHeight ?? 64;
    if (!Number.isFinite(requestedHeight) || requestedHeight < 1 || requestedHeight > 512) {
      throw new RangeError('frameHeight must be from 1 to 512');
    }
    const frameHeight = Math.round(requestedHeight);
    const signal = this.#transientSignal(options.signal);
    const clip = ir.tracks.flatMap((track) => track.clips).find((candidate) => candidate.id === options.itemId);
    if (clip === undefined || clip.kind !== 'visual-clip') {
      throw new RangeError(`Item ${options.itemId} is not a sampleable visual clip`);
    }

    // Sampled through the clip's own time mapping rather than by adding to its
    // source in-point, so a retimed or reversed clip shows the frames it
    // actually plays.
    const timesUs: number[] = [];
    const decoded: { readonly timeUs: number; readonly frame: VideoFrame }[] = [];
    const step = clip.range.durationUs / count;
    try {
      for (let index = 0; index < count; index += 1) {
        signal.throwIfAborted();
        const timeUs = Math.round(clip.range.startUs + step * (index + 0.5));
        const sourceTimeUs = mapClipSourceTime(clip, timeUs);
        if (sourceTimeUs === null) continue;
        const resolved = resolveMediaSourceFrame(clip.source, sourceTimeUs);
        if (resolved === null) continue;
        const frame = await this.#transientDecode(() =>
          media.frameAt(resolved.assetId, resolved.streamIndex, resolved.sourceTimeUs, signal, {
            purpose: 'preview',
            maxDimension: frameHeight * 4,
            transient: true,
          }),
        );
        decoded.push({ timeUs, frame });
        timesUs.push(timeUs);
        if (decoded.length === 1) {
          const firstWidth = Math.max(
            1,
            Math.round(frameHeight * (Math.max(1, frame.displayWidth) / Math.max(1, frame.displayHeight))),
          );
          if (firstWidth * count > 32_768 || firstWidth * frameHeight * count > 32_000_000) {
            throw new RangeError('filmstrip output exceeds the 32768px / 32MP resource budget');
          }
        }
      }
      const first = decoded[0]?.frame;
      if (first === undefined) throw new RangeError(`Item ${options.itemId} decoded no frames`);
      const aspect = Math.max(1, first.displayWidth) / Math.max(1, first.displayHeight);
      const frameWidth = Math.max(1, Math.round(frameHeight * aspect));
      const canvas = new OffscreenCanvas(frameWidth * decoded.length, frameHeight);
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('OffscreenCanvas 2D context is unavailable');
      decoded.forEach((entry, index) => {
        context.drawImage(entry.frame, index * frameWidth, 0, frameWidth, frameHeight);
      });
      signal.throwIfAborted();
      const bitmap = await createImageBitmap(canvas);
      if (signal.aborted) {
        bitmap.close();
        signal.throwIfAborted();
      }
      return {
        itemId: options.itemId,
        bitmap,
        frameWidth,
        frameHeight,
        frameCount: decoded.length,
        timesUs,
      };
    } finally {
      for (const entry of decoded) entry.frame.close();
    }
  }

  async #renderPreviewFrame(options: AelionPreviewOptions) {
    const startedAt = performance.now();
    this.#previewRequestedFrames += 1;
    this.#emitStats();
    try {
      const ir = options.overlay === undefined ? this.requireIr() : this.#speculativeIr(options.overlay);
      const media = this.#options.media;
      if (media === undefined) throw new Error('AelionSession requires a media provider to render');
      const previewQuality = normalizePreviewQuality(options);
      if (!Number.isFinite(options.timeUs) || options.timeUs < 0) {
        throw new RangeError('timeUs must be a non-negative finite number');
      }
      if (ir.durationUs <= 0) {
        options.signal?.throwIfAborted();
        const blank = await this.#blankPreviewFrame(ir, previewQuality.renderScale);
        if (options.signal?.aborted === true) {
          blank.bitmap.close();
          options.signal.throwIfAborted();
        }
        this.#previewRenderedFrames += 1;
        recordOperationTiming(this.#operationTimings.preview, startedAt, 'succeeded');
        this.#emitStats();
        return blank;
      }
      // Preview clamps rather than refuses. A playhead parked on the last frame
      // and a Sequence that just got shorter are both normal, and a host that
      // has to clamp for itself ends up filtering the diagnostic this would
      // otherwise raise on an ordinary redraw.
      const timeUs = Math.min(Math.round(options.timeUs), ir.durationUs - 1);
      options = { ...options, timeUs };
      // Export already skips the compositor for a single untransformed opaque
      // clip; preview is the path that runs it sixty times a second. Only taken
      // at full scale, where the composited output would be the same size, so
      // the result the caller sees is unchanged apart from the frame's origin.
      if (previewQuality.renderScale >= 1) {
        const direct = await this.#takeDirectFrame(ir, media, options.timeUs, 'preview', options.signal);
        if (direct !== undefined) {
          // Ownership moves into the result; the consumer closes it.
          return this.#directPreviewResult(direct, options.signal);
        }
      }
      const result = await this.#requireRenderer().render({
        ir,
        timeUs: options.timeUs,
        source: media,
        mode: 'preview',
        preferredBackend: this.#options.preferredBackend ?? 'auto',
        allowFallback: this.#options.allowBackendFallback ?? true,
        renderScale: previewQuality.renderScale,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      this.#previewRenderedFrames += 1;
      this.#lastPreviewBackend = result.backend;
      this.#lastPreviewWidth = result.width;
      this.#lastPreviewHeight = result.height;
      this.#lastPreviewRenderScale = result.renderScale;
      this.#lastPreviewTiming = result.timing;
      this.#lastPreviewResources = result.resources;
      recordOperationTiming(this.#operationTimings.preview, startedAt, 'succeeded');
      this.#emitStats();
      return result;
    } catch (error) {
      this.#previewFailedFrames += 1;
      recordOperationTiming(
        this.#operationTimings.preview,
        startedAt,
        error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'failed',
      );
      this.#recordErrorDiagnostics(error);
      this.#emitStats();
      throw error;
    }
  }

  public async probeCapabilities(signal?: AbortSignal) {
    const startedAt = performance.now();
    this.#assertActive();
    try {
      const capability = await probeCapabilities(signal === undefined ? {} : { signal });
      this.#capability = capability;
      for (const diagnostic of capability.diagnostics) this.#recordDiagnostic(diagnostic);
      recordOperationTiming(this.#operationTimings.capabilityProbe, startedAt, 'succeeded');
      this.#emit({ type: 'capability-changed', capability });
      return capability;
    } catch (error) {
      recordOperationTiming(
        this.#operationTimings.capabilityProbe,
        startedAt,
        error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'failed',
      );
      throw error;
    }
  }

  public getSnapshot(): AelionSessionSnapshot {
    return Object.freeze({
      state: this.#state,
      revision: this.revision,
      project: this.#engine?.getSnapshot() ?? null,
      renderIr: this.#ir ?? null,
      capability: this.#capability ?? null,
      diagnostics: this.getDiagnostics(),
      stats: this.getStats(),
    });
  }

  public getCapabilitySnapshot() {
    return this.#capability ?? null;
  }

  public getDiagnostics(): readonly Diagnostic[] {
    return Object.freeze([...this.#diagnostics]);
  }

  public createDiagnosticReport(options?: AelionDiagnosticReportOptions): AelionDiagnosticReport {
    let media: JsonObject | null = null;
    try {
      media = this.#options.media?.getDiagnosticSnapshot?.() ?? null;
    } catch {
      // Support report generation must remain available when a custom media
      // provider's optional inspection hook is itself unhealthy.
    }
    return createAelionDiagnosticReport({
      state: this.#state,
      revision: this.revision,
      capability: this.#capability ?? null,
      diagnostics: this.getDiagnostics(),
      stats: this.getStats(),
      media,
      ...(options === undefined ? {} : { options }),
    });
  }

  public getStats(): AelionSessionStats {
    const active = this.#activeExportJob?.getSnapshot();
    const renderer = this.#renderer?.snapshot();
    return Object.freeze({
      schemaVersion: '1.0.0' as const,
      revision: this.revision,
      diagnostics: Object.freeze({
        retained: this.#diagnostics.length,
        dropped: this.#droppedDiagnostics,
        limit: this.#maxDiagnostics,
      }),
      compile: this.#compileStats ?? null,
      preview: Object.freeze({
        requestedFrames: this.#previewRequestedFrames,
        renderedFrames: this.#previewRenderedFrames,
        failedFrames: this.#previewFailedFrames,
        lastBackend: this.#lastPreviewBackend ?? null,
        lastWidth: this.#lastPreviewWidth ?? null,
        lastHeight: this.#lastPreviewHeight ?? null,
        lastRenderScale: this.#lastPreviewRenderScale ?? null,
        lastTiming: this.#lastPreviewTiming ?? null,
        lastResources: this.#lastPreviewResources ?? null,
        pendingFrames: renderer?.pendingFrames ?? 0,
        maxPendingFrames: renderer?.maxPendingFrames ?? this.#options.maxPendingFrames ?? 2,
        rendererPresent: renderer !== undefined,
        rendererDisposed: renderer?.disposed ?? true,
        workerPendingRequests: renderer?.worker.pendingRequests ?? 0,
        workerActiveRequests: renderer?.worker.activeRequests ?? 0,
        workerCancelledRequests: renderer?.worker.cancelledRequests ?? 0,
        lastDisposedRenderer:
          this.#lastDisposedRenderer === undefined
            ? null
            : Object.freeze({
                disposed: this.#lastDisposedRenderer.disposed,
                pendingFrames: this.#lastDisposedRenderer.pendingFrames,
                workerDisposed: this.#lastDisposedRenderer.worker.disposed,
                workerPendingRequests: this.#lastDisposedRenderer.worker.pendingRequests,
                workerActiveRequests: this.#lastDisposedRenderer.worker.activeRequests,
                workerCancelledRequests: this.#lastDisposedRenderer.worker.cancelledRequests,
              }),
      }),
      player: this.player.getStats(),
      export: Object.freeze({
        jobsStarted: this.#exportJobsStarted,
        jobsCompleted: this.#exportJobsCompleted,
        jobsFailed: this.#exportJobsFailed,
        jobsCancelled: this.#exportJobsCancelled,
        activeJobId: active?.id ?? null,
        progress: active?.progress ?? 0,
      }),
      timings: Object.freeze({
        projectLoad: operationTimingSnapshot(this.#operationTimings.projectLoad),
        capabilityProbe: operationTimingSnapshot(this.#operationTimings.capabilityProbe),
        preview: operationTimingSnapshot(this.#operationTimings.preview),
        export: operationTimingSnapshot(this.#operationTimings.export),
      }),
    });
  }

  public subscribe(listener: (event: AelionSessionEvent) => void): () => void;
  public subscribe<T extends AelionSessionEventType>(
    type: T,
    listener: (event: AelionSessionEventOf<T>) => void,
  ): () => void;
  public subscribe<T extends AelionSessionEventType>(
    typeOrListener: T | ((event: AelionSessionEvent) => void),
    typedListener?: (event: AelionSessionEventOf<T>) => void,
  ): () => void {
    this.#assertActive();
    const listener: (event: AelionSessionEvent) => void =
      typeof typeOrListener === 'function'
        ? typeOrListener
        : (event) => {
            if (event.type === typeOrListener) typedListener?.(event as AelionSessionEventOf<T>);
          };
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public dispose(): Promise<void> {
    const existing = this.#disposeTask;
    if (existing !== undefined) return existing;

    let resolveTask!: () => void;
    let rejectTask!: (reason?: unknown) => void;
    const task = new Promise<void>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    // Publish the task before cleanup emits `state-changed`; a listener may call
    // dispose() re-entrantly and must receive this exact Promise.
    this.#disposeTask = task;
    void this.#dispose().then(resolveTask, rejectTask);
    return task;
  }

  async #dispose(): Promise<void> {
    this.#loadGeneration += 1;
    this.#invalidateInteractiveEdit();
    const drainLoads = this.#loadTail.then(
      () => undefined,
      () => undefined,
    );
    const renderer = this.#renderer;
    const cancelExport = this.#cancelExport(new DOMException('AelionSession disposed', 'AbortError'));
    this.#transientMediaAbort.abort(new DOMException('AelionSession disposed', 'AbortError'));
    const drainTransientMedia = this.#transientMediaTail.then(
      () => undefined,
      () => undefined,
    );
    this.#setState('disposed');
    this.#listeners.clear();
    this.#unsubscribeHistory?.();
    this.#unsubscribeHistory = undefined;
    this.#engine = undefined;
    this.#history = undefined;
    this.#commands = undefined;
    this.#ir = undefined;
    this.#compileStats = undefined;
    this.#sequenceId = undefined;
    this.#compiler.clear();
    const results = await Promise.allSettled([
      cancelExport,
      this.player.dispose(),
      drainLoads,
      drainTransientMedia,
      ...(renderer === undefined ? [] : [renderer.dispose()]),
    ]);
    if (renderer !== undefined) this.#lastDisposedRenderer = renderer.snapshot();
    this.#renderer = undefined;
    const errors: unknown[] = [];
    for (const result of results) {
      if (result.status === 'rejected') errors.push(result.reason as unknown);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'One or more AelionSession resources failed to dispose');
    }
  }

  public requireIr(): RenderIr {
    this.#assertActive();
    if (this.#ir === undefined) throw unloaded();
    return this.#ir;
  }

  public requireMedia() {
    const media = this.#options.media;
    if (media === undefined) throw new Error('AelionSession requires a media provider');
    return media;
  }

  public notifyStatsChanged(): void {
    if (this.#state !== 'disposed') this.#emitStats();
  }

  #edit(
    callback: (transaction: TransactionBuilder) => void,
    options: { readonly label?: string; readonly baseRevision?: bigint },
  ): TransactionCommit {
    this.#assertTransactionAvailable();
    if (this.#activeInteractiveEdit?.active === true) {
      throw new Error('Finish or cancel the active interactive edit before starting another edit');
    }
    const history = this.#history;
    if (history === undefined) throw unloaded();
    return history.edit(
      {
        ...(options.label === undefined ? {} : { label: options.label }),
        ...(options.baseRevision === undefined ? {} : { baseRevision: options.baseRevision }),
      },
      callback,
    );
  }

  #beginInteractiveEdit(options: AelionInteractiveEditOptions = {}): AelionInteractiveEdit {
    this.#assertTransactionAvailable();
    if (this.#activeInteractiveEdit?.active === true) {
      throw new Error('An interactive edit is already active');
    }
    const state: ActiveInteractiveEdit = {
      id: `interactive_${this.#nextInteractiveEditId.toString()}`,
      ...(options.label === undefined ? {} : { label: options.label }),
      ...(options.baseRevision === undefined ? {} : { baseRevision: options.baseRevision }),
      active: true,
      updateCount: 0,
    };
    this.#nextInteractiveEditId += 1;
    this.#activeInteractiveEdit = state;
    const isActive = (): boolean => state.active && this.#activeInteractiveEdit === state;
    return Object.freeze({
      get active() {
        return isActive();
      },
      get updateCount() {
        return state.updateCount;
      },
      update: (callback: (transaction: TransactionBuilder) => void) => this.#updateInteractiveEdit(state, callback),
      commit: () => this.#finishInteractiveEdit(state),
      cancel: () => this.#cancelInteractiveEdit(state),
    });
  }

  #updateInteractiveEdit(
    state: ActiveInteractiveEdit,
    callback: (transaction: TransactionBuilder) => void,
  ): TransactionCommit {
    this.#assertInteractiveEditActive(state);
    const history = this.#history;
    if (history === undefined) throw unloaded();
    const commit = history.edit(
      {
        ...(state.label === undefined ? {} : { label: state.label }),
        ...(state.updateCount === 0 && state.baseRevision !== undefined ? { baseRevision: state.baseRevision } : {}),
        historyGroup: state.id,
      },
      callback,
    );
    state.updateCount += 1;
    return commit;
  }

  #finishInteractiveEdit(state: ActiveInteractiveEdit): void {
    this.#assertInteractiveEditActive(state);
    this.#history?.finishGroup(state.id);
    state.active = false;
    this.#activeInteractiveEdit = undefined;
  }

  #cancelInteractiveEdit(state: ActiveInteractiveEdit): TransactionCommit | null {
    this.#assertInteractiveEditActive(state);
    const history = this.#history;
    if (history === undefined) throw unloaded();
    const commit = state.updateCount === 0 ? null : history.cancelGroup(state.id);
    state.active = false;
    this.#activeInteractiveEdit = undefined;
    return commit;
  }

  #assertInteractiveEditActive(state: ActiveInteractiveEdit): void {
    this.#assertTransactionAvailable();
    if (!state.active || this.#activeInteractiveEdit !== state) {
      throw new Error('Interactive edit is no longer active');
    }
  }

  #invalidateInteractiveEdit(): void {
    if (this.#activeInteractiveEdit !== undefined) this.#activeInteractiveEdit.active = false;
    this.#activeInteractiveEdit = undefined;
  }

  #undoChange(): TransactionCommit {
    this.#assertTransactionAvailable();
    if (this.#activeInteractiveEdit?.active === true) {
      throw new Error('Finish or cancel the active interactive edit before undo');
    }
    const history = this.#history;
    if (history === undefined) throw unloaded();
    return history.undo();
  }

  #redoChange(): TransactionCommit {
    this.#assertTransactionAvailable();
    if (this.#activeInteractiveEdit?.active === true) {
      throw new Error('Finish or cancel the active interactive edit before redo');
    }
    const history = this.#history;
    if (history === undefined) throw unloaded();
    return history.redo();
  }

  #prepareCommit(engine: TransactionEngine, commit: TransactionCommit): { publish(): void } {
    this.#assertPreparedCommitCurrent(engine, commit.changeSet.baseRevision);
    const sequenceId = this.#sequenceId;
    if (sequenceId === undefined) throw unloaded();
    const baseCompiler = this.#compiler;
    const compiler = baseCompiler.fork();
    const compilation = compiler.compile(commit.snapshot as AelionProject, sequenceId, commit.revision, {
      affectedEntityIds: commit.changeSet.affectedEntityIds,
      affectedRanges: commit.changeSet.affectedRanges,
      resolveMaterialProgram: (definition, parameters) =>
        this.#options.materials?.resolveProgram(definition, parameters),
    });
    this.#assertPreparedCommitCurrent(engine, commit.changeSet.baseRevision);
    let published = false;
    return {
      publish: () => {
        if (published) throw new Error('Prepared Render IR commit was already published');
        this.#assertPreparedCommitCurrent(engine, commit.changeSet.baseRevision);
        if (this.#compiler !== baseCompiler) {
          throw new Error('Prepared Render IR compiler baseline is stale');
        }
        published = true;
        this.#compiler = compiler;
        this.#compileStats = compilation.stats;
        this.#ir = compilation.ir;
      },
    };
  }

  #publishCommit(engine: TransactionEngine, commit: TransactionCommit): void {
    if (!this.#isCurrentEngine(engine, commit.revision)) return;
    this.#emit({ type: 'project-changed', commit });
    if (!this.#isCurrentEngine(engine, commit.revision)) return;
    this.player.invalidate(commit.changeSet);
  }

  #assertTransactionAvailable(): void {
    this.#assertActive();
    if (this.#loadInProgress > 0) {
      throw new Error('AelionSession Project transactions are unavailable while a load is pending');
    }
  }

  #assertPreparedCommitCurrent(engine: TransactionEngine, baseRevision: bigint): void {
    this.#assertActive();
    if (this.#engine !== engine || engine.revision !== baseRevision || this.#loadInProgress > 0) {
      throw new DOMException('AelionSession transaction was superseded', 'AbortError');
    }
  }

  #isCurrentEngine(engine: TransactionEngine, revision: bigint): boolean {
    return (
      this.#state !== 'disposed' &&
      this.#engine === engine &&
      this.#loadInProgress === 0 &&
      engine.revision === revision &&
      this.#ir?.revision === revision
    );
  }

  #frozenExportOptions(
    options: AelionExportOptions,
    signal = options.signal,
    onProgress = options.onProgress,
    masteredRenderAudio?: (
      request: {
        readonly startFrame: number;
        readonly frameCount: number;
        readonly channelCount: number;
      },
      signal?: AbortSignal,
    ) => Promise<Float32Array>,
    frozen?: {
      readonly ir: RenderIr;
      readonly media: AelionMediaProvider;
    },
  ): FrozenWebMExportOptions {
    const ir = frozen?.ir ?? this.requireIr();
    const media = frozen?.media ?? this.requireMedia();
    return {
      ir,
      projectRevision: ir.revision,
      videoBitrate: options.videoBitrate ?? 8_000_000,
      audioBitrate: options.audioBitrate ?? 192_000,
      ...(this.#options.runtimeAssets?.exportWorker === undefined
        ? {}
        : { workerUrl: this.#options.runtimeAssets.exportWorker }),
      ...(options.execution === undefined ? {} : { execution: options.execution }),
      sink: options.sink,
      renderFrame: (request) => this.#renderExportFrame(ir, media, request, signal),
      renderAudio:
        masteredRenderAudio ??
        ((request) =>
          renderIrAudio({
            ir,
            startFrame: request.startFrame,
            frameCount: request.frameCount,
            channelCount: request.channelCount,
            source: media,
            ...(signal === undefined ? {} : { signal }),
          })),
      ...(signal === undefined ? {} : { signal }),
      ...(options.cleanupSink === undefined ? {} : { cleanupSink: options.cleanupSink }),
      ...(onProgress === undefined ? {} : { onProgress }),
    };
  }

  async #preflight(options: AelionExportOptions) {
    const report = await preflightWebMExport(this.#frozenExportOptions(options));
    for (const diagnostic of report.issues) this.#recordDiagnostic(diagnostic);
    return report;
  }

  async #createExportAudioRenderer(
    ir: RenderIr,
    source: AelionMediaProvider,
    processing: AelionAudioMasteringOptions | undefined,
    signal: AbortSignal,
  ) {
    return createMasteredAudioRenderer({
      ir,
      source,
      ...(processing === undefined ? {} : { processing }),
      signal,
    });
  }

  /**
   * Decodes the frame for a Project that is one untransformed opaque clip, so
   * compositing can be skipped entirely.
   *
   * Returns an opaque frame already at the composition size. A source that
   * already matches is used as-is. A same-aspect source is scaled to the frame
   * so `fit` stays a no-op without sending the encoder the wrong resolution —
   * the hole the previous `fit === 'fill'` test left open.
   *
   * Ownership transfers to the caller; `undefined` means nothing was retained.
   */
  async #takeDirectFrame(
    ir: RenderIr,
    media: AelionMediaProvider,
    timeUs: number,
    purpose: 'preview' | 'export',
    signal?: AbortSignal,
  ): Promise<VideoFrame | undefined> {
    const direct = directOpaqueVisualSource(ir, timeUs);
    if (direct === undefined) return undefined;
    const source = await media.frameAt(direct.assetId, direct.streamIndex, direct.sourceTimeUs, signal, {
      purpose,
      maxDimension: Math.max(ir.width, ir.height),
    });
    if (frameHasAlpha(source)) {
      source.close();
      return undefined;
    }
    if (source.displayWidth === ir.width && source.displayHeight === ir.height) {
      return source;
    }
    if (sameDisplayAspect(source.displayWidth, source.displayHeight, ir.width, ir.height)) {
      const duration = source.duration;
      const timestamp = source.timestamp;
      try {
        const bitmap = await createImageBitmap(source, {
          resizeWidth: ir.width,
          resizeHeight: ir.height,
          resizeQuality: purpose === 'export' ? 'high' : 'medium',
        });
        try {
          return new VideoFrame(bitmap, {
            timestamp,
            ...(duration === null ? {} : { duration }),
          });
        } finally {
          bitmap.close();
        }
      } finally {
        source.close();
      }
    }
    source.close();
    return undefined;
  }

  /**
   * Wraps a bypassed source frame as a preview result.
   *
   * `backend` reports the backend the compositor would have selected: no pass
   * ran, and there is no worker timing to report, so `timing` and `resources`
   * stay absent. The renderer is not instantiated for this path, so a Project
   * that only ever bypasses never starts a compositor Worker.
   */
  #directPreviewResult(
    frame: VideoFrame,
    signal?: AbortSignal,
  ): import('@aelionsdk/renderer-worker').RenderIrFrameResult {
    if (signal?.aborted === true) {
      frame.close();
      throw new DOMException('Preview frame was aborted', 'AbortError');
    }
    return {
      bitmap: frame,
      backend:
        this.#renderer?.snapshot().adaptiveBackend.selected ??
        (this.#options.preferredBackend === 'webgpu' ? 'webgpu' : 'webgl2'),
      materialIds: [],
      width: frame.displayWidth,
      height: frame.displayHeight,
      renderScale: 1,
    };
  }

  async #renderExportFrame(
    ir: RenderIr,
    media: AelionMediaProvider,
    request: { readonly timestampUs: number; readonly durationUs: number },
    signal?: AbortSignal,
  ): Promise<VideoFrame> {
    const direct = await this.#takeDirectFrame(ir, media, request.timestampUs, 'export', signal);
    if (direct !== undefined) {
      try {
        return new VideoFrame(direct, {
          timestamp: request.timestampUs,
          duration: request.durationUs,
        });
      } finally {
        direct.close();
      }
    }
    const rendered = await this.#requireRenderer().render({
      ir,
      timeUs: request.timestampUs,
      source: media,
      mode: 'export',
      preferredBackend: this.#options.preferredBackend ?? 'auto',
      allowFallback: this.#options.allowBackendFallback ?? true,
      ...(signal === undefined ? {} : { signal }),
    });
    try {
      return new VideoFrame(rendered.bitmap, {
        timestamp: request.timestampUs,
        duration: request.durationUs,
      });
    } finally {
      rendered.bitmap.close();
    }
  }

  async #preflightProfile(options: AelionProfileExportOptions) {
    const ir = this.requireIr();
    const report = await preflightProfileExport({
      ir,
      projectRevision: ir.revision,
      profile: options.profile,
      sink: options.sink,
      ...('videoBitrate' in options ? { videoBitrate: options.videoBitrate } : {}),
      ...('audioBitrate' in options ? { audioBitrate: options.audioBitrate } : {}),
    });
    for (const diagnostic of report.issues) this.#recordDiagnostic(diagnostic);
    return report;
  }

  async #negotiateExport(options: Parameters<typeof selectExportProfile>[0]) {
    const ir = this.requireIr();
    return selectExportProfile({
      ...options,
      width: ir.width,
      height: ir.height,
      framerate: ir.frameRate.numerator / ir.frameRate.denominator,
      sampleRate: ir.sampleRate,
      numberOfChannels: channelCountForLayout(ir.channelLayout),
    });
  }

  #startExport(options: AelionExportOptions): AelionExportJob {
    this.#assertActive();
    if (this.#activeExportJob?.state === 'running') {
      const diagnostics: readonly Diagnostic[] = [
        {
          code: 'EXPORT_JOB_ACTIVE',
          severity: 'error',
          message: 'AelionSession supports one active export; cancel it before starting another',
          recoverable: true,
        },
      ];
      for (const diagnostic of diagnostics) this.#recordDiagnostic(diagnostic);
      throw new AelionError(diagnostics);
    }
    const ir = this.requireIr();
    const media = this.requireMedia();
    const project = this.#engine?.getSnapshot();
    if (project === undefined) throw unloaded();
    const configuredProcessing = options.audioProcessing ?? projectAudioMastering(project, ir.sequenceId);
    const processing = configuredProcessing === undefined ? undefined : structuredClone(configuredProcessing);
    const id = `export-${this.#nextExportJobId.toString()}`;
    this.#nextExportJobId += 1;
    this.#exportJobsStarted += 1;
    this.#activeExportStartedAt = performance.now();
    const job = new ExportJob({
      id,
      ...(options.signal === undefined ? {} : { externalSignal: options.signal }),
      run: async (signal, updateProgress) => {
        try {
          const mastering = await this.#createExportAudioRenderer(ir, media, processing, signal);
          return await exportFrozenRenderIrWebM(
            this.#frozenExportOptions(
              options,
              signal,
              (progress) => {
                updateProgress(progress);
                options.onProgress?.(progress);
              },
              mastering.render,
              { ir, media },
            ),
          );
        } catch (error) {
          // Publish structured export diagnostics before the await-compatible
          // job rejects so callers observe one deterministic Session state.
          this.#recordErrorDiagnostics(error);
          throw error;
        }
      },
      onSnapshot: (snapshot) => this.#acceptExportSnapshot(snapshot),
      onSettled: (settled) => this.#acceptExportSettled(settled),
    });
    this.#activeExportJob = job;
    this.#emitStats();
    return job;
  }

  #startProfileExport(options: AelionProfileExportOptions): AelionProfileExportJob {
    this.#assertActive();
    if (this.#activeExportJob?.state === 'running') {
      const diagnostic: Diagnostic = {
        code: 'EXPORT_JOB_ACTIVE',
        severity: 'error',
        message: 'AelionSession supports one active export; cancel it before starting another',
        recoverable: true,
      };
      this.#recordDiagnostic(diagnostic);
      throw new AelionError([diagnostic]);
    }
    const ir = this.requireIr();
    const media = this.requireMedia();
    const project = this.#engine?.getSnapshot();
    if (project === undefined) throw unloaded();
    const configuredProcessing = options.audioProcessing ?? projectAudioMastering(project, ir.sequenceId);
    const processing = configuredProcessing === undefined ? undefined : structuredClone(configuredProcessing);
    const id = `export-${this.#nextExportJobId.toString()}`;
    this.#nextExportJobId += 1;
    this.#exportJobsStarted += 1;
    this.#activeExportStartedAt = performance.now();
    const job = new ExportJob<AelionProfileExportResult>({
      id,
      ...(options.signal === undefined ? {} : { externalSignal: options.signal }),
      run: async (signal, updateProgress) => {
        const onProgress = (progress: number): void => {
          updateProgress(progress);
          options.onProgress?.(progress);
        };
        const cleanup = options.cleanupSink;
        const renderFrame = (request: {
          readonly timestampUs: number;
          readonly durationUs: number;
        }): Promise<VideoFrame> => this.#renderExportFrame(ir, media, request, signal);
        let mastering: Awaited<ReturnType<typeof createMasteredAudioRenderer>> | undefined;
        const requireMastering = async () => {
          mastering ??= await this.#createExportAudioRenderer(ir, media, processing, signal);
          return mastering;
        };
        const renderAudio = async (request: {
          readonly startFrame: number;
          readonly frameCount: number;
          readonly channelCount: number;
        }) => (await requireMastering()).render(request, signal);
        try {
          if (
            options.profile === 'webm-vp9-opus' ||
            options.profile === 'mp4-h264-aac' ||
            options.profile === 'mp4-av1-aac' ||
            options.profile === 'mp4-hevc-aac'
          ) {
            const frozen = this.#frozenExportOptions(
              {
                sink: options.sink,
                ...(options.videoBitrate === undefined ? {} : { videoBitrate: options.videoBitrate }),
                ...(options.audioBitrate === undefined ? {} : { audioBitrate: options.audioBitrate }),
                ...(cleanup === undefined ? {} : { cleanupSink: cleanup }),
                ...(options.audioProcessing === undefined ? {} : { audioProcessing: options.audioProcessing }),
                ...(options.execution === undefined ? {} : { execution: options.execution }),
              },
              signal,
              onProgress,
              (await requireMastering()).render,
              { ir, media },
            );
            if (options.profile === 'mp4-h264-aac') {
              return await exportFrozenRenderIrMp4(frozen);
            }
            if (options.profile === 'mp4-av1-aac') {
              return await exportFrozenRenderIrAv1Mp4(frozen);
            }
            if (options.profile === 'mp4-hevc-aac') {
              return await exportFrozenRenderIrHevcMp4(frozen);
            }
            return await exportFrozenRenderIrWebM(frozen);
          }
          if (options.profile === 'audio-wav') {
            return await exportWav({
              durationUs: ir.durationUs,
              sampleRate: ir.sampleRate,
              channelCount: channelCountForLayout(ir.channelLayout),
              sink: options.sink,
              renderAudio,
              signal,
              onProgress,
              ...(options.sampleFormat === undefined ? {} : { sampleFormat: options.sampleFormat }),
              ...(cleanup === undefined ? {} : { cleanupSink: cleanup }),
            });
          }
          if (options.profile === 'animated-gif') {
            return await exportGif({
              durationUs: ir.durationUs,
              width: ir.width,
              height: ir.height,
              frameRate: ir.frameRate,
              sink: options.sink,
              renderFrame,
              signal,
              onProgress,
              ...(options.loopCount === undefined ? {} : { loopCount: options.loopCount }),
              ...(cleanup === undefined ? {} : { cleanupSink: cleanup }),
            });
          }
          const format = options.profile === 'still-png' ? 'png' : options.profile === 'still-jpeg' ? 'jpeg' : 'webp';
          if (!('timeUs' in options)) throw new TypeError('Unsupported export profile');
          return await exportStillImage({
            timeUs: options.timeUs,
            width: ir.width,
            height: ir.height,
            format,
            sink: options.sink,
            renderFrame,
            signal,
            ...(options.quality === undefined ? {} : { quality: options.quality }),
            ...(cleanup === undefined ? {} : { cleanupSink: cleanup }),
          });
        } catch (error) {
          this.#recordErrorDiagnostics(error);
          throw error;
        }
      },
      onSnapshot: (snapshot) => this.#acceptExportSnapshot(snapshot),
      onSettled: (settled) => this.#acceptExportSettled(settled),
    });
    this.#activeExportJob = job;
    this.#emitStats();
    return job;
  }

  #startRemoteExport(options: AelionRemoteExportOptions): AelionRemoteExportJob {
    this.#assertActive();
    if (this.#activeExportJob?.state === 'running') {
      const diagnostic: Diagnostic = {
        code: 'EXPORT_JOB_ACTIVE',
        severity: 'error',
        message: 'AelionSession supports one active export; cancel it before starting another',
        recoverable: true,
      };
      this.#recordDiagnostic(diagnostic);
      throw new AelionError([diagnostic]);
    }
    const engine = this.#engine;
    const ir = this.requireIr();
    const sequenceId = this.#sequenceId;
    if (engine === undefined || sequenceId === undefined) throw unloaded();
    const project = engine.getSnapshot();
    const revision = ir.revision.toString();
    const manifest =
      options.manifest ??
      ({
        protocol: 'aelion.remote-export/1',
        profileId: options.profile,
        sequenceId,
        revision,
        project,
      } as const);
    const canonicalManifestBytes = new TextEncoder().encode(canonicalStringify(manifest));
    const id = `export-${this.#nextExportJobId.toString()}`;
    this.#nextExportJobId += 1;
    this.#exportJobsStarted += 1;
    this.#activeExportStartedAt = performance.now();
    const job = new ExportJob({
      id,
      ...(options.signal === undefined ? {} : { externalSignal: options.signal }),
      run: async (signal, updateProgress) => {
        try {
          const contentId = await createRemoteExportContentId(canonicalManifestBytes, options.profile, revision);
          return await runRemoteExport({
            provider: options.provider,
            authorizer: options.authorizer,
            ...(options.assetAuthorizer === undefined ? {} : { assetAuthorizer: options.assetAuthorizer }),
            request: {
              protocolVersion: '1.0.0',
              contentId,
              idempotencyKey: options.idempotencyKey ?? contentId,
              profileId: options.profile,
              projectId: project.projectId,
              sequenceId,
              revision,
              manifest,
              assets: options.assets ?? [],
              assetAuthorizations: [],
            },
            signal,
            onProgress: (progress, stage) => {
              updateProgress(progress);
              options.onProgress?.(progress, stage);
            },
          });
        } catch (error) {
          this.#recordErrorDiagnostics(error);
          throw error;
        }
      },
      onSnapshot: (snapshot) => this.#acceptExportSnapshot(snapshot),
      onSettled: (settled) => this.#acceptExportSettled(settled),
    });
    this.#activeExportJob = job;
    this.#emitStats();
    return job;
  }

  async #cancelExport(reason?: unknown): Promise<void> {
    await this.#activeExportJob?.cancel(reason);
  }

  #acceptExportSnapshot(snapshot: AelionExportJobSnapshot): void {
    if (snapshot.state === 'completed') this.#exportJobsCompleted += 1;
    else if (snapshot.state === 'cancelled') this.#exportJobsCancelled += 1;
    else if (snapshot.state === 'failed') this.#exportJobsFailed += 1;
    this.#emitStats();
  }

  #acceptExportSettled(settled: AelionExportJob | AelionProfileExportJob | AelionRemoteExportJob): void {
    if (this.#activeExportJob === settled) this.#activeExportJob = undefined;
    const startedAt = this.#activeExportStartedAt;
    this.#activeExportStartedAt = undefined;
    if (startedAt !== undefined) {
      recordOperationTiming(
        this.#operationTimings.export,
        startedAt,
        settled.state === 'completed' ? 'succeeded' : settled.state === 'cancelled' ? 'cancelled' : 'failed',
      );
    }
    this.#emitStats();
  }

  #recordErrorDiagnostics(error: unknown): number {
    if (error === null || typeof error !== 'object') return 0;
    const diagnostics: unknown = Reflect.get(error, 'diagnostics');
    if (!Array.isArray(diagnostics)) return 0;
    let recorded = 0;
    for (const diagnostic of diagnostics) {
      if (this.#isDiagnostic(diagnostic)) {
        this.#recordDiagnostic(diagnostic);
        recorded += 1;
      }
    }
    return recorded;
  }

  #acceptPlayerError(error: unknown): void {
    if (this.#recordErrorDiagnostics(error) === 0) {
      this.#recordDiagnostic({
        code: 'PLAYER_RUNTIME_FAILED',
        severity: 'error',
        message: error instanceof Error ? error.message : 'Player runtime failed',
        recoverable: true,
        cause: error,
      });
    }
    this.#emitStats();
  }

  #isDiagnostic(value: unknown): value is Diagnostic {
    return (
      value !== null &&
      typeof value === 'object' &&
      typeof Reflect.get(value, 'code') === 'string' &&
      typeof Reflect.get(value, 'message') === 'string' &&
      typeof Reflect.get(value, 'recoverable') === 'boolean'
    );
  }

  #recordDiagnostic(diagnostic: Diagnostic): void {
    if (this.#diagnostics.length === this.#maxDiagnostics) {
      this.#diagnostics.shift();
      this.#droppedDiagnostics += 1;
    }
    this.#diagnostics.push(diagnostic);
    this.#emit({ type: 'diagnostic', diagnostic });
  }

  #setState(state: AelionSessionState): void {
    if (this.#state === state) return;
    const previousState = this.#state;
    this.#state = state;
    this.#emit({ type: 'state-changed', previousState, state });
  }

  #emitStats(): void {
    this.#emit({ type: 'stats-changed', stats: this.getStats() });
  }

  #assertActive(): void {
    if (this.#state === 'disposed') throw new ReferenceError('AelionSession is disposed');
  }

  #assertLoadCurrent(generation: number): void {
    if (this.#state === 'disposed') throw new ReferenceError('AelionSession is disposed');
    if (generation !== this.#loadGeneration) {
      throw new DOMException('AelionSession Project load was superseded', 'AbortError');
    }
  }

  #requireRenderer(): RenderIrFrameRenderer {
    this.#assertActive();
    this.#renderer ??= new RenderIrFrameRenderer({
      ...(this.#options.maxPendingFrames === undefined ? {} : { maxPendingFrames: this.#options.maxPendingFrames }),
      ...(this.#options.runtimeAssets?.rendererWorker === undefined
        ? {}
        : { workerUrl: this.#options.runtimeAssets.rendererWorker }),
    });
    return this.#renderer;
  }

  #requireCommands(): EditingCommands {
    this.#assertTransactionAvailable();
    if (this.#commands === undefined) throw unloaded();
    return this.#commands;
  }

  #emit(event: AelionSessionEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // Consumer callbacks must not corrupt SDK state or stop other subscribers.
      }
    }
  }
}
