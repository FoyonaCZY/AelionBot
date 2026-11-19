import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { AppError } from '../../../../shared/errors';
import { DESKTOP_HELPER_SOURCE } from './desktop-helper-source';

export interface DesktopWindow {
  id: number;
  title: string;
  className: string;
  pid: number;
  /** The app behind the window: its executable on Windows, its bundle on macOS. Empty when the system would not say. */
  exe: string;
  name: string;
  minimized: boolean;
  foreground: boolean;
  elevated: boolean;
  /** A browser, or an app built on one: it stops drawing while other windows cover it completely. */
  pausesWhenCovered?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface DesktopCapture extends DesktopWindow {
  /** Screen position of the image's top-left corner, and image pixels per screen pixel. */
  originX: number;
  originY: number;
  scale: number;
  imageWidth: number;
  imageHeight: number;
  text?: string;
  /** [x, y, width, height] in image pixels, indexed like the lines of `text`. */
  elements?: number[][];
}
export type InputStep =
  | { t: 'move' | 'check'; x: number; y: number; free?: true }
  /** `n` counts the presses of one click: 2 on the second press of a double click. */
  | { t: 'down' | 'up'; button: 0 | 1 | 2; n?: number }
  | { t: 'wheel'; dx: number; dy: number }
  | { t: 'key'; keys: number[] }
  | { t: 'text'; text: string }
  | { t: 'sleep'; ms: number };
export interface DesktopStatus {
  elevated: boolean;
  /** The whole desktop in screen coordinates: [left, top, width, height]. */
  display?: number[];
  /** macOS privacy grants; absent where the system has none to give. */
  accessibility?: boolean;
  screenRecording?: boolean;
}
/** Where a menu path led: the command was chosen, or these are the items at the point it stopped. */
export interface MenuResult {
  pressed: boolean;
  at?: string[];
  items?: string[];
  submenu?: boolean;
}
/**
 * What host Computer Use needs from the operating system. Looking at a window and acting on a control through the
 * accessibility tree leave the window where it is; `input` and a capture with `front` bring it to the front.
 */
export interface DesktopDriver {
  /** Whether launch() leaves the window in use in front. */
  readonly quietLaunch: boolean;
  status(): Promise<DesktopStatus>;
  /** Front to back. */
  listWindows(): Promise<DesktopWindow[]>;
  listApps(): Promise<Array<{ name: string; id: string }>>;
  launch(id: string): Promise<void>;
  window(id: number): Promise<DesktopWindow>;
  foreground(): Promise<DesktopWindow | null>;
  /** Without `front` the picture comes from the window itself and fails with computer.host_blank if it has none. */
  capture(id: number, file: string, options: { text: boolean; front: boolean }): Promise<DesktopCapture>;
  /** Real pointer and keyboard input. */
  input(id: number, steps: InputStep[]): Promise<void>;
  /** What a click means to the control, without the pointer; computer.host_unsupported when it has no such action. */
  press(id: number, element: number, count: number): Promise<void>;
  /** Scrolls at a screen point without the pointer; computer.host_unsupported when the window cannot. */
  scroll(id: number, at: { x: number; y: number; dx: number; dy: number; element?: number }): Promise<void>;
  setValue(id: number, element: number, value: string): Promise<void>;
  /** macOS: chooses a command from the menu bar of the window's app. */
  menu?(id: number, path: string[]): Promise<MenuResult>;
  /** macOS: has the system show its permission prompt. */
  requestPermission?(kind: 'accessibility' | 'screen'): Promise<void>;
  dispose(): void;
}

const MESSAGES: Record<string, string> = {
  window_gone: '窗口已经关闭。用 list_windows 查看当前窗口',
  obscured: '目标位置被其他应用的窗口挡住，或不在这个应用的窗口内。重新观察窗口后再操作',
  not_foreground: '这个应用不在前台，无法继续输入。重新观察窗口后再操作',
  not_visible: '窗口不在屏幕可见范围内',
  input_blocked: '系统拒绝了这次输入，目标可能是以管理员身份运行的窗口',
  element_stale: '控件编号不属于最新一次观察。用 includeText 重新观察窗口',
  element_disabled: '这个控件当前不可用',
  unsupported: '这个控件不支持直接设置内容，改用点击和输入',
  blank: '这个窗口没有给出自己的画面',
  timeout: '应用没有及时响应',
  accessibility_permission: 'macOS 还没有允许 AelionBot 使用辅助功能',
  screen_permission: 'macOS 还没有允许 AelionBot 录制屏幕',
};
// Both directions stay ASCII so no code page or locale touches window titles or typed text.
const ascii = (value: string) =>
  value.replace(/[\u007f-\uffff]/g, (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));

/** One long-lived helper process answering a JSON request per line; started on first use. */
abstract class DesktopHelper implements DesktopDriver {
  abstract readonly quietLaunch: boolean;
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private next = 1;
  protected abstract spawn(): ChildProcessWithoutNullStreams;
  /** A line the helper reads before its first request. */
  protected preamble(): string | undefined {
    return undefined;
  }
  private start() {
    if (this.ready) return this.ready;
    const child = this.spawn();
    this.child = child;
    let buffer = '',
      errors = '';
    const ready = new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        reject(error);
        // A helper that was already replaced has no requests left to fail.
        if (this.child !== child) return;
        this.child = undefined;
        this.ready = undefined;
        for (const item of this.pending.values()) item.reject(error);
        this.pending.clear();
      };
      const timer = setTimeout(() => {
        child.kill();
        fail(new AppError('computer.host_unavailable', '本机电脑控制组件启动超时'));
      }, 30000);
      child.on('error', (error) =>
        fail(new AppError('computer.host_unavailable', '无法启动本机电脑控制组件：' + error.message)),
      );
      child.on('close', () => {
        clearTimeout(timer);
        fail(
          new AppError(
            'computer.host_unavailable',
            '本机电脑控制组件已退出' + (errors ? '：' + errors.slice(-400) : ''),
          ),
        );
      });
      child.stderr.on('data', (data) => {
        // PowerShell reports progress as CLIXML on stderr; only real text is worth keeping.
        const text = String(data);
        if (!text.includes('<Objs') && !text.startsWith('#< CLIXML')) errors = (errors + text).slice(-2000);
      });
      child.stdout.on('data', (data) => {
        buffer += data;
        for (let index: number; (index = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          let message: { ready?: boolean; id?: number; ok?: boolean; result?: unknown; code?: string; error?: string };
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.ready) {
            clearTimeout(timer);
            resolve();
            continue;
          }
          const item = this.pending.get(Number(message.id));
          if (!item) continue;
          this.pending.delete(Number(message.id));
          if (message.ok) item.resolve(message.result);
          else
            item.reject(
              new AppError(
                'computer.host_' + (message.code || 'failed'),
                MESSAGES[message.code || ''] || '本机电脑操作失败：' + (message.error || '未知错误'),
              ),
            );
        }
      });
    });
    // Rejections reach the callers through call(); this keeps a start nobody awaited from being unhandled.
    ready.catch(() => {});
    child.stdin.on('error', () => {});
    const preamble = this.preamble();
    if (preamble !== undefined) child.stdin.write(preamble + '\n');
    this.ready = ready;
    return ready;
  }
  protected async call<T>(op: string, args: Record<string, unknown> = {}, timeoutMs = 20000): Promise<T> {
    await this.start();
    const child = this.child;
    if (!child) throw new AppError('computer.host_unavailable', '本机电脑控制组件未运行');
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        // A request that never answers leaves the helper in an unknown state: start a fresh one next time.
        if (this.child === child) this.dispose();
        else child.kill();
        reject(new AppError('computer.host_timeout', MESSAGES.timeout));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(ascii(JSON.stringify({ id, op, ...args })) + '\n');
    });
  }
  status() {
    return this.call<DesktopStatus>('ping');
  }
  listWindows() {
    return this.call<DesktopWindow[]>('list_windows');
  }
  listApps() {
    return this.call<Array<{ name: string; id: string }>>('list_apps', {}, 30000);
  }
  async launch(id: string) {
    await this.call('launch', { id });
  }
  window(id: number) {
    return this.call<DesktopWindow>('window', { window: id });
  }
  foreground() {
    return this.call<DesktopWindow | null>('foreground');
  }
  capture(id: number, file: string, options: { text: boolean; front: boolean }) {
    return this.call<DesktopCapture>('capture', { window: id, file, maxEdge: 1600, ...options });
  }
  async input(id: number, steps: InputStep[]) {
    await this.call('input', { window: id, steps }, 60000);
  }
  async press(id: number, element: number, count: number) {
    await this.call('press', { window: id, element, count });
  }
  async scroll(id: number, at: { x: number; y: number; dx: number; dy: number; element?: number }) {
    await this.call('scroll', { window: id, ...at });
  }
  async setValue(id: number, element: number, value: string) {
    await this.call('set_value', { window: id, element, value });
  }
  dispose() {
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    for (const item of this.pending.values())
      item.reject(new AppError('computer.host_unavailable', '本机电脑控制组件已停止'));
    this.pending.clear();
    child?.stdin.end();
    child?.kill();
  }
}

const BOOTSTRAP = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$reader=New-Object IO.StreamReader([Console]::OpenStandardInput(),(New-Object Text.UTF8Encoding($false)))
$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($reader.ReadLine()))
Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing,System.Web.Extensions,UIAutomationClient,UIAutomationTypes,WindowsBase
[Aelion.DesktopHelper]::Run($reader)`;
/** Windows: the C# helper, compiled and hosted by the PowerShell every machine has. */
export class WindowsDesktopHelper extends DesktopHelper {
  // Windows hands a newly started app the foreground.
  readonly quietLaunch = false;
  protected spawn() {
    return spawn(
      join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(BOOTSTRAP, 'utf16le').toString('base64'),
      ],
      { windowsHide: true },
    );
  }
  protected preamble() {
    return Buffer.from(DESKTOP_HELPER_SOURCE, 'utf8').toString('base64');
  }
}

/** macOS: the Swift helper built from desktop-helper-mac.swift and shipped inside the app. */
export class MacDesktopHelper extends DesktopHelper {
  // `open -g` starts an app behind the one in use.
  readonly quietLaunch = true;
  constructor(private binary: string) {
    super();
  }
  protected spawn() {
    return spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  }
  menu(id: number, path: string[]) {
    return this.call<MenuResult>('menu', { window: id, path });
  }
  async requestPermission(kind: 'accessibility' | 'screen') {
    await this.call('request_permission', { kind });
  }
}
