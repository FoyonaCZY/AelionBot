// Teach by Showing service: records user demonstrations on either this computer (Windows/macOS via non-blocking
// DesktopDriver.probe + window captures) or the Linux work computer VM (client VNC events + keyframes + active X11
// title), transcribes simultaneous voice narration into a fine-grained [m:ss] timeline, and delivers a unified
// chronological packet + keyframe image attachments to the Bot so it saves a reusable private skill.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../../shared/errors';
import {
  coalesceVmEvents,
  describeHostControl,
  formatTeachingClock,
  formatTeachingPrompt,
  selectBoundedItems,
} from '../../../shared/teaching/teaching-events';
import {
  TEACHING_LIMITS,
  type TeachingClientKeyframe,
  type TeachingDraft,
  type TeachingFinishInput,
  type TeachingHostControl,
  type TeachingKeyframePreview,
  type TeachingListWindowsResult,
  type TeachingNarrationSegment,
  type TeachingSendInput,
  type TeachingSessionInfo,
  type TeachingStartInput,
  type TeachingStep,
  type TeachingTarget,
} from '../../../shared/types/teaching-types';
import type { Attachment, AttachmentScope, AttachmentUpload } from '../../../shared/types/attachment-types';
import type { DesktopDriver, DesktopProbe, DesktopProbeControl, DesktopWindow } from '../host/desktop/desktop-helper';
import { blockedApp } from '../host/desktop/host-desktop';
import type { SpeechService } from '../speech/speech-service';

interface TeachingVmBridge {
  isReady(): boolean;
  activeWindowTitle(botId: string, signal?: AbortSignal): Promise<string | undefined>;
  screenshot?(botId: string, signal: AbortSignal): Promise<Buffer>;
}

export interface TeachingServiceOptions {
  dataDir: string;
  driver?: DesktopDriver;
  ownExe?: string;
  speech?: Pick<SpeechService, 'available' | 'transcribeTimeline'>;
  attachments: { importFiles(scope: AttachmentScope, files: AttachmentUpload[]): Attachment[] };
  send(input: { botId: string; sessionId?: string; message: string; attachmentIds?: string[] }): void;
  hasBot(botId: string): boolean;
  hasSession?(botId: string, sessionId: string): boolean;
  vm?: TeachingVmBridge;
  pollIntervalMs?: number;
  keyframeDebounceMs?: number;
  now?: () => number;
}

interface StoredKeyframe {
  id: string;
  atMs: number;
  clock: string;
  label: string;
  width: number;
  height: number;
  file: string;
}

interface ActiveSession {
  sessionId: string;
  botId: string;
  chatSessionId?: string;
  target: TeachingTarget;
  startedAt: number;
  dir: string;
  targetWindowId?: number;
  targetWindowPid?: number;
  targetWindowLabel?: string;
  steps: TeachingStep[];
  keyframes: StoredKeyframe[];
  stepSeq: number;
  keyframeSeq: number;
  lastWindowId?: number;
  lastKeyframeAt: number;
  prevButtons: number;
  down?: {
    atMs: number;
    x: number;
    y: number;
    buttons: number;
    window: DesktopWindow;
    control?: TeachingHostControl;
  };
  lastLeftClick?: { atMs: number; x: number; y: number; stepIndex: number };
  stopped: boolean;
  timer?: ReturnType<typeof setTimeout>;
  inflight: Promise<void>;
}

interface PendingDraft {
  draftId: string;
  botId: string;
  chatSessionId?: string;
  target: TeachingTarget;
  durationMs: number;
  dir: string;
  steps: TeachingStep[];
  narration: TeachingNarrationSegment[];
  narrationWarning?: string;
  keyframes: StoredKeyframe[];
}

const PNG_MAGIC = '89504e470d0a1a0a';
const MAX_CLIENT_KEYFRAME_BYTES = 6 * 1024 * 1024;
const DRAG_THRESHOLD_PX = 24;
const DOUBLE_CLICK_MS = 420;
const DOUBLE_CLICK_PX = 14;
const MAX_DRAFTS = 3;

function pngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24 || bytes.toString('hex', 0, 8) !== PNG_MAGIC) return undefined;
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (width < 2 || height < 2 || width * height > 24_000_000) return undefined;
  return { width, height };
}

function sanitizeControl(raw?: DesktopProbeControl | null): TeachingHostControl | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const type = String(raw.type || '').trim();
  const name = String(raw.name || '').trim();
  const password = raw.password === true;
  // Never store values from password fields, even if a caller/mock accidentally included one.
  const value =
    !password && typeof raw.value === 'string' && raw.value.trim() ? raw.value.trim().slice(0, 80) : undefined;
  if (!type && !name && !value && !password) return undefined;
  return {
    type: type || 'Control',
    ...(name ? { name: name.slice(0, 80) } : {}),
    ...(password ? { password: true } : value ? { value } : {}),
  };
}

function windowDisplayName(win: Pick<DesktopWindow, 'name' | 'title'>) {
  return [win.name, win.title].filter(Boolean).join(' - ') || '窗口';
}

function keyframeFilename(index: number, atMs: number) {
  const whole = Math.max(0, Math.floor(atMs / 1000)),
    minutes = Math.floor(whole / 60),
    seconds = String(whole % 60).padStart(2, '0');
  return `demo-${String(index + 1).padStart(2, '0')}-${minutes}m${seconds}s.png`;
}

export class TeachingService {
  private readonly dir: string;
  private readonly pollIntervalMs: number;
  private readonly keyframeDebounceMs: number;
  private readonly now: () => number;
  private active?: ActiveSession;
  private drafts = new Map<string, PendingDraft>();

  constructor(private options: TeachingServiceOptions) {
    this.dir = join(options.dataDir, 'teaching');
    this.pollIntervalMs = Math.max(20, options.pollIntervalMs ?? 130);
    this.keyframeDebounceMs = Math.max(0, options.keyframeDebounceMs ?? 700);
    this.now = options.now ?? (() => Date.now());
  }

  private permissionMessage(status: { accessibility?: boolean; screenRecording?: boolean }) {
    const missing = [
      status.accessibility === false && '辅助功能',
      status.screenRecording === false && '屏幕录制',
    ].filter(Boolean);
    if (!missing.length) return undefined;
    return `macOS 还没有允许 AelionBot 使用${missing.join('和')}，请在 设置 → 权限 中授权后再演示`;
  }

  async listHostWindows(): Promise<TeachingListWindowsResult> {
    const driver = this.options.driver;
    if (!driver) return { available: false, windows: [] };
    try {
      const status = await driver.status();
      const permissionIssue = this.permissionMessage(status);
      if (permissionIssue) return { available: true, permissionIssue, windows: [] };
      const all = await driver.listWindows();
      const windows = all
        .filter((win) => Boolean(win.exe) && !blockedApp(win.exe, this.options.ownExe))
        .map((win) => ({
          id: win.id,
          app: win.name || win.className || '应用',
          title: win.title,
          ...(win.minimized ? { minimized: true } : {}),
        }));
      return { available: true, windows };
    } catch (error) {
      return {
        available: true,
        permissionIssue: (error as Error).message || '无法读取本机窗口列表',
        windows: [],
      };
    }
  }

  private sessionInfo(session: ActiveSession): TeachingSessionInfo {
    return {
      sessionId: session.sessionId,
      botId: session.botId,
      ...(session.chatSessionId ? { chatSessionId: session.chatSessionId } : {}),
      target: session.target,
      startedAt: session.startedAt,
      ...(session.targetWindowId !== undefined ? { targetWindowId: session.targetWindowId } : {}),
      ...(session.targetWindowLabel ? { targetWindowLabel: session.targetWindowLabel } : {}),
      stepCount: session.steps.length,
      keyframeCount: session.keyframes.length,
    };
  }

  status(sessionId: string): TeachingSessionInfo | null {
    if (!this.active || this.active.sessionId !== sessionId) return null;
    return this.sessionInfo(this.active);
  }

  async start(input: TeachingStartInput): Promise<TeachingSessionInfo> {
    if (!input || typeof input.botId !== 'string' || !this.options.hasBot(input.botId))
      throw new AppError('teaching.bot_not_found', '找不到要教导的 Bot');
    if (input.chatSessionId && this.options.hasSession && !this.options.hasSession(input.botId, input.chatSessionId))
      throw new AppError('session.not_found', '工作会话不存在');
    if (input.target !== 'host' && input.target !== 'vm')
      throw new AppError('teaching.invalid_target', '无效的演示目标');
    if (this.active) throw new AppError('teaching.already_active', '当前已有正在进行的演示录制');

    let targetWindowId: number | undefined;
    let targetWindowPid: number | undefined;
    let targetWindowLabel: string | undefined;

    if (input.target === 'host') {
      const driver = this.options.driver;
      if (!driver) throw new AppError('teaching.host_unavailable', '这台电脑暂不支持本机演示录制');
      const status = await driver.status();
      const permissionIssue = this.permissionMessage(status);
      if (permissionIssue) throw new AppError('teaching.host_permission', permissionIssue);
      if (input.windowId !== undefined && input.windowId !== null) {
        if (!Number.isInteger(input.windowId)) throw new AppError('teaching.invalid_window', '无效的本机窗口');
        const win = await driver.window(input.windowId);
        const blocked = blockedApp(win.exe, this.options.ownExe);
        if (blocked) throw new AppError('teaching.app_blocked', blocked);
        targetWindowId = win.id;
        targetWindowPid = win.pid;
        targetWindowLabel = windowDisplayName(win);
      }
    } else if (!this.options.vm?.isReady()) {
      throw new AppError('teaching.vm_not_ready', '请先启动工作电脑，再进行工作电脑演示');
    }

    const sessionId = randomUUID(),
      dir = join(this.dir, sessionId);
    mkdirSync(dir, { recursive: true });

    const session: ActiveSession = {
      sessionId,
      botId: input.botId,
      ...(input.chatSessionId ? { chatSessionId: input.chatSessionId } : {}),
      target: input.target,
      startedAt: this.now(),
      dir,
      targetWindowId,
      targetWindowPid,
      targetWindowLabel,
      steps: [],
      keyframes: [],
      stepSeq: 1,
      keyframeSeq: 1,
      lastKeyframeAt: -Infinity,
      prevButtons: 0,
      stopped: false,
      inflight: Promise.resolve(),
    };
    this.active = session;

    if (input.target === 'host') {
      if (targetWindowId !== undefined) {
        const win = await this.options.driver!.window(targetWindowId).catch(() => undefined);
        if (win) {
          session.lastWindowId = win.id;
          const kf = await this.captureHostKeyframe(session, win, 0, `开始演示：${windowDisplayName(win)}`, true);
          this.pushHostStep(session, {
            atMs: 0,
            kind: 'window_focus',
            summary: `开始演示：${windowDisplayName(win)}`,
            windowTitle: win.title,
            appName: win.name,
            keyframeId: kf?.id,
          });
        }
      }
      this.scheduleHostPoll(session);
    }

    return this.sessionInfo(session);
  }

  private scheduleHostPoll(session: ActiveSession) {
    if (session.stopped || this.active !== session) return;
    session.timer = setTimeout(() => {
      if (session.stopped || this.active !== session) return;
      session.inflight = this.pollHostOnce(session)
        .catch(() => {})
        .finally(() => {
          if (!session.stopped && this.active === session) this.scheduleHostPoll(session);
        });
    }, this.pollIntervalMs);
    session.timer.unref?.();
  }

  private isAllowedHostWindow(session: ActiveSession, win: DesktopWindow | null | undefined): win is DesktopWindow {
    if (!win || !win.exe || blockedApp(win.exe, this.options.ownExe)) return false;
    if (session.targetWindowId !== undefined) {
      return (
        win.id === session.targetWindowId ||
        (session.targetWindowPid !== undefined && win.pid === session.targetWindowPid)
      );
    }
    return true;
  }

  private pushHostStep(session: ActiveSession, step: Omit<TeachingStep, 'id' | 'clock' | 'target'>) {
    const entry: TeachingStep = {
      ...step,
      id: `host-${session.stepSeq++}`,
      clock: formatTeachingClock(step.atMs),
      target: 'host',
    };
    session.steps.push(entry);
    return entry;
  }

  private retainHostKeyframes(session: ActiveSession) {
    if (session.keyframes.length <= TEACHING_LIMITS.maxKeyframes) return;
    const kept = selectBoundedItems(session.keyframes, TEACHING_LIMITS.maxKeyframes);
    const keptIds = new Set(kept.map((item) => item.id));
    for (const frame of session.keyframes) {
      if (!keptIds.has(frame.id)) {
        try {
          rmSync(frame.file, { force: true });
        } catch {}
      }
    }
    session.keyframes = kept;
    for (const step of session.steps) {
      if (step.keyframeId && !keptIds.has(step.keyframeId)) delete step.keyframeId;
    }
  }

  private async captureHostKeyframe(
    session: ActiveSession,
    win: DesktopWindow,
    atMs: number,
    label: string,
    force = false,
  ): Promise<StoredKeyframe | undefined> {
    if (session.stopped) return undefined;
    if (!force && atMs - session.lastKeyframeAt < this.keyframeDebounceMs) return undefined;
    const driver = this.options.driver;
    if (!driver) return undefined;
    const id = `kf-${session.keyframeSeq++}`,
      file = join(session.dir, `${id}.png`);
    try {
      const captured = await driver.capture(win.id, file, { text: false, front: false });
      if (session.stopped) {
        try {
          rmSync(file, { force: true });
        } catch {}
        return undefined;
      }
      let width = captured.imageWidth || 0,
        height = captured.imageHeight || 0;
      if (existsSync(file)) {
        const dims = pngDimensions(readFileSync(file));
        if (dims) {
          width = dims.width;
          height = dims.height;
        }
      }
      if (!existsSync(file)) return undefined;
      const frame: StoredKeyframe = {
        id,
        atMs,
        clock: formatTeachingClock(atMs),
        label,
        width: width || 1,
        height: height || 1,
        file,
      };
      session.lastKeyframeAt = atMs;
      session.keyframes.push(frame);
      this.retainHostKeyframes(session);
      return frame;
    } catch {
      try {
        rmSync(file, { force: true });
      } catch {}
      return undefined;
    }
  }

  private async pollHostOnce(session: ActiveSession) {
    const driver = this.options.driver;
    if (!driver || session.stopped) return;
    const atMs = Math.max(0, this.now() - session.startedAt);
    if (atMs >= TEACHING_LIMITS.maxDurationMs) {
      session.stopped = true;
      return;
    }

    let probe: DesktopProbe;
    if (driver.probe) {
      probe = await driver.probe({ inspect: false });
    } else {
      probe = { x: 0, y: 0, buttons: 0, foreground: await driver.foreground() };
    }
    if (session.stopped) return;

    const fg = probe.foreground;
    const allowed = this.isAllowedHostWindow(session, fg);
    if (allowed && fg.id !== session.lastWindowId) {
      const first = session.lastWindowId === undefined;
      session.lastWindowId = fg.id;
      const label = `${first ? '开始演示' : '切换窗口'}：${windowDisplayName(fg)}`;
      const kf = await this.captureHostKeyframe(session, fg, atMs, label, first);
      this.pushHostStep(session, {
        atMs,
        kind: 'window_focus',
        summary: label,
        windowTitle: fg.title,
        appName: fg.name,
        keyframeId: kf?.id,
      });
    }

    const prevButtons = session.prevButtons;
    session.prevButtons = probe.buttons;

    // Button down edge: inspect the accessibility control before the click triggers UI transitions.
    if (prevButtons === 0 && probe.buttons !== 0 && allowed) {
      let control: TeachingHostControl | undefined;
      if (driver.probe) {
        const hit = await driver.probe({ inspect: true, x: probe.x, y: probe.y }).catch(() => undefined);
        control = sanitizeControl(hit?.control);
      }
      session.down = {
        atMs,
        x: probe.x,
        y: probe.y,
        buttons: probe.buttons,
        window: fg,
        control,
      };
      return;
    }

    // Button up edge: commit click / double_click / right_click / drag and capture a keyframe.
    if (prevButtons !== 0 && probe.buttons === 0 && session.down) {
      const down = session.down;
      session.down = undefined;
      const targetWin = allowed ? fg : down.window;
      const dist = Math.hypot(probe.x - down.x, probe.y - down.y);
      const controlDesc = describeHostControl(down.control);

      if (dist >= DRAG_THRESHOLD_PX) {
        const summary = controlDesc
          ? `拖拽 ${controlDesc} (${down.x}, ${down.y}) → (${probe.x}, ${probe.y})`
          : `拖拽 (${down.x}, ${down.y}) → (${probe.x}, ${probe.y})`;
        const kf = await this.captureHostKeyframe(session, targetWin, atMs, summary);
        this.pushHostStep(session, {
          atMs: down.atMs,
          kind: 'drag',
          summary,
          windowTitle: targetWin.title,
          appName: targetWin.name,
          x: down.x,
          y: down.y,
          toX: probe.x,
          toY: probe.y,
          ...(down.control ? { control: down.control } : {}),
          ...(kf ? { keyframeId: kf.id } : {}),
        });
        session.lastLeftClick = undefined;
        return;
      }

      const isRight = (down.buttons & 2) !== 0;
      const isMiddle = !isRight && (down.buttons & 4) !== 0;
      if (!isRight && !isMiddle && session.lastLeftClick) {
        const prev = session.lastLeftClick;
        if (
          down.atMs - prev.atMs <= DOUBLE_CLICK_MS &&
          Math.hypot(down.x - prev.x, down.y - prev.y) <= DOUBLE_CLICK_PX &&
          session.steps[prev.stepIndex]?.kind === 'click'
        ) {
          const prevStep = session.steps[prev.stepIndex];
          prevStep.kind = 'double_click';
          prevStep.summary = prevStep.summary.replace(/^点击/, '双击');
          session.lastLeftClick = undefined;
          const kf = await this.captureHostKeyframe(session, targetWin, atMs, prevStep.summary);
          if (kf) prevStep.keyframeId = kf.id;
          return;
        }
      }

      const kind = isRight ? 'right_click' : isMiddle ? 'middle_click' : 'click';
      const verb = isRight ? '右键点击' : isMiddle ? '中键点击' : '点击';
      const summary = controlDesc ? `${verb} ${controlDesc}` : `${verb} (${down.x}, ${down.y})`;
      const kf = await this.captureHostKeyframe(session, targetWin, atMs, summary);
      const step = this.pushHostStep(session, {
        atMs: down.atMs,
        kind,
        summary,
        windowTitle: targetWin.title,
        appName: targetWin.name,
        x: down.x,
        y: down.y,
        ...(down.control ? { control: down.control } : {}),
        ...(kf ? { keyframeId: kf.id } : {}),
      });
      if (kind === 'click') {
        session.lastLeftClick = { atMs: down.atMs, x: down.x, y: down.y, stepIndex: session.steps.indexOf(step) };
      } else {
        session.lastLeftClick = undefined;
      }
    }
  }

  async vmWindowTitle(sessionId: string): Promise<{ title?: string }> {
    if (!this.active || this.active.sessionId !== sessionId || this.active.target !== 'vm' || !this.options.vm) {
      return {};
    }
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 1500);
    timer.unref?.();
    try {
      const title = await this.options.vm.activeWindowTitle(this.active.botId, controller.signal);
      return title?.trim() ? { title: title.trim().slice(0, 160) } : {};
    } catch {
      return {};
    } finally {
      clearTimeout(timer);
    }
  }

  private storeClientKeyframes(dir: string, incoming: readonly TeachingClientKeyframe[]): StoredKeyframe[] {
    const valid: Array<{ id: string; atMs: number; label: string; bytes: Buffer; width: number; height: number }> = [];
    for (const item of incoming) {
      if (!item || typeof item.id !== 'string' || typeof item.pngBase64 !== 'string') continue;
      const cleaned = item.pngBase64.replace(/^data:image\/png;base64,/i, '').trim();
      if (!cleaned) continue;
      const bytes = Buffer.from(cleaned, 'base64');
      if (bytes.length > MAX_CLIENT_KEYFRAME_BYTES) continue;
      const dims = pngDimensions(bytes);
      if (!dims) continue;
      valid.push({
        id: item.id,
        atMs: Math.max(0, Math.round(Number(item.atMs) || 0)),
        label: String(item.label || '画面截图').slice(0, 120),
        bytes,
        width: dims.width,
        height: dims.height,
      });
    }
    valid.sort((a, b) => a.atMs - b.atMs);
    const bounded = selectBoundedItems(valid, TEACHING_LIMITS.maxKeyframes);
    return bounded.map((item, index) => {
      const file = join(dir, `vm-${index + 1}.png`);
      writeFileSync(file, item.bytes);
      return {
        id: item.id,
        atMs: item.atMs,
        clock: formatTeachingClock(item.atMs),
        label: item.label,
        width: item.width,
        height: item.height,
        file,
      };
    });
  }

  async finish(input: TeachingFinishInput): Promise<TeachingDraft> {
    const session = this.active;
    if (!session || session.sessionId !== input?.sessionId)
      throw new AppError('teaching.session_not_found', '找不到正在进行的演示录制');

    session.stopped = true;
    if (session.timer) clearTimeout(session.timer);
    this.active = undefined;
    await session.inflight;

    const elapsed = Math.max(0, this.now() - session.startedAt);
    const durationMs = Math.min(
      TEACHING_LIMITS.maxDurationMs,
      Math.max(0, Math.round(Number.isFinite(input.durationMs) && input.durationMs > 0 ? input.durationMs : elapsed)),
    );

    let steps: TeachingStep[];
    let keyframes: StoredKeyframe[];

    if (session.target === 'host') {
      steps = session.steps;
      keyframes = session.keyframes;
    } else {
      keyframes = this.storeClientKeyframes(session.dir, Array.isArray(input.keyframes) ? input.keyframes : []);
      if (!keyframes.length && this.options.vm?.screenshot && this.options.vm.isReady()) {
        const controller = new AbortController(),
          timer = setTimeout(() => controller.abort(), 5000);
        timer.unref?.();
        try {
          const png = await this.options.vm.screenshot(session.botId, controller.signal);
          const dims = pngDimensions(png);
          if (dims) {
            const file = join(session.dir, 'vm-final.png');
            writeFileSync(file, png);
            keyframes.push({
              id: 'vm-final',
              atMs: durationMs,
              clock: formatTeachingClock(durationMs),
              label: '结束画面',
              width: dims.width,
              height: dims.height,
              file,
            });
          }
        } catch {
          // Best-effort fallback screenshot.
        } finally {
          clearTimeout(timer);
        }
      }
      const keptKeyframeIds = new Set(keyframes.map((frame) => frame.id));
      steps = coalesceVmEvents(Array.isArray(input.events) ? input.events : []).map((step) =>
        step.keyframeId && !keptKeyframeIds.has(step.keyframeId) ? { ...step, keyframeId: undefined } : step,
      );
    }

    let narration: TeachingNarrationSegment[] = [];
    let narrationWarning: string | undefined;
    if (input.audio instanceof Uint8Array && input.audio.byteLength > 0) {
      if (!this.options.speech?.available('input')) {
        narrationWarning = '还没有设置语音识别模型，本次已保留所有操作步骤和截图；可在下方手动补充讲解。';
      } else {
        const controller = new AbortController(),
          timer = setTimeout(() => controller.abort(new Error('语音识别超时')), 4 * 60_000);
        timer.unref?.();
        try {
          const result = await this.options.speech.transcribeTimeline(Buffer.from(input.audio), controller.signal);
          narration = result.segments;
        } catch (error) {
          narrationWarning = `语音转文字未完成（${(error as Error).message || '识别失败'}），操作步骤与截图已保留。`;
        } finally {
          clearTimeout(timer);
        }
      }
    }

    const draftId = session.sessionId;
    const pending: PendingDraft = {
      draftId,
      botId: session.botId,
      ...(session.chatSessionId ? { chatSessionId: session.chatSessionId } : {}),
      target: session.target,
      durationMs,
      dir: session.dir,
      steps,
      narration,
      ...(narrationWarning ? { narrationWarning } : {}),
      keyframes,
    };

    // Keep only the most recent drafts to avoid lingering temp images on disk.
    this.drafts.set(draftId, pending);
    while (this.drafts.size > MAX_DRAFTS) {
      const oldestKey = this.drafts.keys().next().value;
      if (!oldestKey || oldestKey === draftId) break;
      this.cleanupDraft(oldestKey);
    }

    const previews: TeachingKeyframePreview[] = keyframes
      .filter((frame) => existsSync(frame.file))
      .map((frame) => ({
        id: frame.id,
        atMs: frame.atMs,
        clock: frame.clock,
        label: frame.label,
        width: frame.width,
        height: frame.height,
        dataUrl: `data:image/png;base64,${readFileSync(frame.file).toString('base64')}`,
      }));

    return {
      draftId,
      botId: pending.botId,
      ...(pending.chatSessionId ? { chatSessionId: pending.chatSessionId } : {}),
      target: pending.target,
      durationMs: pending.durationMs,
      steps: pending.steps,
      narration: pending.narration,
      ...(pending.narrationWarning ? { narrationWarning: pending.narrationWarning } : {}),
      keyframes: previews,
    };
  }

  async cancel(id?: string): Promise<void> {
    if (this.active && (!id || this.active.sessionId === id)) {
      const session = this.active;
      session.stopped = true;
      if (session.timer) clearTimeout(session.timer);
      this.active = undefined;
      await session.inflight;
      try {
        rmSync(session.dir, { recursive: true, force: true });
      } catch {}
    }
    if (id && this.drafts.has(id)) {
      this.cleanupDraft(id);
    }
  }

  sendDraft(input: TeachingSendInput): { message: string; attachmentCount: number } {
    const draft = input && typeof input.draftId === 'string' ? this.drafts.get(input.draftId) : undefined;
    if (!draft) throw new AppError('teaching.draft_not_found', '演示草稿不存在或已过期');
    if (!this.options.hasBot(draft.botId)) throw new AppError('teaching.bot_not_found', '找不到目标 Bot');

    const selectedSet = new Set(Array.isArray(input.selectedKeyframeIds) ? input.selectedKeyframeIds : []);
    const chosenFrames = selectBoundedItems(
      draft.keyframes.filter((frame) => selectedSet.has(frame.id) && existsSync(frame.file)),
      TEACHING_LIMITS.maxAttachedKeyframes,
    );

    const scope: AttachmentScope = {
      kind: 'bot',
      id: draft.botId,
      ...(draft.chatSessionId ? { sessionId: draft.chatSessionId } : {}),
    };

    const uploads: AttachmentUpload[] = chosenFrames.map((frame, index) => ({
      name: keyframeFilename(index, frame.atMs),
      bytes: new Uint8Array(readFileSync(frame.file)),
    }));
    const imported = uploads.length ? this.options.attachments.importFiles(scope, uploads) : [];
    const attachmentMeta = chosenFrames.map((frame, index) => ({
      id: frame.id,
      name: imported[index]?.name || uploads[index].name,
      atMs: frame.atMs,
      clock: frame.clock,
      label: frame.label,
    }));

    const narration: TeachingNarrationSegment[] = (Array.isArray(input.narration) ? input.narration : draft.narration)
      .filter((segment) => segment && typeof segment.text === 'string' && segment.text.trim().length > 0)
      .map((segment) => {
        const startMs = Math.max(0, Math.round(Number(segment.startMs) || 0)),
          endMs = Math.max(startMs, Math.round(Number(segment.endMs) || startMs));
        return {
          startMs,
          endMs,
          clock: formatTeachingClock(startMs),
          text: segment.text.trim(),
        };
      })
      .sort((a, b) => a.startMs - b.startMs);

    const message = formatTeachingPrompt({
      target: draft.target,
      durationMs: draft.durationMs,
      title: typeof input.title === 'string' ? input.title.trim().slice(0, 120) : undefined,
      notes: typeof input.notes === 'string' ? input.notes.trim().slice(0, 2000) : undefined,
      steps: draft.steps,
      narration,
      attachments: attachmentMeta,
    });

    this.options.send({
      botId: draft.botId,
      ...(draft.chatSessionId ? { sessionId: draft.chatSessionId } : {}),
      message,
      ...(imported.length ? { attachmentIds: imported.map((file) => file.id) } : {}),
    });

    this.cleanupDraft(draft.draftId);
    return { message, attachmentCount: imported.length };
  }

  private cleanupDraft(draftId: string) {
    const draft = this.drafts.get(draftId);
    if (!draft) return;
    this.drafts.delete(draftId);
    try {
      rmSync(draft.dir, { recursive: true, force: true });
    } catch {}
  }

  dispose() {
    if (this.active) {
      this.active.stopped = true;
      if (this.active.timer) clearTimeout(this.active.timer);
      try {
        rmSync(this.active.dir, { recursive: true, force: true });
      } catch {}
      this.active = undefined;
    }
    for (const draftId of this.drafts.keys()) this.cleanupDraft(draftId);
  }
}
