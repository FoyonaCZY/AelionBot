import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { tempDir, until } from './helpers';
import { AppError } from '../shared/errors';
import {
  coalesceVmEvents,
  formatKeyChord,
  interleaveTeachingTimeline,
  mapCanvasPoint,
} from '../shared/teaching/teaching-events';
import { TEACHING_LIMITS } from '../shared/types/teaching-types';
import { wavFile } from '../electron/core/speech/speech-audio';
import { speechSegments } from '../electron/core/speech/speech-timeline';
import { SpeechService } from '../electron/core/speech/speech-service';
import { disposeModelHttp } from '../electron/core/model/model-http';
import type { DesktopDriver, DesktopProbe, DesktopWindow } from '../electron/core/host/desktop/desktop-helper';
import { TeachingService } from '../electron/core/teaching/teaching-service';
import { Store } from '../electron/core/storage/store';
import { Attachments } from '../electron/core/attachments/attachments';

test.after(() => disposeModelHttp());

/** Minimal valid PNG bytes (2x2) with authentic header + IHDR dimensions for testing. */
function fakePng(width = 1440, height = 900) {
  const bytes = Buffer.alloc(32);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** Synthesizes 16-bit mono PCM with loud tone inside `[startSec, endSec)` intervals and digital silence elsewhere. */
function toneIntervals(sampleRate: number, totalSeconds: number, intervals: Array<[number, number]>) {
  const samples = new Int16Array(Math.round(sampleRate * totalSeconds));
  for (const [startSec, endSec] of intervals) {
    const start = Math.max(0, Math.round(startSec * sampleRate)),
      end = Math.min(samples.length, Math.round(endSec * sampleRate));
    for (let i = start; i < end; i++) {
      samples[i] = i % 2 === 0 ? 8000 : -8000;
    }
  }
  return samples;
}

test('speechSegments skips pure silence, isolates spoken phrases across pauses, and splits long speech <= 15s', () => {
  const rate = 8000;
  // Empty and pure silence produce zero segments.
  assert.deepEqual(speechSegments(new Int16Array(0), rate), []);
  assert.deepEqual(speechSegments(new Int16Array(rate * 5), rate), []);

  // Three distinct phrases separated by long silent clicking pauses.
  const narrated = toneIntervals(rate, 20, [
    [1, 3.5],
    [7, 10.5],
    [15, 18],
  ]);
  const ranges = speechSegments(narrated, rate);
  assert.equal(ranges.length, 3);
  assert.ok(ranges[0][0] <= 1.1 * rate && ranges[0][1] >= 3.4 * rate);
  assert.ok(ranges[1][0] >= 6.8 * rate && ranges[1][0] <= 7.1 * rate);
  assert.ok(ranges[2][0] >= 14.8 * rate && ranges[2][0] <= 15.1 * rate);

  // Continuous 34 s speech with brief dips splits into chunks <= 15 s.
  const continuous = toneIntervals(rate, 34, [[0, 34]]);
  const pieces = speechSegments(continuous, rate, { maxSeconds: 15 });
  assert.ok(pieces.length >= 3);
  for (const [start, end] of pieces) {
    assert.ok((end - start) / rate <= 15.05);
  }
});

test('SpeechService.transcribeTimeline skips silent pauses and returns fine-grained [m:ss] segments', async (t) => {
  const rate = 8000;
  const calls: number[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const form = init?.body as FormData;
    const file = form.get('file') as File;
    const bytes = Buffer.from(await file.arrayBuffer());
    calls.push(bytes.length);
    return new Response(JSON.stringify({ text: `段落 ${calls.length}` }), { status: 200 });
  }) as typeof fetch;
  t.after(() => (globalThis.fetch = originalFetch));

  const service = new SpeechService({
    speechAccess: () => ({
      protocol: 'openai-audio',
      baseUrl: 'https://api.openai.com/v1',
      key: 'sk-test',
      model: 'gpt-4o-mini-transcribe',
    }),
  });

  // Pure silence makes zero ASR requests.
  const silent = await service.transcribeTimeline(
    wavFile(new Int16Array(rate * 6), rate),
    new AbortController().signal,
  );
  assert.equal(silent.segments.length, 0);
  assert.equal(silent.text, '');
  assert.equal(calls.length, 0);

  // Two spoken phrases separated by a 6-second clicking silence.
  const samples = toneIntervals(rate, 16, [
    [2, 5],
    [11, 14],
  ]);
  const result = await service.transcribeTimeline(wavFile(samples, rate), new AbortController().signal);
  assert.equal(calls.length, 2);
  assert.equal(result.segments.length, 2);
  assert.equal(result.segments[0].clock, '0:01');
  assert.equal(result.segments[1].clock, '0:10');
  assert.match(result.text, /\[0:01\] 段落 1\n\[0:10\] 段落 2/);
});

const OWN_EXE = 'C:\\Program Files\\AelionBot\\AelionBot.exe';
const win = (id: number, exe: string, title: string, extra: Partial<DesktopWindow> = {}): DesktopWindow => ({
  id,
  title,
  className: 'App',
  pid: id * 10,
  exe,
  name: exe
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.exe$/i, ''),
  minimized: false,
  foreground: true,
  elevated: false,
  x: 0,
  y: 0,
  width: 1280,
  height: 800,
  ...extra,
});

test('host teaching records click edges, redacts password fields, caps keyframes <= 12, and cleans up on cancel', async (t) => {
  const dir = tempDir(t, 'aelion-teach-host-');
  const notesWin = win(10, 'C:\\Apps\\Notes.exe', 'Monthly Report');
  const ownWin = win(11, OWN_EXE, 'AelionBot');
  const termWin = win(12, 'C:\\Windows\\System32\\cmd.exe', 'Command Prompt');

  let clockNow = 1000;
  let currentProbe: DesktopProbe = { x: 100, y: 100, buttons: 0, foreground: notesWin };
  let inspectControl: DesktopProbe['control'] = { type: 'Button', name: 'Export' };
  let captureCount = 0;

  const driver: DesktopDriver = {
    quietLaunch: false,
    status: async () => ({ elevated: false, display: [0, 0, 1920, 1080] }),
    listWindows: async () => [notesWin, ownWin, termWin],
    listApps: async () => [],
    launch: async () => {},
    window: async (id) => {
      const found = [notesWin, ownWin, termWin].find((w) => w.id === id);
      if (!found) throw new AppError('computer.host_window_gone', 'gone');
      return found;
    },
    foreground: async () => currentProbe.foreground,
    probe: async (options) => ({
      ...currentProbe,
      ...(options?.inspect ? { control: inspectControl } : {}),
    }),
    capture: async (id, file) => {
      captureCount++;
      writeFileSync(file, fakePng(800, 600));
      return {
        ...notesWin,
        id,
        originX: 0,
        originY: 0,
        scale: 1,
        imageWidth: 800,
        imageHeight: 600,
      };
    },
    input: async () => {},
    press: async () => {},
    scroll: async () => {},
    setValue: async () => {},
    dispose: () => {},
  };

  const service = new TeachingService({
    dataDir: dir,
    driver,
    ownExe: OWN_EXE,
    attachments: { importFiles: () => [] },
    send: () => {},
    hasBot: (id) => id === 'bot-1',
    pollIntervalMs: 20,
    keyframeDebounceMs: 0,
    now: () => clockNow,
  });
  t.after(() => service.dispose());

  // Lists only allowed windows (excludes AelionBot & cmd.exe).
  const listed = await service.listHostWindows();
  assert.equal(listed.available, true);
  assert.deepEqual(
    listed.windows.map((item) => item.id),
    [10],
  );

  // Blocked window cannot be started.
  await assert.rejects(service.start({ botId: 'bot-1', target: 'host', windowId: 12 }), {
    code: 'teaching.app_blocked',
  });

  // Start recording following active windows.
  const started = await service.start({ botId: 'bot-1', target: 'host' });
  await assert.rejects(service.start({ botId: 'bot-1', target: 'host' }), { code: 'teaching.already_active' });

  // Wait for initial window_focus step.
  await until(() => (service.status(started.sessionId)?.stepCount || 0) >= 1);

  // Simulate 14 clicks (more than TEACHING_LIMITS.maxKeyframes = 12), including one on a password field.
  for (let i = 0; i < 14; i++) {
    clockNow += 1000;
    inspectControl =
      i === 2
        ? { type: 'Edit', name: 'Secret Password', value: 'super-secret-123', password: true }
        : { type: 'Button', name: `Action ${i + 1}` };
    currentProbe = { x: 200 + i * 20, y: 150, buttons: 1, foreground: notesWin };
    const before = service.status(started.sessionId)!.stepCount;
    await new Promise((r) => setTimeout(r, 35));
    clockNow += 120;
    currentProbe = { x: 200 + i * 20, y: 150, buttons: 0, foreground: notesWin };
    await until(() => (service.status(started.sessionId)?.stepCount || 0) > before);
  }

  // Clicks on AelionBot itself must be ignored.
  const countBeforeOwn = service.status(started.sessionId)!.stepCount;
  clockNow += 1000;
  currentProbe = { x: 50, y: 50, buttons: 1, foreground: ownWin };
  await new Promise((r) => setTimeout(r, 35));
  currentProbe = { x: 50, y: 50, buttons: 0, foreground: ownWin };
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(service.status(started.sessionId)!.stepCount, countBeforeOwn);

  const draft = await service.finish({ sessionId: started.sessionId, durationMs: 18000 });
  assert.ok(captureCount > TEACHING_LIMITS.maxKeyframes);
  assert.ok(draft.keyframes.length <= TEACHING_LIMITS.maxKeyframes);
  const passwordStep = draft.steps.find((step) => step.control?.password);
  assert.ok(passwordStep, 'password field click should be recorded');
  assert.equal(passwordStep.control?.value, undefined, 'password value must never be stored');
  assert.ok(!passwordStep.summary.includes('super-secret-123'));

  // Cancel cleans up the draft's temporary directory.
  const draftDir = join(dir, 'teaching', draft.draftId);
  assert.equal(existsSync(draftDir), true);
  await service.cancel(draft.draftId);
  assert.equal(existsSync(draftDir), false);

  // Active session cancel cleans up immediately.
  const second = await service.start({ botId: 'bot-1', target: 'host', windowId: 10 });
  const secondDir = join(dir, 'teaching', second.sessionId);
  assert.equal(existsSync(secondDir), true);
  await service.cancel(second.sessionId);
  assert.equal(existsSync(secondDir), false);
  assert.equal(service.status(second.sessionId), null);
});

test('VM event coalescing merges typing with backspace, normalizes canvas coordinates, and handles shortcuts', () => {
  // Coordinate normalization onto 1440x900 framebuffer.
  assert.deepEqual(mapCanvasPoint(360, 225, { left: 0, top: 0, width: 720, height: 450 }, 1440, 900), {
    x: 720,
    y: 450,
  });
  assert.equal(mapCanvasPoint(-5, 10, { left: 0, top: 0, width: 720, height: 450 }, 1440, 900), undefined);
  assert.equal(formatKeyChord({ key: 's', ctrl: true }), 'CTRL+S');
  assert.equal(formatKeyChord({ key: 'Shift', shift: true }), undefined);

  const steps = coalesceVmEvents([
    { atMs: 1000, kind: 'click', x: 300, y: 200, windowTitle: 'LibreOffice Calc', keyframeId: 'kf-1' },
    { atMs: 1200, kind: 'key', key: 'h', printable: 'h', windowTitle: 'LibreOffice Calc' },
    { atMs: 1300, kind: 'key', key: 'e', printable: 'e', windowTitle: 'LibreOffice Calc' },
    { atMs: 1400, kind: 'key', key: 'x', printable: 'x', windowTitle: 'LibreOffice Calc' },
    { atMs: 1500, kind: 'key', key: 'Backspace', windowTitle: 'LibreOffice Calc' },
    { atMs: 1600, kind: 'key', key: 'l', printable: 'l', windowTitle: 'LibreOffice Calc' },
    { atMs: 1700, kind: 'key', key: 'l', printable: 'l', windowTitle: 'LibreOffice Calc' },
    { atMs: 1800, kind: 'key', key: 'o', printable: 'o', windowTitle: 'LibreOffice Calc' },
    { atMs: 2000, kind: 'key', key: 's', ctrl: true, windowTitle: 'LibreOffice Calc' },
    { atMs: 2500, kind: 'scroll', x: 500, y: 400, direction: 'down', amount: 2, windowTitle: 'LibreOffice Calc' },
    { atMs: 2700, kind: 'scroll', x: 500, y: 400, direction: 'down', amount: 3, windowTitle: 'LibreOffice Calc' },
    { atMs: 4000, kind: 'click', x: 120, y: 80, windowTitle: 'Files' },
  ]);

  assert.deepEqual(
    steps.map((step) => [step.kind, step.text ?? step.key ?? step.amount ?? step.windowTitle]),
    [
      ['window_focus', 'LibreOffice Calc'],
      ['click', 'LibreOffice Calc'],
      ['type_text', 'hello'],
      ['press_key', 'CTRL+S'],
      ['scroll', 5],
      ['window_focus', 'Files'],
      ['click', 'Files'],
    ],
  );
});

test('chronological interleaving and sendDraft attach bounded keyframes and deliver unified Bot prompt', async (t) => {
  const dir = tempDir(t, 'aelion-teach-send-');
  const store = new Store(dir);
  t.after(() => store.close());
  const bot = store.data.bots[0];
  const attachments = new Attachments(store);
  const sent: Array<{ botId: string; sessionId?: string; message: string; attachmentIds?: string[] }> = [];

  // Mock speech service that succeeds with two timestamped narration segments.
  const speech = {
    available: () => true,
    transcribeTimeline: async () => ({
      segments: [
        { startMs: 1000, endMs: 3500, clock: '0:01', text: '先打开报表文件夹' },
        { startMs: 7000, endMs: 10000, clock: '0:07', text: '再按 Ctrl+S 保存导出结果' },
      ],
      text: '[0:01] 先打开报表文件夹\n[0:07] 再按 Ctrl+S 保存导出结果',
      seconds: 12,
    }),
  };

  const service = new TeachingService({
    dataDir: dir,
    speech,
    attachments,
    send: (payload) => sent.push(payload),
    hasBot: (id) => id === bot.id,
    vm: {
      isReady: () => true,
      activeWindowTitle: async () => 'Files',
    },
  });
  t.after(() => service.dispose());

  const session = await service.start({ botId: bot.id, target: 'vm' });
  const pngBase64 = fakePng(1440, 900).toString('base64');
  // Supply 14 valid keyframes + 1 invalid frame to verify bounding <= 12 in draft and <= 10 when sent.
  const clientFrames = [
    ...Array.from({ length: 14 }, (_, i) => ({
      id: `kf-${i + 1}`,
      atMs: i * 1000,
      label: `画面 ${i + 1}`,
      pngBase64,
    })),
    { id: 'bad', atMs: 500, label: 'bad', pngBase64: Buffer.from('not-a-png').toString('base64') },
  ];

  const draft = await service.finish({
    sessionId: session.sessionId,
    durationMs: 14000,
    audio: new Uint8Array([1, 2, 3, 4]),
    events: [
      { atMs: 2500, kind: 'click', x: 400, y: 300, windowTitle: 'Files', keyframeId: 'kf-1' },
      { atMs: 8500, kind: 'key', key: 's', ctrl: true, windowTitle: 'Files' },
    ],
    keyframes: clientFrames,
  });

  assert.equal(draft.keyframes.length, TEACHING_LIMITS.maxKeyframes);
  assert.equal(draft.narration.length, 2);

  // Verify chronological interleaving: 0:01 narration -> 0:02 window_focus/click -> 0:07 narration -> 0:08 CTRL+S.
  const timeline = interleaveTeachingTimeline(draft.steps, draft.narration);
  assert.deepEqual(
    timeline.map((item) => [item.kind, item.clock]),
    [
      ['narration', '0:01'],
      ['step', '0:02'],
      ['step', '0:02'],
      ['narration', '0:07'],
      ['step', '0:08'],
    ],
  );

  // Attempt to send all 12 keyframes -> service caps attachments at 10 (ATTACHMENT_LIMITS.count).
  const result = service.sendDraft({
    draftId: draft.draftId,
    title: '月度报表导出',
    notes: '每月 1 号执行',
    narration: draft.narration,
    selectedKeyframeIds: draft.keyframes.map((frame) => frame.id),
  });

  assert.equal(result.attachmentCount, TEACHING_LIMITS.maxAttachedKeyframes);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].botId, bot.id);
  assert.equal(sent[0].attachmentIds?.length, TEACHING_LIMITS.maxAttachedKeyframes);
  // Attachments must be valid draft attachments belonging to this Bot.
  const draftAttachments = attachments.forDraft({ kind: 'bot', id: bot.id }, sent[0].attachmentIds);
  assert.equal(draftAttachments.length, TEACHING_LIMITS.maxAttachedKeyframes);
  assert.match(sent[0].message, /\[0:01\] 🎙️ 口述: 先打开报表文件夹/);
  assert.match(sent[0].message, /\[0:02\] 🖱️ 操作:/);
  assert.match(sent[0].message, /\[0:07\] 🎙️ 口述: 再按 Ctrl\+S 保存导出结果/);
  assert.match(sent[0].message, /\[0:08\] 🖱️ 操作: 按键 CTRL\+S/);
  assert.match(sent[0].message, /skill_save/);
  assert.match(sent[0].message, /月度报表导出/);

  // Draft cannot be sent twice.
  assert.throws(
    () =>
      service.sendDraft({
        draftId: draft.draftId,
        narration: [],
        selectedKeyframeIds: [],
      }),
    { code: 'teaching.draft_not_found' },
  );
});

test('VM teaching preserves recorded steps and screenshots gracefully when ASR fails', async (t) => {
  const dir = tempDir(t, 'aelion-teach-asr-fail-');
  const service = new TeachingService({
    dataDir: dir,
    speech: {
      available: () => true,
      transcribeTimeline: async () => {
        throw new AppError('speech.balance', 'balance empty');
      },
    },
    attachments: { importFiles: () => [] },
    send: () => {},
    hasBot: () => true,
    vm: {
      isReady: () => true,
      activeWindowTitle: async () => 'Browser',
    },
  });
  t.after(() => service.dispose());

  const session = await service.start({ botId: 'bot-1', target: 'vm' });
  const draft = await service.finish({
    sessionId: session.sessionId,
    durationMs: 5000,
    audio: new Uint8Array([9, 9, 9]),
    events: [{ atMs: 1200, kind: 'click', x: 100, y: 200, windowTitle: 'Browser', keyframeId: 'k1' }],
    keyframes: [{ id: 'k1', atMs: 1200, label: '点击', pngBase64: fakePng().toString('base64') }],
  });

  assert.equal(draft.narration.length, 0);
  assert.ok(draft.narrationWarning, 'ASR error should be reported as a non-fatal warning');
  assert.equal(draft.steps.length, 2);
  assert.equal(draft.keyframes.length, 1);
});
