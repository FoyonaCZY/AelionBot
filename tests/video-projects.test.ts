import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { JsonValue } from '@aelionsdk/core';
import { RuntimeMaterialRegistry } from '@aelionsdk/sdk';
import { AppError } from '../shared/errors';
import {
  compiledStudioPrograms,
  effectMaterialSpec,
  registerBuiltinVideoMaterials,
  VIDEO_EFFECT_PRESETS,
  VIDEO_TRANSITION_PRESETS,
} from '../electron/core/video/video-presets';
import { STANDARD_TRACK_IDS, VideoProjects } from '../electron/core/video/video-projects';
import {
  createVideoEngineProtocolHandler,
  VideoMediaTokenRegistry,
} from '../electron/core/video/video-engine-protocol';
import { MediaStreamRegistry } from '../electron/core/attachments/media-stream';
import { tempDir } from './helpers';

const SAMPLE_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000200000002080600000072b60d240000001049444154789c63f8cf00030303000101010018dd8d520000000049454e44ae426082',
  'hex',
);

test('builtin video presets compile AMP graphs and register all transitions and effects', () => {
  const registry = new RuntimeMaterialRegistry();
  const dispose = registerBuiltinVideoMaterials(registry);
  try {
    const programs = compiledStudioPrograms();
    assert.equal(programs['warm-film'].backend, 'webgl2');
    assert.equal(programs['soft-glow'].backend, 'webgl2');
    assert.ok((programs['soft-glow'].passes?.length ?? 0) >= 3, 'soft-glow compiles to multi-pass WebGL2 plan');
    assert.equal(programs.cinematic.backend, 'webgl2');

    for (const meta of Object.values(VIDEO_TRANSITION_PRESETS)) {
      const resolved = registry.resolveProgram(meta.definition, {});
      assert.ok(resolved, `transition ${meta.preset} should resolve a WebGL2 program`);
    }

    for (const meta of Object.values(VIDEO_EFFECT_PRESETS)) {
      const spec = effectMaterialSpec(meta.preset, { intensity: 0.8, width: 1280, height: 720 });
      const resolved = registry.resolveProgram(spec.definition, spec.parameters as Readonly<Record<string, JsonValue>>);
      assert.ok(resolved, `effect ${meta.preset} should resolve a WebGL2 program`);
    }
  } finally {
    dispose();
  }
});

test('VideoProjects CRUD, asset deduplication, DesignWork HTML->PNG import, and optimistic locking', async (t) => {
  const root = tempDir(t, 'aelion-vid-proj-');
  const hostMedia = join(root, 'sample-clip.mp4');
  writeFileSync(hostMedia, Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex'));
  const hostSlide = join(root, 'title-card.html');
  writeFileSync(hostSlide, '<!doctype html><html><body><h1>Slide 1</h1></body></html>', 'utf8');

  let designRenderCalls = 0;
  const projects = new VideoProjects({
    workspaceRoot: () => root,
    readWorkspaceFile: async (_botId, relPath) => ({
      bytes: Buffer.from(`ws:${relPath}`),
      name: relPath.split('/').at(-1) || 'file.wav',
    }),
    readAttachment: (id) => ({
      bytes: Buffer.from(`att:${id}`),
      name: 'voiceover.wav',
      mime: 'audio/wav',
    }),
    renderDesignPageToPng: async ({ width, height }) => {
      designRenderCalls += 1;
      assert.equal(width, 1080);
      assert.equal(height, 1920);
      return { bytes: SAMPLE_PNG, name: 'title-card.png' };
    },
  });

  const created = projects.create({
    botId: 'bot-1',
    sessionId: 'sess-1',
    title: 'Launch Reel',
    aspect: '9:16',
    fps: 30,
    backgroundColor: '#101014',
  });
  assert.equal(created.width, 1080);
  assert.equal(created.height, 1920);
  assert.equal(created.fps, 30);
  assert.equal(created.tracks.length, 5);
  assert.deepEqual(
    created.tracks.map((tr) => tr.id),
    [
      STANDARD_TRACK_IDS.videoMain,
      STANDARD_TRACK_IDS.videoOverlay,
      STANDARD_TRACK_IDS.captions,
      STANDARD_TRACK_IDS.audioVoice,
      STANDARD_TRACK_IDS.audioBgm,
    ],
  );
  assert.equal(projects.list({ botId: 'bot-1' }).length, 1);
  assert.equal(projects.list({ botId: 'bot-other' }).length, 0);

  // Import host MP4 + deduplicate on second import
  const firstImport = await projects.importAsset(
    { projectId: created.id, source: { kind: 'host', path: hostMedia } },
    { durationUs: 5_000_000, width: 1080, height: 1920, fps: 30, hasAudio: true },
  );
  assert.equal(firstImport.deduplicated, false);
  assert.equal(firstImport.asset.kind, 'video');
  assert.equal(firstImport.asset.durationUs, 5_000_000);

  const dupImport = await projects.importAsset({ projectId: created.id, source: { kind: 'host', path: hostMedia } });
  assert.equal(dupImport.deduplicated, true);
  assert.equal(dupImport.asset.id, firstImport.asset.id);

  // Import DesignWork HTML slide -> PNG asset
  const slideImport = await projects.importAsset({
    projectId: created.id,
    source: { kind: 'design', path: hostSlide, botId: 'bot-1' },
  });
  assert.equal(designRenderCalls, 1);
  assert.equal(slideImport.asset.kind, 'image');
  assert.equal(slideImport.asset.mimeType, 'image/png');

  // Import attachment audio + workspace audio
  const attImport = await projects.importAsset(
    { projectId: created.id, source: { kind: 'attachment', attachmentId: 'att-1' } },
    { durationUs: 4_000_000, hasAudio: true, sampleRate: 48_000, channels: 2 },
  );
  assert.equal(attImport.asset.kind, 'audio');

  const wsImport = await projects.importAsset(
    { projectId: created.id, source: { kind: 'workspace', botId: 'bot-1', path: 'bgm.mp3' } },
    { durationUs: 10_000_000, hasAudio: true },
  );
  assert.equal(wsImport.asset.kind, 'audio');

  // Optimistic locking conflict check
  assert.throws(
    () =>
      projects.edit({
        projectId: created.id,
        expectedRevision: '99999',
        operations: [{ op: 'add_text', text: 'Hi', startUs: 0, durationUs: 1_000_000 }],
      }),
    (err: unknown) => err instanceof AppError && err.code === 'video.revision_conflict',
  );

  // Delete + missing check
  projects.delete(created.id);
  assert.throws(
    () => projects.get(created.id),
    (err: unknown) => err instanceof AppError && err.code === 'video.project_not_found',
  );
});

test('VideoProjects executes all 20 edit operations atomically with schema validation and undo/redo', async (t) => {
  const root = tempDir(t, 'aelion-vid-ops-');
  const videoA = join(root, 'a.mp4');
  const videoB = join(root, 'b.mp4');
  const voicePath = join(root, 'voice.wav');
  const bgmPath = join(root, 'bgm.mp3');
  writeFileSync(videoA, Buffer.from('video-a-bytes'));
  writeFileSync(videoB, Buffer.from('video-b-bytes'));
  writeFileSync(voicePath, Buffer.from('voice-bytes'));
  writeFileSync(bgmPath, Buffer.from('bgm-bytes'));

  const projects = new VideoProjects({ workspaceRoot: () => root });
  const proj = projects.create({ botId: 'bot-1', title: 'All Ops Test', aspect: '16:9', fps: 30 });

  const { asset: aVid } = await projects.importAsset(
    { projectId: proj.id, source: { kind: 'host', path: videoA }, assetId: 'asset_va' },
    {
      durationUs: 6_000_000,
      width: 1920,
      height: 1080,
      hasAudio: true,
      silences: [{ startUs: 2_000_000, endUs: 3_200_000, durationUs: 1_200_000, peakDb: -55 }],
    },
  );
  const { asset: bVid } = await projects.importAsset(
    { projectId: proj.id, source: { kind: 'host', path: videoB }, assetId: 'asset_vb' },
    { durationUs: 4_000_000, width: 1920, height: 1080, hasAudio: false },
  );
  const { asset: aVoice } = await projects.importAsset(
    { projectId: proj.id, source: { kind: 'host', path: voicePath }, assetId: 'asset_voice' },
    {
      durationUs: 6_000_000,
      hasAudio: true,
      silences: [{ startUs: 2_000_000, endUs: 3_000_000, durationUs: 1_000_000, peakDb: -52 }],
    },
  );
  const { asset: aBgm } = await projects.importAsset(
    { projectId: proj.id, source: { kind: 'host', path: bgmPath }, assetId: 'asset_bgm' },
    {
      durationUs: 10_000_000,
      hasAudio: true,
      beats: [
        { timeUs: 0, strength: 0.9 },
        { timeUs: 3_000_000, strength: 0.95 },
        { timeUs: 6_000_000, strength: 0.9 },
      ],
    },
  );

  // Batch 1: add_clip, set_effect, set_transition, set_keyframes, set_clip_style
  let res = projects.edit({
    projectId: proj.id,
    expectedRevision: projects.get(proj.id).revision,
    operations: [
      { op: 'add_clip', clipId: 'clip_1', assetId: aVid.id, startUs: 0, durationUs: 4_000_000 },
      { op: 'add_clip', clipId: 'clip_2', assetId: bVid.id, startUs: 4_000_000, durationUs: 3_000_000 },
      {
        op: 'add_clip',
        clipId: 'clip_voice',
        trackId: STANDARD_TRACK_IDS.audioVoice,
        assetId: aVoice.id,
        kind: 'audio',
        startUs: 0,
        durationUs: 5_000_000,
      },
      {
        op: 'add_clip',
        clipId: 'clip_bgm',
        trackId: STANDARD_TRACK_IDS.audioBgm,
        assetId: aBgm.id,
        kind: 'audio',
        startUs: 0,
        durationUs: 8_000_000,
      },
      { op: 'set_effect', clipId: 'clip_1', preset: 'warm-film', intensity: 0.9 },
      { op: 'set_effect', clipId: 'clip_1', preset: 'soft-glow', intensity: 0.5 },
      { op: 'set_transition', fromClipId: 'clip_1', toClipId: 'clip_2', preset: 'cross-dissolve', durationUs: 500_000 },
      {
        op: 'set_keyframes',
        clipId: 'clip_1',
        property: 'opacity',
        keyframes: [
          { timeUs: 0, value: 0, interpolation: 'cubic' },
          { timeUs: 500_000, value: 1, interpolation: 'linear' },
        ],
      },
      {
        op: 'set_clip_style',
        clipId: 'clip_2',
        style: { fit: 'cover', opacity: 0.95, rotationDeg: 2, scale: { x: 1.05, y: 1.05 } },
      },
      {
        op: 'set_clip_style',
        clipId: 'clip_bgm',
        style: {},
        gainDb: -8,
        fadeInUs: 200_000,
        fadeOutUs: 400_000,
      },
    ],
  });
  assert.equal(res.applied, 10);
  const mainClips = res.project.tracks.find((tr) => tr.id === STANDARD_TRACK_IDS.videoMain)!.clips;
  assert.equal(mainClips.length, 2);
  assert.equal(mainClips[0]!.effects?.length, 2);
  assert.equal(mainClips[0]!.transitionOut?.preset, 'cross-dissolve');
  assert.equal(mainClips[1]!.transitionIn?.preset, 'cross-dissolve');
  assert.equal(mainClips[1]!.style?.fit, 'cover');

  // Batch 2: split_clip (verifies cloned MaterialInstance ownership + transition rebinding), trim_clip, move_clip, replace_asset
  res = projects.edit({
    projectId: proj.id,
    expectedRevision: res.revision,
    operations: [
      { op: 'split_clip', clipId: 'clip_1', atUs: 2_000_000, rightClipId: 'clip_1b' },
      { op: 'trim_clip', clipId: 'clip_2', durationUs: 2_500_000 },
      { op: 'move_clip', clipId: 'clip_2', startUs: 4_100_000 },
      { op: 'replace_asset', clipId: 'clip_2', assetId: aVid.id, keepDuration: true },
    ],
  });
  const afterSplit = res.project.tracks.find((tr) => tr.id === STANDARD_TRACK_IDS.videoMain)!.clips;
  assert.equal(afterSplit.length, 3);
  assert.equal(afterSplit[1]!.id, 'clip_1b');
  assert.equal(afterSplit[1]!.effects?.length, 2, 'split clones effects with fresh MaterialInstance IDs');
  assert.notEqual(afterSplit[0]!.effects![0]!.id, afterSplit[1]!.effects![0]!.id);
  assert.equal(afterSplit[1]!.transitionOut?.preset, 'cross-dissolve', 'outgoing transition rebinds to right half');

  // Batch 3: add_text, update_text, import_subtitles (SRT + VTT + cues)
  const srt = `1\n00:00:00,500 --> 00:00:02,500\nHello World\n\n2\n00:00:02,600 --> 00:00:04,500\nSecond Line\n`;
  res = projects.edit({
    projectId: proj.id,
    expectedRevision: res.revision,
    operations: [
      {
        op: 'add_text',
        clipId: 'title_1',
        text: 'Intro',
        startUs: 0,
        durationUs: 2_000_000,
        style: { fontSizePx: 72, fill: '#ffee00' },
      },
      { op: 'update_text', clipId: 'title_1', text: 'Updated Intro', style: { fontWeight: 800 } },
      { op: 'import_subtitles', format: 'srt', content: srt, replaceExisting: true },
    ],
  });
  const overlay = res.project.tracks.find((tr) => tr.id === STANDARD_TRACK_IDS.videoOverlay)!;
  assert.equal(overlay.clips[0]!.text, 'Updated Intro');
  assert.equal(overlay.clips[0]!.textStyle?.fontWeight, 800);
  const captions = res.project.tracks.find((tr) => tr.id === STANDARD_TRACK_IDS.captions)!;
  assert.equal(captions.clips.length, 2);

  // Also test VTT + cues
  res = projects.edit({
    projectId: proj.id,
    expectedRevision: res.revision,
    operations: [
      {
        op: 'import_subtitles',
        format: 'vtt',
        content: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nVTT Cue\n',
        replaceExisting: true,
      },
    ],
  });
  assert.equal(res.project.tracks.find((tr) => tr.id === STANDARD_TRACK_IDS.captions)!.clips[0]!.text, 'VTT Cue');

  res = projects.edit({
    projectId: proj.id,
    expectedRevision: res.revision,
    operations: [
      {
        op: 'import_subtitles',
        format: 'cues',
        cues: [{ startUs: 100_000, endUs: 900_000, text: 'Cue From Transcript' }],
        replaceExisting: true,
      },
    ],
  });
  assert.equal(
    res.project.tracks.find((tr) => tr.id === STANDARD_TRACK_IDS.captions)!.clips[0]!.text,
    'Cue From Transcript',
  );

  // Batch 4: remove_silence, auto_duck, normalize_loudness, snap_to_beats, set_track_audio, remove transition & effect, delete_clip (ripple)
  res = projects.edit({
    projectId: proj.id,
    expectedRevision: res.revision,
    operations: [
      { op: 'remove_silence', clipId: 'clip_voice', minimumSilenceUs: 300_000, paddingUs: 40_000 },
      {
        op: 'auto_duck',
        programTrackIds: [STANDARD_TRACK_IDS.audioBgm],
        sidechainTrackIds: [STANDARD_TRACK_IDS.audioVoice],
        reductionDb: -14,
      },
      { op: 'normalize_loudness', targetLufs: -16, maximumGainDb: 18, ceilingDbtp: -1 },
      { op: 'set_track_audio', trackId: STANDARD_TRACK_IDS.audioBgm, muted: false, solo: false, gainDb: -6 },
      { op: 'set_transition', fromClipId: 'clip_1b', toClipId: 'clip_2', preset: null },
      { op: 'set_effect', clipId: 'clip_1', preset: 'soft-glow', remove: true },
      { op: 'move_clip', clipId: 'clip_1b', startUs: 2_900_000 },
      { op: 'snap_to_beats', audioClipId: 'clip_bgm', clipIds: ['clip_1b'], maxOffsetUs: 250_000 },
      { op: 'delete_clip', clipId: 'clip_2', ripple: true },
    ],
  });
  const voiceClips = res.project.tracks.find((tr) => tr.id === STANDARD_TRACK_IDS.audioVoice)!.clips;
  assert.equal(voiceClips.length, 2, 'remove_silence splits voice clip around silent gap');
  const seqJson = (res.project.projectJson.sequences as Record<string, any>)[res.project.sequenceId];
  const mastering = seqJson.extensions['aelion.audio.mastering'];
  assert.equal(mastering.targetLufs, -16);
  assert.equal(mastering.limiter.lookaheadUs, 0);
  assert.equal(mastering.ducking[0].lookaheadUs, 0);
  const clip1b = res.project.tracks
    .find((tr) => tr.id === STANDARD_TRACK_IDS.videoMain)!
    .clips.find((c) => c.id === 'clip_1b')!;
  assert.equal(clip1b.startUs, 3_000_000, 'snap_to_beats aligns clip_1b to 3.0s beat');

  // Batch 5: undo & redo (Batch 4 deleted clip_2 and split clip_voice; undoing restores clip_2 & single voice clip)
  assert.equal(
    res.project.tracks.find((tr) => tr.id === STANDARD_TRACK_IDS.videoMain)!.clips.some((c) => c.id === 'clip_2'),
    false,
  );
  const undone = projects.edit({ projectId: proj.id, operations: [{ op: 'undo' }] });
  assert.equal(undone.project.canRedo, true);
  assert.equal(
    undone.project.tracks.find((tr) => tr.id === STANDARD_TRACK_IDS.videoMain)!.clips.some((c) => c.id === 'clip_2'),
    true,
  );
  assert.equal(undone.project.tracks.find((tr) => tr.id === STANDARD_TRACK_IDS.audioVoice)!.clips.length, 1);
  const redone = projects.edit({ projectId: proj.id, operations: [{ op: 'redo' }] });
  assert.equal(
    redone.project.tracks.find((tr) => tr.id === STANDARD_TRACK_IDS.videoMain)!.clips.some((c) => c.id === 'clip_2'),
    false,
  );
  assert.equal(redone.project.tracks.find((tr) => tr.id === STANDARD_TRACK_IDS.audioVoice)!.clips.length, 2);
});

test('aelion-video:// protocol handler and MediaStreamRegistry serve strict CSP, 206 byte ranges, HEAD, and CORS/CORP', async (t) => {
  const root = tempDir(t, 'aelion-vid-proto-');
  const runtimeDir = join(root, 'video-runtime');
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, 'engine-entry.js'), 'console.log("engine");', 'utf8');
  writeFileSync(join(runtimeDir, 'webgl2-worker.js'), 'console.log("worker");', 'utf8');

  const assetFile = join(root, 'sample.mp4');
  writeFileSync(assetFile, Buffer.from('0123456789abcdef', 'utf8'));

  const projects = new VideoProjects({ workspaceRoot: () => root });
  const proj = projects.create({ botId: 'bot-1', title: 'Proto' });
  const { asset, project: afterImport } = await projects.importAsset({
    projectId: proj.id,
    source: { kind: 'host', path: assetFile },
  });

  const mediaTokens = new VideoMediaTokenRegistry();
  const tokenReg = mediaTokens.registerFile(assetFile, 'video/mp4');
  const handle = createVideoEngineProtocolHandler({ runtimeDir, projects, mediaTokens });

  // Engine HTML & Player HTML CSP + frame-ancestors
  const engineRes = handle(new Request('aelion-video://engine/index.html'));
  assert.equal(engineRes.status, 200);
  assert.match(engineRes.headers.get('content-security-policy') || '', /script-src 'self'/);

  const playerRes = handle(new Request(`aelion-video://player/index.html?projectId=${proj.id}`));
  assert.equal(playerRes.status, 200);
  assert.match(
    playerRes.headers.get('content-security-policy') || '',
    /frame-ancestors 'self' file: http:\/\/127\.0\.0\.1:\*/,
  );

  // Same-origin worker on player host & traversal defense
  const workerRes = handle(new Request('aelion-video://player/video-runtime/webgl2-worker.js'));
  assert.equal(workerRes.status, 200);
  assert.equal(await workerRes.text(), 'console.log("worker");');
  const encodedTraversal = handle(new Request('aelion-video://video-runtime/%2e%2e%2fsecret.js'));
  assert.equal(encodedTraversal.status, 403);
  const normalizedMissing = handle(new Request('aelion-video://video-runtime/../secret.js'));
  assert.equal(normalizedMissing.status, 404);

  // Project JSON endpoint
  const projRes = handle(new Request(`aelion-video://project/${proj.id}/project.json`));
  assert.equal(projRes.status, 200);
  const projJson = (await projRes.json()) as {
    project: unknown;
    revision: string;
    assets: Record<string, { url: string }>;
  };
  assert.equal(projJson.revision, afterImport.revision);
  assert.ok(projJson.assets[asset.id]?.url.startsWith('aelion-video://asset/'));

  // Asset HEAD + 206 Partial Content + 416 + CORS/CORP
  const assetUrl = `aelion-video://asset/${proj.id}/${asset.id}`;
  const headRes = handle(new Request(assetUrl, { method: 'HEAD' }));
  assert.equal(headRes.status, 200);
  assert.equal(headRes.headers.get('content-length'), '16');
  assert.equal(headRes.headers.get('accept-ranges'), 'bytes');
  assert.equal(headRes.headers.get('access-control-allow-origin'), '*');
  assert.equal(headRes.headers.get('cross-origin-resource-policy'), 'cross-origin');

  const rangeRes = handle(new Request(assetUrl, { headers: { Range: 'bytes=2-5' } }));
  assert.equal(rangeRes.status, 206);
  assert.equal(rangeRes.headers.get('content-range'), 'bytes 2-5/16');
  assert.equal(await rangeRes.text(), '2345');

  const badRange = handle(new Request(assetUrl, { headers: { Range: 'bytes=100-200' } }));
  assert.equal(badRange.status, 416);

  // Ephemeral media token range
  const tokenRange = handle(new Request(tokenReg.url, { headers: { Range: 'bytes=0-3' } }));
  assert.equal(tokenRange.status, 206);
  assert.equal(await tokenRange.text(), '0123');
  tokenReg.release();

  // MediaStreamRegistry CORS/CORP + OPTIONS preflight
  const mediaStreams = new MediaStreamRegistry();
  const streamUrl = mediaStreams.register({ kind: 'buffer', bytes: Buffer.from('abcdef'), mime: 'video/mp4' });
  const optRes = mediaStreams.handle(new Request(streamUrl, { method: 'OPTIONS' }));
  assert.equal(optRes.status, 204);
  assert.equal(optRes.headers.get('access-control-allow-origin'), '*');
  const msRange = mediaStreams.handle(new Request(streamUrl, { headers: { Range: 'bytes=1-3' } }));
  assert.equal(msRange.status, 206);
  assert.equal(msRange.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal(await msRange.text(), 'bcd');
});

test('VideoProjects blocks path traversal, sanitizes asset filenames, and keeps move_clip ripple transitions synced', async (t) => {
  const root = tempDir(t, 'aelion-vid-sec-');
  const siblingSecret = join(root, 'videos', 'secret-folder');
  mkdirSync(siblingSecret, { recursive: true });
  writeFileSync(join(siblingSecret, 'keep.txt'), 'do-not-delete', 'utf8');

  const projects = new VideoProjects({ workspaceRoot: () => root });
  const proj = projects.create({ botId: 'bot-a', title: 'Security Test', aspect: '16:9', fps: 30 });

  // 1. Path traversal attempts on get / delete / protocol must fail safely without touching sibling dirs
  for (const badId of ['../secret-folder', '..\\secret-folder', '..', 'a/b', 'bad:id']) {
    assert.throws(
      () => projects.get(badId),
      (err: unknown) => err instanceof AppError && err.code === 'video.project_not_found',
    );
    assert.throws(
      () => projects.delete(badId),
      (err: unknown) => err instanceof AppError && err.code === 'video.project_not_found',
    );
  }
  assert.equal(existsSync(join(siblingSecret, 'keep.txt')), true, 'sibling directory must remain untouched');

  const runtimeDir = join(root, 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  const handle = createVideoEngineProtocolHandler({
    runtimeDir,
    projects,
    mediaTokens: new VideoMediaTokenRegistry(),
  });
  const protoTraversal = handle(new Request('aelion-video://project/..%2Fsecret-folder/project.json'));
  assert.equal(protoTraversal.status, 404);

  // 2. Malicious asset name / extension / assetId are sanitized strictly inside <project>/assets/
  const rawClip = join(root, 'clip.mp4');
  writeFileSync(rawClip, Buffer.from('mp4-bytes-1'));
  const imp = await projects.importAsset(
    {
      projectId: proj.id,
      source: { kind: 'host', path: rawClip },
      name: 'evil/../../escape.mp4?query=1',
      assetId: 'clip:bad..id',
    },
    { durationUs: 3_000_000, width: 1280, height: 720, hasAudio: false },
  );
  const resolved = projects.resolveAssetPath(proj.id, imp.asset.id);
  const assetsRoot = resolve(projects.projectDir(proj.id), 'assets');
  assert.ok(resolved.path.startsWith(assetsRoot + sep), 'asset file must live strictly inside assets/');
  assert.ok(!resolved.path.slice(assetsRoot.length).includes(':'), 'asset filename must be Windows-safe');
  assert.ok(resolved.path.endsWith('.mp4'), 'malicious extension falls back to safe media extension');

  // 3. move_clip with ripple=true shifts downstream clips AND transitions together
  const clip2Path = join(root, 'clip2.mp4');
  const clip3Path = join(root, 'clip3.mp4');
  writeFileSync(clip2Path, Buffer.from('mp4-bytes-2'));
  writeFileSync(clip3Path, Buffer.from('mp4-bytes-3'));
  const imp2 = await projects.importAsset(
    { projectId: proj.id, source: { kind: 'host', path: clip2Path } },
    { durationUs: 2_000_000, width: 1280, height: 720, hasAudio: false },
  );
  const imp3 = await projects.importAsset(
    { projectId: proj.id, source: { kind: 'host', path: clip3Path } },
    { durationUs: 2_000_000, width: 1280, height: 720, hasAudio: false },
  );

  let edited = projects.edit({
    projectId: proj.id,
    operations: [
      { op: 'add_clip', clipId: 'c1', assetId: imp.asset.id, startUs: 0, durationUs: 2_000_000 },
      { op: 'add_clip', clipId: 'c2', assetId: imp2.asset.id, startUs: 2_000_000, durationUs: 2_000_000 },
      { op: 'add_clip', clipId: 'c3', assetId: imp3.asset.id, startUs: 4_000_000, durationUs: 2_000_000 },
      { op: 'set_transition', fromClipId: 'c2', toClipId: 'c3', preset: 'cross-dissolve', durationUs: 400_000 },
    ],
  });

  // Shift c1 forward by +1s with ripple: true -> c2 moves to 3s, c3 moves to 5s, transition shifts to 4.8s
  edited = projects.edit({
    projectId: proj.id,
    expectedRevision: edited.revision,
    operations: [{ op: 'move_clip', clipId: 'c1', startUs: 1_000_000, ripple: true }],
  });
  const mainTrack = edited.project.tracks.find((tr) => tr.id === STANDARD_TRACK_IDS.videoMain)!;
  const byId = Object.fromEntries(mainTrack.clips.map((c) => [c.id, c]));
  assert.equal(byId.c1!.startUs, 1_000_000);
  assert.equal(byId.c2!.startUs, 3_000_000);
  assert.equal(byId.c3!.startUs, 5_000_000);
  assert.equal(byId.c2!.transitionOut?.preset, 'cross-dissolve');
  assert.equal(byId.c3!.transitionIn?.preset, 'cross-dissolve');
  const transitions = Object.values(
    (edited.project.projectJson.transitions as Record<string, { range: { startUs: number; durationUs: number } }>) ||
      {},
  );
  assert.equal(transitions.length, 1);
  // Original cut was at 4_000_000 (transition range.startUs = 3_800_000), shifted +1_000_000 -> 4_800_000
  assert.equal(transitions[0]!.range.startUs, 4_800_000);
});
