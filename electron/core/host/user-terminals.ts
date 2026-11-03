import { existsSync, statSync } from 'node:fs';
import { AppError } from '../../../shared/errors';
import type { TerminalEvent } from '../../../shared/types/core';
import type { TerminalDriver } from '../tools/terminal-sessions';
import type { PtyOptions } from './host-pty';
import { interactiveShell } from './host-platform';

const MAX_TERMINALS = 12,
  FLUSH_MS = 8,
  size = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(500, Math.max(2, Math.round(value))) : fallback;

interface Terminal {
  driver: TerminalDriver;
  cwd: string;
  pending: string;
  timer?: ReturnType<typeof setTimeout>;
}
/**
 * The shells the user types into from the floating terminal, one per conversation. They are the user's own and are
 * separate from the Bots' terminal sessions: no permission prompts, and no Bot can read or write them.
 */
export class UserTerminals {
  private terminals = new Map<string, Terminal>();
  constructor(
    private options: {
      spawn: (options: PtyOptions) => TerminalDriver;
      env: NodeJS.ProcessEnv;
      emit: (event: TerminalEvent) => void;
    },
  ) {}
  /** An already running shell is kept, so reopening a conversation's terminal never starts a second one. */
  open(id: string, cwd: string | undefined, cols: unknown, rows: unknown) {
    const existing = this.terminals.get(id);
    if (existing) return { id, cwd: existing.cwd };
    if (this.terminals.size >= MAX_TERMINALS) throw new AppError('terminal.limit', '最多同时打开 12 个终端');
    if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory())
      throw new AppError('terminal.cwd_missing', '终端工作目录不存在');
    const { env } = this.options,
      shell = interactiveShell(env),
      driver = this.options.spawn({
        executable: shell.executable,
        args: shell.args,
        cwd,
        cols: size(cols, 80),
        rows: size(rows, 24),
        env,
      }),
      terminal: Terminal = { driver, cwd, pending: '' };
    this.terminals.set(id, terminal);
    driver.onData((text) => {
      if (this.terminals.get(id) !== terminal) return;
      terminal.pending += text;
      terminal.timer ||= setTimeout(() => this.flush(id, terminal), FLUSH_MS);
    });
    driver.onExit((exitCode) => {
      if (this.terminals.get(id) !== terminal) return;
      this.flush(id, terminal);
      this.terminals.delete(id);
      this.options.emit({ type: 'exit', id, exitCode });
    });
    return { id, cwd };
  }
  private flush(id: string, terminal: Terminal) {
    clearTimeout(terminal.timer);
    terminal.timer = undefined;
    if (!terminal.pending) return;
    const data = terminal.pending;
    terminal.pending = '';
    this.options.emit({ type: 'data', id, data });
  }
  write(id: string, text: unknown) {
    if (typeof text === 'string') this.terminals.get(id)?.driver.write(text);
  }
  resize(id: string, cols: unknown, rows: unknown) {
    this.terminals.get(id)?.driver.resize?.(size(cols, 80), size(rows, 24));
  }
  close(id: string) {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    this.terminals.delete(id);
    clearTimeout(terminal.timer);
    terminal.driver.kill();
  }
  dispose() {
    for (const id of this.terminals.keys()) this.close(id);
  }
}
