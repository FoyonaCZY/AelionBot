import { BrowserWindow, globalShortcut, screen } from 'electron';
import type { HostDesktopPresence } from '../core/host/desktop/host-desktop';

type Holder = { botId: string; runId: string };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const page = (label: string, hint: string) => `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent;font:500 13px/1 'Segoe UI','Microsoft YaHei UI',system-ui,'PingFang SC',sans-serif}
.frame{position:fixed;inset:0;border:3px solid #8f6fe0;border-radius:10px;box-shadow:inset 0 0 26px #8f6fe066}
.pill{position:fixed;top:14px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;padding:9px 16px;
border-radius:999px;background:#211c2bf2;color:#f3eefc;box-shadow:0 6px 22px #0006;white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:#a98bf5}
.hint{color:#c9bfe0}
kbd{font:inherit;padding:3px 7px;border-radius:6px;background:#ffffff1f;color:#fff}
</style><div class="frame"></div><div class="pill"><span class="dot"></span><span>${escapeHtml(label)}</span><span class="hint"><kbd>Esc</kbd> ${escapeHtml(hint)}</span></div>`;

/**
 * The cue that a Bot holds the pointer and keyboard of this computer: a border on every display, a status pill, and
 * Esc to stop. It is up only while the Bot works in the foreground; what it does in the background shows no cue and
 * leaves Esc alone. The windows take no input and are left out of screen captures, so the Bot neither clicks them nor
 * sees them.
 */
export class ComputerUseOverlay implements HostDesktopPresence {
  private windows: BrowserWindow[] = [];
  private holder?: Holder;
  private idle?: ReturnType<typeof setTimeout>;
  constructor(
    private options: {
      text(holder: Holder): { label: string; hint: string };
      cancel(holder: Holder): void;
      /** How long the cue stays after the Bot's last foreground action, covering the time it takes to decide the next. */
      idleMs?: number;
      /** How long a cue that has just appeared holds the Bot back, so the user can let go of the keyboard. */
      graceMs?: number;
    },
  ) {}
  async foreground(holder: Holder) {
    this.holder = holder;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.hide(), this.options.idleMs ?? 45000);
    if (this.windows.length) return;
    const { label, hint } = this.options.text(holder);
    for (const display of screen.getAllDisplays()) {
      const window = new BrowserWindow({
        ...display.bounds,
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        focusable: false,
        skipTaskbar: true,
        hasShadow: false,
        roundedCorners: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      window.setAlwaysOnTop(true, 'screen-saver');
      // On macOS the cue follows the user across Spaces and over full-screen apps.
      if (process.platform === 'darwin')
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      window.setIgnoreMouseEvents(true);
      window.setContentProtection(true);
      window.once('ready-to-show', () => !window.isDestroyed() && window.showInactive());
      void window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page(label, hint)));
      this.windows.push(window);
    }
    this.arm();
    await new Promise((resolve) => setTimeout(resolve, this.options.graceMs ?? 600));
  }
  end() {
    this.holder = undefined;
    this.hide();
  }
  private arm() {
    if (globalShortcut.isRegistered('Escape')) return;
    globalShortcut.register('Escape', () => {
      if (this.holder) this.options.cancel(this.holder);
    });
  }
  private hide() {
    clearTimeout(this.idle);
    this.idle = undefined;
    if (!this.windows.length) return;
    globalShortcut.unregister('Escape');
    for (const window of this.windows.splice(0)) if (!window.isDestroyed()) window.destroy();
  }
  async passEscape<T>(work: () => Promise<T>) {
    globalShortcut.unregister('Escape');
    try {
      return await work();
    } finally {
      if (this.windows.length) this.arm();
    }
  }
}
