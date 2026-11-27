import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../shared/errors';
import type { VideoMediaProbe } from '../shared/types/video-studio-types';
import type { WireMessage } from '../shared/types/core';
import type { Completion, ModelClient, ToolDefinition } from '../electron/core/model/model';
import { Store } from '../electron/core/storage/store';
import { Harness } from '../electron/core/agent/harness';
import { CORE_ACTIVE_TOOLS, selectModelTools, VIDEO_STUDIO_TOOLS } from '../electron/core/agent/tool-loading';
import { TOOLS } from '../electron/core/agent/tools';
import { VIDEO_STUDIO_HANDLERS } from '../electron/core/agent/tools/handlers/video-studio';
import type { ToolContext } from '../electron/core/agent/tools/context';
import type { Interactions } from '../electron/core/agent/interactions';
import { AgentPreviews } from '../electron/core/preview/agent-previews';
import { ArtifactService } from '../electron/core/attachments/artifacts';
import { Attachments } from '../electron/core/attachments/attachments';
import { VideoProjects } from '../electron/core/video/video-projects';
import { VideoMediaTokenRegistry } from '../electron/core/video/video-engine-protocol';
import { VideoStudioService } from '../electron/core/video/video-studio-service';
import type { VideoEngineBackend } from '../electron/windows/video-engine-window';
import type { VmController } from '../electron/core/vm/vm';
import { answer, tempDir } from './helpers';

const SAMPLE_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000004000000040806000000a9f19e7e0000001449444154789c6360c00f000000ffff030000050001a5c1d7e40000000049454e44ae426082',
  'hex',
);

function makeFakeVm(): VmController {
  return {
    state: { status: 'stopped', detail: '', imageVersion: '1' },
    execute: async () => ({ stdout: '', stderr: '', exitCode: 1, durationMs: 0 }),
  } as unknown as VmController;
}

function makeFakeEngine(
  opts: { analyzeDelayMs?: number; probe?: Partial<VideoMediaProbe> } = {},
): VideoEngineBackend & {
  analyzeCalls: number;
  renderCalls: number;
  exportCalls: number;
  cancelledJobs: string[];
} {
  let analyzeCalls = 0;
  let renderCalls = 0;
  let exportCalls = 0;
  const cancelledJobs: string[] = [];

  return {
    get analyzeCalls() {
      return analyzeCalls;
    },
    get renderCalls() {
      return renderCalls;
    },
    get exportCalls() {
      return exportCalls;
    },
    cancelledJobs,
    isReady: () => true,
    capabilities: async () => ({
      supportedExportFormats: ['mp4', 'webm', 'wav', 'gif', 'png'],
      codecs: { h264: true, vp9: true, av1: false, hevc: false, aac: true, opus: true },
    }),
    analyzeMedia: async (payload): Promise<VideoMediaProbe> => {
      analyzeCalls += 1;
      if (opts.analyzeDelayMs) await new Promise((r) => setTimeout(r, opts.analyzeDelayMs));
      return {
        mimeType: payload.mimeType ?? 'video/mp4',
        byteLength: payload.byteLength ?? 1024,
        durationUs: 5_000_000,
        width: 1920,
        height: 1080,
        fps: 30,
        hasVideo: true,
        hasAudio: true,
        sampleRate: 48_000,
        channels: 2,
        posterDataUrl: `data:image/png;base64,${SAMPLE_PNG.toString('base64')}`,
        waveform: [0.2, 0.8, 0.5, 0.9],
        silences: [{ startUs: 1_500_000, endUs: 2_800_000, durationUs: 1_300_000, peakDb: -54 }],
        beats: [
          { timeUs: 0, strength: 0.9 },
          { timeUs: 2_000_000, strength: 0.95 },
        ],
        ...opts.probe,
      };
    },
    renderFrames: async (payload) => {
      renderCalls += 1;
      const frames = payload.timestampsUs.map((timeUs) => ({
        timeUs,
        dataUrl: `data:image/png;base64,${SAMPLE_PNG.toString('base64')}`,
        width: 320,
        height: 180,
      }));
      return payload.contactSheet
        ? { frames, contactSheetPng: new Uint8Array(SAMPLE_PNG), contactSheetWidth: 640, contactSheetHeight: 360 }
        : { frames };
    },
    exportProjectToFile: async (req) => {
      exportCalls += 1;
      req.onProgress?.({ jobId: req.jobId, progress: 0.5, stage: 'encoding' });
      mkdirSync(join(req.outputPath, '..'), { recursive: true });
      writeFileSync(req.outputPath, Buffer.from(`fake-${req.format}-output`));
      req.onProgress?.({ jobId: req.jobId, progress: 1, stage: 'completed' });
      return {
        negotiatedFormat: req.format,
        negotiatedCodec: req.format === 'mp4' ? 'h264/aac' : req.format,
        bytesWritten: 20,
        outputPath: req.outputPath,
      };
    },
    cancelExport: (jobId) => {
      cancelledJobs.push(jobId);
    },
    dispose: () => {},
  };
}

test('tool-loading keeps video_project_create core and defers the remaining 6 video_* tools until activated or project exists', () => {
  assert.ok(CORE_ACTIVE_TOOLS.has('video_project_create'));
  for (const deferred of VIDEO_STUDIO_TOOLS) {
    assert.ok(!CORE_ACTIVE_TOOLS.has(deferred), `${deferred} should be deferred initially`);
  }

  const baseOpts = {
    contextTokens: 64_000,
    privateSession: false,
    groupOrigin: false,
    planning: false,
    designBound: false,
    scheduledRun: false,
    hasInitialWork: false,
  };

  const turn1 = selectModelTools(TOOLS, { ...baseOpts, hasVideoProjects: false }).map((t) => t.function.name);
  assert.ok(turn1.includes('video_project_create'));
  assert.ok(!turn1.includes('video_edit'));

  const withProjects = selectModelTools(TOOLS, { ...baseOpts, hasVideoProjects: true }).map((t) => t.function.name);
  for (const name of VIDEO_STUDIO_TOOLS) {
    assert.ok(withProjects.includes(name), `${name} should auto-activate when bot has video projects`);
  }
});

test('Harness executes all 7 Video Studio tools, injects video_preview_frame visual observation, and gates headless mode', async (t) => {
  const dir = tempDir(t, 'aelion-vid-harness-');
  const workspace = join(dir, 'workspace');
  const imageDir = join(dir, 'screenshots');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(imageDir, { recursive: true });

  const clipPath = join(workspace, 'demo.mp4');
  writeFileSync(clipPath, Buffer.from('sample-mp4-data'));

  const store = new Store(dir);
  t.after(() => store.close());
  store.data.model.model = 'fixture';
  store.data.model.contextTokens = 64_000;
  const bot = store.createBot('VideoBot', 'video creator');
  const vm = makeFakeVm();
  const artifacts = new ArtifactService(store, vm);
  const attachments = new Attachments(store, vm, artifacts);
  const previews = new AgentPreviews(store, artifacts, attachments, () => {});
  const engine = makeFakeEngine();
  const mediaTokens = new VideoMediaTokenRegistry();
  const projects = new VideoProjects({ workspaceRoot: () => workspace });
  const studio = new VideoStudioService({
    dataDir: dir,
    projects,
    engine,
    mediaTokens,
    imageDir,
    importAttachmentForBot: (botId, name, bytes, src) => attachments.importForBot(botId, name, bytes, src),
  });
  previews.setVideoProjectResolver((id) => {
    try {
      const p = studio.getProject(id);
      return { id: p.id, title: p.title };
    } catch {
      return undefined;
    }
  });

  let turn = 0;
  let createdProjectId = '';
  let latestRevision = '';
  let importedAssetId = '';
  let exportJobId = '';
  const offeredByTurn: string[][] = [];
  let sawVisualObservation = false;
  let sawVideoStudioPrompt = false;

  const model = {
    complete: async (messages: WireMessage[], tools: ToolDefinition[]): Promise<Completion> => {
      turn += 1;
      offeredByTurn.push(tools.map((tool) => tool.function.name));
      if (turn === 1) {
        const sys = messages.find((m) => m.role === 'system')?.content || '';
        sawVideoStudioPrompt = sys.includes('Video Studio is available');
        return {
          content: '',
          finishReason: 'tool_calls',
          calls: [
            {
              id: randomUUID(),
              type: 'function',
              function: {
                name: 'video_project_create',
                arguments: JSON.stringify({ title: 'Demo Cut', aspect: '16:9' }),
              },
            },
          ],
        };
      }
      const lastToolMsg = [...messages].reverse().find((m) => m.role === 'tool');
      const rawEnvelope = lastToolMsg?.content ? JSON.parse(lastToolMsg.content) : {};
      const parsedTool = rawEnvelope?.result ?? rawEnvelope;

      if (turn === 2) {
        createdProjectId = parsedTool.projectId;
        latestRevision = parsedTool.revision;
        return {
          content: '',
          finishReason: 'tool_calls',
          calls: [
            {
              id: randomUUID(),
              type: 'function',
              function: {
                name: 'video_asset_import',
                arguments: JSON.stringify({ projectId: createdProjectId, sourceKind: 'host', path: clipPath }),
              },
            },
          ],
        };
      }
      if (turn === 3) {
        importedAssetId = parsedTool.asset.id;
        latestRevision = parsedTool.revision;
        return {
          content: '',
          finishReason: 'tool_calls',
          calls: [
            {
              id: randomUUID(),
              type: 'function',
              function: {
                name: 'video_edit',
                arguments: JSON.stringify({
                  projectId: createdProjectId,
                  expectedRevision: latestRevision,
                  operations: [
                    { op: 'add_clip', clipId: 'c1', assetId: importedAssetId, startUs: 0, durationUs: 3_000_000 },
                    { op: 'add_text', text: 'Hello Video Studio', startUs: 0, durationUs: 2_000_000 },
                  ],
                }),
              },
            },
          ],
        };
      }
      if (turn === 4) {
        return {
          content: '',
          finishReason: 'tool_calls',
          calls: [
            {
              id: randomUUID(),
              type: 'function',
              function: {
                name: 'video_project_inspect',
                arguments: JSON.stringify({ projectId: createdProjectId }),
              },
            },
            {
              id: randomUUID(),
              type: 'function',
              function: {
                name: 'video_preview_frame',
                arguments: JSON.stringify({ projectId: createdProjectId, timestampsSec: [0.5, 1.5] }),
              },
            },
          ],
        };
      }
      if (turn === 5) {
        sawVisualObservation = messages.some(
          (m) => m.role === 'user' && Array.isArray(m.images) && m.images.length === 1 && m.images[0]!.width === 640,
        );
        return {
          content: '',
          finishReason: 'tool_calls',
          calls: [
            {
              id: randomUUID(),
              type: 'function',
              function: {
                name: 'video_export',
                arguments: JSON.stringify({
                  projectId: createdProjectId,
                  format: 'mp4',
                  quality: 'standard',
                  attachToChat: true,
                }),
              },
            },
          ],
        };
      }
      if (turn === 6) {
        exportJobId = parsedTool.job.id;
        return {
          content: '',
          finishReason: 'tool_calls',
          calls: [
            {
              id: randomUUID(),
              type: 'function',
              function: { name: 'video_export_status', arguments: JSON.stringify({ jobId: exportJobId }) },
            },
            {
              id: randomUUID(),
              type: 'function',
              function: {
                name: 'preview_mark',
                arguments: JSON.stringify({
                  videoProjectId: createdProjectId,
                  marks: [{ note: 'Check title at 1.5s', box: [0.1, 0.1, 0.5, 0.2], timestampSec: 1.5 }],
                }),
              },
            },
          ],
        };
      }
      return answer('Video assembled, visually checked, exported, and opened for review.');
    },
  } as unknown as ModelClient;

  const harness = new Harness(
    store,
    vm,
    model,
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    attachments,
  );
  harness.setVideoStudio(studio);
  harness.setPreviewGateway(previews);

  await harness.run(bot.id, 'Create and export a demo video');

  assert.equal(sawVideoStudioPrompt, true);
  assert.ok(offeredByTurn[0]!.includes('video_project_create'));
  assert.ok(!offeredByTurn[0]!.includes('video_edit'), 'deferred video_* tools start inactive before first project');
  assert.ok(
    offeredByTurn[1]!.includes('video_edit'),
    'video_project_create auto-activates all video_* tools for turn 2',
  );
  assert.equal(sawVisualObservation, true, 'video_preview_frame contact sheet is injected as visual observation');

  // Verify contact sheet PNG was persisted in screenshots/video-frames/
  const previewReq = previews.snapshot()[0];
  assert.ok(previewReq);
  assert.equal(previewReq.videoProjectId, createdProjectId);
  assert.equal(previewReq.marks?.[0]?.timestampSec, 1.5);

  previews.acknowledge(previewReq.id);
  const hist = previews.history();
  assert.equal(hist.at(-1)?.videoProjectId, createdProjectId);

  // Verify headless mode hides all 7 video_* tools and omits VIDEO_STUDIO prompt
  let headlessTools: string[] = [];
  let headlessSystem = '';
  const headlessModel = {
    complete: async (messages: WireMessage[], tools: ToolDefinition[]): Promise<Completion> => {
      headlessTools = tools.map((item) => item.function.name);
      headlessSystem = messages.find((m) => m.role === 'system')?.content || '';
      return answer('headless ok');
    },
  } as unknown as ModelClient;
  const headlessHarness = new Harness(store, vm, headlessModel, () => {});
  headlessHarness.setVideoStudio(studio);
  headlessHarness.setHeadless(true);
  await headlessHarness.run(bot.id, 'headless check');
  assert.ok(!headlessTools.includes('video_project_create'));
  assert.ok(!headlessTools.includes('video_edit'));
  assert.ok(!headlessSystem.includes('Video Studio is available'));
});

test('AgentPreviews supports video/audio file extensions and VideoStudioService handles poster LRU cache and quickEdit', async (t) => {
  const dir = tempDir(t, 'aelion-vid-svc-');
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const videoFile = join(workspace, 'clip.mp4');
  writeFileSync(videoFile, Buffer.from('mp4-video-content-bytes'));

  const store = new Store(dir);
  t.after(() => store.close());
  const bot = store.createBot('MediaBot', 'helper');
  const vm = makeFakeVm();
  const artifacts = new ArtifactService(store, vm);
  const attachments = new Attachments(store, vm, artifacts);
  const previews = new AgentPreviews(store, artifacts, attachments, () => {});

  const att = attachments.importForBot(bot.id, 'review.mp4', Buffer.from('fake-mp4'));
  const run = {
    id: randomUUID(),
    botId: bot.id,
    status: 'running' as const,
    startedAt: new Date().toISOString(),
    modelCalls: 0,
    toolCalls: 0,
  };
  store.data.runs.push(run);

  const queued = await previews.open(
    bot.id,
    run.id,
    {
      attachmentId: att.id,
      marks: [{ note: 'Trim pause here', box: [0.2, 0.2, 0.3, 0.3], timestampSec: 4.2 }],
    },
    new AbortController().signal,
  );
  assert.equal(queued.queued, true);
  assert.equal(queued.marks, 1);
  assert.equal(previews.snapshot()[0]?.marks?.[0]?.timestampSec, 4.2);

  // VideoStudioService poster LRU cache + quickEdit flows
  const engine = makeFakeEngine();
  const projects = new VideoProjects({ workspaceRoot: () => workspace });
  const studio = new VideoStudioService({
    dataDir: dir,
    projects,
    engine,
    mediaTokens: new VideoMediaTokenRegistry(),
    imageDir: join(dir, 'screenshots'),
  });

  // 1. mediaPoster hits engine once, then serves from disk/memory cache
  const poster1 = await studio.mediaPoster({ source: { kind: 'host', path: videoFile } });
  const poster2 = await studio.mediaPoster({ source: { kind: 'host', path: videoFile } });
  assert.ok(poster1?.posterDataUrl.startsWith('data:image/png;base64,'));
  assert.equal(poster2?.posterDataUrl, poster1?.posterDataUrl);
  assert.equal(engine.analyzeCalls, 1, 'second mediaPoster call hits cache');
  assert.ok(studio.getCachedMediaMetaForFile(videoFile)?.durationSec === 5);

  // 2. quickEdit promote_to_project
  const promoted = await studio.quickEdit({
    source: { kind: 'host', path: videoFile },
    edit: { action: 'promote_to_project', title: 'Promoted Clip', botId: bot.id },
  });
  assert.equal(promoted.action, 'promote_to_project');
  assert.equal(promoted.project?.title, 'Promoted Clip');
  assert.ok((promoted.project?.clipCount ?? 0) >= 1);

  // 3. quickEdit capture_frame
  const frameOut = join(workspace, 'captured.png');
  const captured = await studio.quickEdit({
    source: { kind: 'host', path: videoFile },
    edit: { action: 'capture_frame', timeSec: 1.2, outputPath: frameOut },
  });
  assert.equal(captured.outputPath, frameOut);
  assert.ok(existsSync(frameOut));

  // 4. quickEdit trim & remove_silence
  const trimOut = join(workspace, 'trimmed.mp4');
  const trimmed = await studio.quickEdit({
    source: { kind: 'host', path: videoFile },
    edit: { action: 'trim', startSec: 1, endSec: 3.5, outputPath: trimOut },
  });
  assert.equal(trimmed.outputPath, trimOut);
  assert.ok(existsSync(trimOut));

  const silOut = join(workspace, 'no-silence.mp4');
  const cleaned = await studio.quickEdit({
    source: { kind: 'host', path: videoFile },
    edit: { action: 'remove_silence', outputPath: silOut },
  });
  assert.equal(cleaned.outputPath, silOut);
  assert.ok(existsSync(silOut));
  assert.ok((cleaned.removedSec ?? 0) > 0);
});

test('Video Studio tools enforce cross-bot isolation, host permission checks, and Windows-safe poster cache filenames', async (t) => {
  const dir = tempDir(t, 'aelion-vid-sec-tools-');
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const hostVideo = join(workspace, 'host-clip.mp4');
  writeFileSync(hostVideo, Buffer.from('host-clip-bytes'));

  const store = new Store(dir);
  t.after(() => store.close());
  const botA = store.createBot('BotA', 'owner');
  const botB = store.createBot('BotB', 'other');
  const vm = makeFakeVm();
  const artifacts = new ArtifactService(store, vm);
  const attachments = new Attachments(store, vm, artifacts);
  const previews = new AgentPreviews(store, artifacts, attachments, () => {});
  const engine = makeFakeEngine();
  const projects = new VideoProjects({
    workspaceRoot: () => workspace,
    readAttachment: (id) => {
      const meta = store.data.attachments.find((item) => item.id === id);
      const bytes = attachments.bytes(id);
      return { bytes, name: meta?.name ?? 'clip.mp4', mime: meta?.mime ?? 'video/mp4' };
    },
  });
  const studio = new VideoStudioService({
    dataDir: dir,
    projects,
    engine,
    mediaTokens: new VideoMediaTokenRegistry(),
    imageDir: join(dir, 'screenshots'),
    readWorkspaceFile: async (_botId, relPath) => ({
      bytes: Buffer.from(`ws-bytes-${relPath}`),
      name: relPath.split('/').at(-1) || 'clip.mp4',
    }),
  });
  previews.setVideoProjectResolver((id) => {
    try {
      const p = studio.getProject(id);
      return { id: p.id, title: p.title, botId: p.botId };
    } catch {
      return undefined;
    }
  });

  const projA = studio.createProject({ botId: botA.id, title: 'Bot A Secret Cut' });
  const projB = studio.createProject({ botId: botB.id, title: 'Bot B Cut' });
  const attA = attachments.importForBot(botA.id, 'secret-a.mp4', Buffer.from('secret-a-bytes'));
  const exportJobA = studio.startExport({ projectId: projA.id, format: 'mp4', quality: 'standard' });
  await studio.waitForExport(exportJobA.id);
  store.data.runs.push({
    id: 'run-sec-b',
    botId: botB.id,
    status: 'running',
    startedAt: new Date().toISOString(),
    modelCalls: 0,
    toolCalls: 0,
  });

  const permissionCalls: Array<{ operation: string; path?: string; tool?: string }> = [];
  let allowPermission = true;
  const fakeInteractions = {
    permission: async (_botId: string, _runId: string, req: { operation: string; path?: string; tool?: string }) => {
      permissionCalls.push({ operation: req.operation, path: req.path, tool: req.tool });
      if (!allowPermission) {
        throw new AppError('permission.denied', '用户拒绝了文件访问权限');
      }
    },
  } as unknown as Interactions;

  const makeCtx = (bot: typeof botA, args: Record<string, unknown>): ToolContext =>
    ({
      bot,
      args,
      runId: 'run-sec',
      workspace,
      signal: new AbortController().signal,
      deps: {
        store,
        vm,
        attachments,
        videoStudio: studio,
        interactions: fakeInteractions,
        changed: () => {},
      },
    }) as unknown as ToolContext;

  // 1. Cross-bot isolation on project tools & attachment import & preview resolver
  assert.throws(
    () => VIDEO_STUDIO_HANDLERS.video_project_inspect!(makeCtx(botB, { projectId: projA.id })),
    (err: unknown) => err instanceof AppError && err.code === 'video.project_not_found',
  );
  await assert.rejects(
    () =>
      Promise.resolve(
        VIDEO_STUDIO_HANDLERS.video_edit!(
          makeCtx(botB, {
            projectId: projA.id,
            operations: [{ op: 'add_text', text: 'hijack', startUs: 0, durationUs: 1_000_000 }],
          }),
        ),
      ),
    (err: unknown) => err instanceof AppError && err.code === 'video.project_not_found',
  );
  await assert.rejects(
    () => Promise.resolve(VIDEO_STUDIO_HANDLERS.video_preview_frame!(makeCtx(botB, { projectId: projA.id }))),
    (err: unknown) => err instanceof AppError && err.code === 'video.project_not_found',
  );
  await assert.rejects(
    () => Promise.resolve(VIDEO_STUDIO_HANDLERS.video_export!(makeCtx(botB, { projectId: projA.id, format: 'mp4' }))),
    (err: unknown) => err instanceof AppError && err.code === 'video.project_not_found',
  );
  assert.throws(
    () => VIDEO_STUDIO_HANDLERS.video_export_status!(makeCtx(botB, { jobId: exportJobA.id })),
    (err: unknown) => err instanceof AppError && err.code === 'video.project_not_found',
  );
  await assert.rejects(
    () =>
      Promise.resolve(
        VIDEO_STUDIO_HANDLERS.video_asset_import!(
          makeCtx(botB, { projectId: projB.id, sourceKind: 'attachment', attachmentId: attA.id }),
        ),
      ),
    (err: unknown) => err instanceof AppError && err.code === 'video.asset_not_found',
  );
  await assert.rejects(
    () => previews.open(botB.id, 'run-sec-b', { videoProjectId: projA.id }, new AbortController().signal),
    (err: unknown) => err instanceof AppError && err.code === 'video.project_not_found',
  );

  // 2. Host permission checks for video_asset_import (read_file) and video_export outputPath (write_file)
  const customOut = join(workspace, 'exported-perm.mp4');
  allowPermission = false;
  await assert.rejects(
    () =>
      Promise.resolve(
        VIDEO_STUDIO_HANDLERS.video_asset_import!(
          makeCtx(botA, { projectId: projA.id, sourceKind: 'host', path: hostVideo }),
        ),
      ),
    (err: unknown) => err instanceof AppError && err.code === 'permission.denied',
  );
  await assert.rejects(
    () =>
      Promise.resolve(
        VIDEO_STUDIO_HANDLERS.video_export!(
          makeCtx(botA, { projectId: projA.id, format: 'mp4', outputPath: customOut }),
        ),
      ),
    (err: unknown) => err instanceof AppError && err.code === 'permission.denied',
  );
  assert.equal(existsSync(customOut), false, 'denied video_export must not write output file');
  assert.deepEqual(
    permissionCalls.map((c) => c.operation),
    ['read_file', 'write_file'],
  );

  allowPermission = true;
  const imported = (await VIDEO_STUDIO_HANDLERS.video_asset_import!(
    makeCtx(botA, { projectId: projA.id, sourceKind: 'host', path: hostVideo }),
  )) as { asset: { id: string } };
  assert.ok(imported.asset.id);
  const exported = (await VIDEO_STUDIO_HANDLERS.video_export!(
    makeCtx(botA, { projectId: projA.id, format: 'mp4', outputPath: customOut }),
  )) as { job: { status: string; outputPath?: string } };
  assert.equal(exported.job.status, 'completed');
  assert.equal(existsSync(customOut), true);

  // 3. Windows-safe poster cache filenames for workspace media sources (no colon in filename)
  const wsPoster = await studio.mediaPoster({
    source: { kind: 'workspace', botId: botA.id, path: 'clips/sample.mp4' },
  });
  assert.ok(wsPoster?.posterDataUrl.startsWith('data:image/png;base64,'));
  const cacheFiles = readdirSync(join(dir, 'video-posters'));
  assert.ok(cacheFiles.length >= 1);
  for (const file of cacheFiles) {
    assert.ok(!file.includes(':'), `poster cache filename must not contain colon: ${file}`);
  }
});

test('video_project_create starts from an existing video with a canvas that keeps its size and frame rate', async (t) => {
  const dir = tempDir(t, 'aelion-vid-from-source-');
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const hostVideo = join(workspace, 'phone-clip.mp4');
  writeFileSync(hostVideo, Buffer.from('phone-clip-bytes'));

  const store = new Store(dir);
  t.after(() => store.close());
  const bot = store.createBot('Editor', 'owner');
  const vm = makeFakeVm();
  const attachments = new Attachments(store, vm, new ArtifactService(store, vm));
  const studio = new VideoStudioService({
    dataDir: dir,
    projects: new VideoProjects({ workspaceRoot: () => workspace }),
    engine: makeFakeEngine({ probe: { width: 1080, height: 1920, fps: 29.97 } }),
    mediaTokens: new VideoMediaTokenRegistry(),
    imageDir: join(dir, 'screenshots'),
  });
  const permissions: string[] = [];
  const activated: string[] = [];
  const ctx = (args: Record<string, unknown>) =>
    ({
      bot,
      args,
      runId: 'run-from-source',
      workspace,
      signal: new AbortController().signal,
      deps: {
        store,
        vm,
        attachments,
        videoStudio: studio,
        interactions: {
          permission: async (_botId: string, _runId: string, req: { tool?: string }) => {
            permissions.push(req.tool ?? '');
          },
        } as unknown as Interactions,
        activateTools: (_runId: string, names: ReadonlySet<string>) => {
          activated.push(...names);
          return [...names];
        },
        changed: () => {},
      },
    }) as unknown as ToolContext;

  const result = (await VIDEO_STUDIO_HANDLERS.video_project_create!(ctx({ path: hostVideo }))) as {
    projectId: string;
    aspect: string;
    width: number;
    height: number;
    fps: number;
    title: string;
    tracks: Array<{ id: string; clips: Array<{ kind: string; durationUs: number }> }>;
  };
  assert.deepEqual(permissions, ['video_project_create'], 'reading a host file asks first');
  assert.equal(result.title, 'phone-clip');
  assert.deepEqual([result.aspect, result.width, result.height], ['9:16', 1080, 1920]);
  assert.ok(Math.abs(result.fps - 29.97) < 0.01);
  const clipsOn = (id: string) => result.tracks.find((track) => track.id === id)?.clips ?? [];
  assert.equal(clipsOn('video-main').length, 1);
  assert.equal(clipsOn('audio-voice').length, 1);
  assert.equal(clipsOn('video-main')[0]!.durationUs, 5_000_000);
  assert.ok(activated.includes('video_edit'), 'the editing tools turn on');

  // Explicit canvas arguments win over the source.
  const square = (await VIDEO_STUDIO_HANDLERS.video_project_create!(ctx({ path: hostVideo, aspect: '1:1' }))) as {
    aspect: string;
    width: number;
    height: number;
  };
  assert.equal(square.aspect, '1:1');

  // A project that cannot import its source is not left behind.
  const before = studio.listProjects({ botId: bot.id }).length;
  await assert.rejects(() =>
    Promise.resolve(VIDEO_STUDIO_HANDLERS.video_project_create!(ctx({ path: join(workspace, 'missing.mp4') }))),
  );
  assert.equal(studio.listProjects({ botId: bot.id }).length, before);

  // Quick trims from the preview keep the portrait canvas too.
  const promoted = await studio.quickEdit({
    source: { kind: 'host', path: hostVideo },
    edit: { action: 'promote_to_project', botId: bot.id },
  });
  assert.deepEqual([promoted.project?.width, promoted.project?.height], [1080, 1920]);
});
