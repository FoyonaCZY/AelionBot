// Pure helpers for Teach by Showing: timestamp formatting, VM input coalescing, keyframe bounding,
// and chronological timeline interleaving for the Bot skill-learning prompt.
import {
  TEACHING_LIMITS,
  type TeachingClientEvent,
  type TeachingHostControl,
  type TeachingNarrationSegment,
  type TeachingStep,
  type TeachingTarget,
} from '../types/teaching-types';

/** Formats milliseconds into `m:ss`, or `h:mm:ss` from an hour on. */
export function formatTeachingClock(ms: number): string {
  const whole = Math.max(0, Math.floor(ms / 1000)),
    hours = Math.floor(whole / 3600),
    minutes = Math.floor(whole / 60) % 60,
    seconds = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** Converts client pointer coordinates over a scaled VNC `<canvas>` to guest framebuffer pixel coordinates. */
export function mapCanvasPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  frameWidth: number,
  frameHeight: number,
): { x: number; y: number } | undefined {
  if (rect.width <= 0 || rect.height <= 0 || frameWidth <= 1 || frameHeight <= 1) return undefined;
  const rx = (clientX - rect.left) / rect.width,
    ry = (clientY - rect.top) / rect.height;
  if (!Number.isFinite(rx) || !Number.isFinite(ry) || rx < 0 || ry < 0 || rx > 1 || ry > 1) return undefined;
  return {
    x: Math.min(frameWidth - 1, Math.max(0, Math.round(rx * (frameWidth - 1)))),
    y: Math.min(frameHeight - 1, Math.max(0, Math.round(ry * (frameHeight - 1)))),
  };
}

/** Normalizes a DOM keydown event into a `CTRL+SHIFT+S` style chord string. */
export function formatKeyChord(event: {
  key?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}): string | undefined {
  const raw = String(event.key || '').trim();
  if (!raw || ['Shift', 'Control', 'Alt', 'Meta', 'OS', 'Dead', 'Process'].includes(raw)) return undefined;
  const special: Record<string, string> = {
    Enter: 'ENTER',
    Return: 'ENTER',
    Escape: 'ESC',
    Esc: 'ESC',
    Tab: 'TAB',
    Backspace: 'BACKSPACE',
    Delete: 'DELETE',
    ' ': 'SPACE',
    Spacebar: 'SPACE',
    ArrowUp: 'UP',
    ArrowDown: 'DOWN',
    ArrowLeft: 'LEFT',
    ArrowRight: 'RIGHT',
    Home: 'HOME',
    End: 'END',
    PageUp: 'PAGEUP',
    PageDown: 'PAGEDOWN',
    Insert: 'INSERT',
  };
  const key =
    special[raw] || (raw.length === 1 ? raw.toUpperCase() : /^F([1-9]|1[0-2])$/i.test(raw) ? raw.toUpperCase() : raw);
  const parts: string[] = [];
  if (event.ctrl) parts.push('CTRL');
  if (event.alt) parts.push('ALT');
  if (event.shift && (parts.length > 0 || Boolean(special[raw]) || key.length > 1)) parts.push('SHIFT');
  if (event.meta) parts.push('META');
  parts.push(key);
  return parts.join('+');
}

/** Formats a host accessibility control summary, never exposing password values. */
export function describeHostControl(control?: TeachingHostControl): string {
  if (!control) return '';
  const parts = [control.type || 'Control'];
  if (control.name) parts.push(`"${control.name}"`);
  if (control.password) parts.push('(密码字段，内容已隐藏)');
  else if (control.value && control.value !== control.name) parts.push(`= "${control.value}"`);
  return parts.join(' ');
}

/**
 * Evenly selects up to `limit` items from `items`, always keeping the first and last entries when `items.length > limit`.
 */
export function selectBoundedItems<T>(items: readonly T[], limit: number): T[] {
  if (limit <= 0) return [];
  if (items.length <= limit) return [...items];
  if (limit === 1) return [items[0]];
  const chosen: T[] = [];
  const span = items.length - 1;
  for (let i = 0; i < limit; i++) {
    const index = Math.round((i * span) / (limit - 1));
    chosen.push(items[index]);
  }
  return chosen;
}

const TYPING_GAP_MS = 1800;
const SCROLL_GAP_MS = 500;

/**
 * Coalesces raw VM pointer/wheel/key events into clean, readable `TeachingStep` records:
 * - Consecutive printable keystrokes merge into a single `type_text` step (handling Backspace within the buffer).
 * - Rapid scrolls in the same direction merge into one `scroll` step with combined amount.
 * - Window title transitions emit `window_focus` context when a new Linux app window appears.
 */
export function coalesceVmEvents(events: readonly TeachingClientEvent[]): TeachingStep[] {
  const sorted = [...events]
    .filter((event) => Number.isFinite(event.atMs) && event.atMs >= 0)
    .sort((a, b) => a.atMs - b.atMs)
    .slice(0, TEACHING_LIMITS.maxClientEvents);
  const steps: TeachingStep[] = [];
  let seq = 1;
  let lastWindow = '';
  let typing:
    | {
        atMs: number;
        lastAtMs: number;
        text: string;
        windowTitle?: string;
        keyframeId?: string;
      }
    | undefined;

  const pushStep = (step: Omit<TeachingStep, 'id' | 'clock' | 'target'>) => {
    steps.push({
      ...step,
      id: `vm-${seq++}`,
      clock: formatTeachingClock(step.atMs),
      target: 'vm',
    });
  };

  const flushTyping = () => {
    if (!typing) return;
    if (typing.text.length > 0) {
      const preview = typing.text.length > 120 ? typing.text.slice(0, 120) + '…' : typing.text;
      pushStep({
        atMs: typing.atMs,
        kind: 'type_text',
        summary: `输入文本 "${preview}"`,
        text: typing.text,
        ...(typing.windowTitle ? { windowTitle: typing.windowTitle } : {}),
        ...(typing.keyframeId ? { keyframeId: typing.keyframeId } : {}),
      });
    }
    typing = undefined;
  };

  for (const event of sorted) {
    const title = event.windowTitle?.trim() || '';
    if (title && title !== lastWindow) {
      flushTyping();
      lastWindow = title;
      pushStep({
        atMs: event.atMs,
        kind: 'window_focus',
        summary: `当前窗口：${title}`,
        windowTitle: title,
        ...(event.keyframeId ? { keyframeId: event.keyframeId } : {}),
      });
    }

    if (event.kind === 'key') {
      const isPlainChar =
        typeof event.printable === 'string' &&
        event.printable.length === 1 &&
        !event.ctrl &&
        !event.alt &&
        !event.meta &&
        event.printable >= ' ';
      if (isPlainChar) {
        if (
          typing &&
          event.atMs - typing.lastAtMs <= TYPING_GAP_MS &&
          (typing.windowTitle || '') === (title || lastWindow)
        ) {
          typing.text += event.printable;
          typing.lastAtMs = event.atMs;
          if (event.keyframeId) typing.keyframeId = event.keyframeId;
        } else {
          flushTyping();
          typing = {
            atMs: event.atMs,
            lastAtMs: event.atMs,
            text: event.printable!,
            windowTitle: title || lastWindow || undefined,
            keyframeId: event.keyframeId,
          };
        }
        continue;
      }
      if (
        event.key === 'Backspace' &&
        !event.ctrl &&
        !event.alt &&
        !event.meta &&
        typing &&
        event.atMs - typing.lastAtMs <= TYPING_GAP_MS &&
        typing.text.length > 0
      ) {
        typing.text = typing.text.slice(0, -1);
        typing.lastAtMs = event.atMs;
        continue;
      }
      flushTyping();
      const chord = formatKeyChord(event);
      if (!chord) continue;
      pushStep({
        atMs: event.atMs,
        kind: 'press_key',
        summary: `按键 ${chord}`,
        key: chord,
        ...(title || lastWindow ? { windowTitle: title || lastWindow } : {}),
        ...(event.keyframeId ? { keyframeId: event.keyframeId } : {}),
      });
      continue;
    }

    flushTyping();

    if (event.kind === 'scroll') {
      const direction = event.direction || 'down',
        amount = Math.max(1, Math.min(12, Math.round(event.amount || 3))),
        previous = steps.at(-1);
      if (
        previous &&
        previous.kind === 'scroll' &&
        previous.direction === direction &&
        event.atMs - previous.atMs <= SCROLL_GAP_MS
      ) {
        previous.amount = Math.min(20, (previous.amount || 1) + amount);
        previous.summary = `向${directionLabel(direction)}滚动 (${previous.amount})`;
        continue;
      }
      pushStep({
        atMs: event.atMs,
        kind: 'scroll',
        summary: `向${directionLabel(direction)}滚动 (${amount})`,
        direction,
        amount,
        ...(Number.isFinite(event.x) && Number.isFinite(event.y)
          ? { x: Math.round(event.x!), y: Math.round(event.y!) }
          : {}),
        ...(title || lastWindow ? { windowTitle: title || lastWindow } : {}),
        ...(event.keyframeId ? { keyframeId: event.keyframeId } : {}),
      });
      continue;
    }

    const x = Number.isFinite(event.x) ? Math.round(event.x!) : undefined,
      y = Number.isFinite(event.y) ? Math.round(event.y!) : undefined;
    if (event.kind === 'drag') {
      const toX = Number.isFinite(event.toX) ? Math.round(event.toX!) : x,
        toY = Number.isFinite(event.toY) ? Math.round(event.toY!) : y;
      pushStep({
        atMs: event.atMs,
        kind: 'drag',
        summary: `拖拽 (${x ?? 0}, ${y ?? 0}) → (${toX ?? 0}, ${toY ?? 0})`,
        x,
        y,
        toX,
        toY,
        ...(title || lastWindow ? { windowTitle: title || lastWindow } : {}),
        ...(event.keyframeId ? { keyframeId: event.keyframeId } : {}),
      });
      continue;
    }

    const verb =
      event.kind === 'double_click'
        ? '双击'
        : event.kind === 'right_click'
          ? '右键点击'
          : event.kind === 'middle_click'
            ? '中键点击'
            : '点击';
    pushStep({
      atMs: event.atMs,
      kind: event.kind,
      summary: x !== undefined && y !== undefined ? `${verb} (${x}, ${y})` : verb,
      ...(x !== undefined && y !== undefined ? { x, y } : {}),
      ...(title || lastWindow ? { windowTitle: title || lastWindow } : {}),
      ...(event.keyframeId ? { keyframeId: event.keyframeId } : {}),
    });
  }

  flushTyping();
  return steps;
}

function directionLabel(direction: 'up' | 'down' | 'left' | 'right') {
  return direction === 'up' ? '上' : direction === 'down' ? '下' : direction === 'left' ? '左' : '右';
}

export type TeachingTimelineEntry =
  | { kind: 'narration'; atMs: number; clock: string; text: string }
  | { kind: 'step'; atMs: number; clock: string; step: TeachingStep };

/** Interleaves timestamped spoken narration and UI actions strictly in chronological order. */
export function interleaveTeachingTimeline(
  steps: readonly TeachingStep[],
  narration: readonly TeachingNarrationSegment[],
): TeachingTimelineEntry[] {
  const entries: Array<TeachingTimelineEntry & { order: number }> = [];
  let order = 0;
  for (const segment of narration) {
    const text = segment.text.trim();
    if (!text) continue;
    entries.push({
      kind: 'narration',
      atMs: Math.max(0, segment.startMs),
      clock: segment.clock || formatTeachingClock(segment.startMs),
      text,
      order: order++,
    });
  }
  for (const step of steps) {
    entries.push({
      kind: 'step',
      atMs: Math.max(0, step.atMs),
      clock: step.clock || formatTeachingClock(step.atMs),
      step,
      order: order++,
    });
  }
  entries.sort((a, b) => a.atMs - b.atMs || (a.kind === b.kind ? a.order - b.order : a.kind === 'narration' ? -1 : 1));
  return entries.map(({ order: _order, ...entry }) => entry);
}

/** Formats a unified teaching demonstration packet for the Bot to inspect and save via `skill_save`. */
export function formatTeachingPrompt(input: {
  target: TeachingTarget;
  durationMs: number;
  title?: string;
  notes?: string;
  steps: readonly TeachingStep[];
  narration: readonly TeachingNarrationSegment[];
  attachments: ReadonlyArray<{ id: string; name: string; atMs: number; clock: string; label: string }>;
}): string {
  const targetLabel = input.target === 'host' ? '本机电脑（Host Computer）' : '工作电脑（Linux VM）';
  const timeline = interleaveTeachingTimeline(input.steps, input.narration);
  const attachmentById = new Map(input.attachments.map((item) => [item.id, item]));
  const lines: string[] = [
    `我刚刚在${targetLabel}演示了一段操作流程，请你学习并整理为一条可复用的私有技能（SKILL.md）。`,
    '',
    '## 演示概览',
    `- 演示环境：${targetLabel}`,
    `- 演示时长：${formatTeachingClock(input.durationMs)}`,
    `- 操作步骤：${input.steps.length} 步`,
    `- 语音讲解：${input.narration.filter((item) => item.text.trim()).length} 段`,
    `- 关键帧截图：${input.attachments.length} 张（已作为图片附件随本消息附上）`,
  ];
  if (input.title?.trim()) lines.push(`- 期望技能名：${input.title.trim()}`);
  if (input.notes?.trim()) lines.push(`- 补充说明：${input.notes.trim()}`);

  lines.push('', '## 操作与讲解时间轴');
  if (!timeline.length) {
    lines.push('（无详细步骤记录，请结合关键帧截图与补充说明整理）');
  } else {
    for (const entry of timeline) {
      if (entry.kind === 'narration') {
        lines.push(`[${entry.clock}] 🎙️ 口述: ${entry.text}`);
      } else {
        const step = entry.step;
        const extras: string[] = [];
        if (step.appName || step.windowTitle) {
          const where = [step.appName, step.windowTitle].filter(Boolean).join(' - ');
          if (where && !step.summary.includes(where)) extras.push(`窗口: ${where}`);
        }
        const control = describeHostControl(step.control);
        if (control && !step.summary.includes(control)) extras.push(`控件: ${control}`);
        const frame = step.keyframeId ? attachmentById.get(step.keyframeId) : undefined;
        if (frame) extras.push(`截图: ${frame.name}`);
        lines.push(`[${entry.clock}] 🖱️ 操作: ${step.summary}${extras.length ? `（${extras.join('；')}）` : ''}`);
      }
    }
  }

  if (input.attachments.length) {
    lines.push('', '## 关键帧附件对照');
    for (const frame of input.attachments) {
      lines.push(`- [${frame.clock}] ${frame.name}：${frame.label}`);
    }
  }

  lines.push(
    '',
    '## 技能整理要求',
    '1. 结合时间轴里的口述意图、UI 控件信息与对应时刻的关键帧截图，归纳出清晰、可泛化的操作步骤。',
    '2. 提取可变参数（例如目标文件、关键词、收件人等）、前置条件、分支处理与结果验证方式，不要写死临时路径、一次性数据或任何密码/秘密。',
    input.target === 'host'
      ? '3. 这是本机电脑流程：在技能步骤中优先说明使用 `host_computer` 的后台控件能力（`get_window_state(includeText: true)`、`click(element)`、`set_value(element)`、`select_menu`），仅在控件不支持后台操作时再回退到坐标点击或键盘输入。'
      : '3. 这是工作电脑（Linux VM）流程：能用命令或脚本稳定完成的步骤优先用 CLI，必须操作界面时再使用 `computer` 工具按观察截图执行。',
    '4. 先用 `skills_list` 检查是否已有同名或同类私有技能（如需更新先 `skill_read`），然后调用 `skill_save` 保存或更新到你的私有技能库（若当前未直接列出 `skill_save`，先用 `tool_search` 启用它）。',
    '5. 保存完成后，向我简洁汇报学会的技能名称、适用场景、核心步骤和可调参数。',
  );

  return lines.join('\n');
}

/** Detects a Teach-by-Showing demonstration prompt generated by `formatTeachingPrompt`. */
export function isTeachingPrompt(text: string): boolean {
  return (
    Boolean(text) &&
    text.includes('## 演示概览') &&
    text.includes('## 操作与讲解时间轴') &&
    text.includes('## 技能整理要求')
  );
}
