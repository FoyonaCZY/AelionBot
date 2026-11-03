import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import type { HostComputer } from '../host/host';
import type { Interactions } from '../agent/interactions';
import type { VmController } from '../vm/vm';
import { hostEnvironment, hostShell, stopHostProcess } from '../host/host-platform';
import { spawnPty } from '../host/host-pty';
import { approvalReason } from './approval-reason';
import { boundedInteger, FileToolError, textPage } from './file-text';
import { backoff } from '../model/model';
import { MAX_YIELD_MS } from './foundation-tools';
export interface TerminalDriver {
  write: (text: string) => void;
  kill: () => void;
  resize?: (cols: number, rows: number) => void;
  onData: (fn: (text: string) => void) => unknown;
  onExit: (fn: (code: number) => void) => unknown;
}
/** Test doubles and older VM objects only implement execute. Surface that as a terminal that has already exited. */
async function oneShotTerminal(
  vm: VmController,
  botId: string,
  command: string,
  signal: AbortSignal,
): Promise<TerminalDriver> {
  const result = await vm.execute(command, botId, signal);
  const text = [result.stdout, result.stderr].filter((part) => typeof part === 'string' && part).join('\n');
  return {
    write: () => {},
    kill: () => {},
    onData: (fn) => {
      if (text) fn(text);
    },
    onExit: (fn) => fn(typeof result.exitCode === 'number' ? result.exitCode : 0),
  };
}
interface Session {
  id: string;
  botId: string;
  runId: string;
  location: 'host' | 'vm';
  command: string;
  cwd: string;
  tty: boolean;
  purpose: 'task' | 'service';
  driver: TerminalDriver;
  output: string;
  baseOffset: number;
  createdAt: string;
  exitCode?: number;
  closed: boolean;
  /** Runs on without this process: dispose leaves it alone. */
  detached?: boolean;
}
export class TerminalSessions {
  private sessions = new Map<string, Session>();
  /** Headless: a host service must outlive the CLI, so it writes to a log file instead of pipes that close on exit. */
  keepServices = false;
  constructor(
    private vm: VmController,
    private host: HostComputer | undefined,
    private interactions: Interactions | undefined,
    private runtimeDir: string,
  ) {}
  private get(botId: string, id: string) {
    const session = this.sessions.get(id);
    if (!session || session.botId !== botId)
      throw new FileToolError('TERMINAL_NOT_FOUND', '终端不存在、已重启或不属于当前 Bot');
    return session;
  }
  async start(botId: string, runId: string, args: Record<string, unknown>, signal: AbortSignal, workspace?: string) {
    if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 6000)
      throw Error('终端命令需要 1–6000 字符');
    if (this.list(botId).filter((session) => session.exitCode === undefined).length >= 6)
      throw Error('当前 Bot 最多保留 6 个运行终端');
    if ([...this.sessions.values()].filter((session) => !session.closed).length >= 12)
      throw Error('应用最多同时保留 12 个运行终端，请先停止不再使用的终端');
    const location = args.location === 'vm' ? 'vm' : 'host',
      tty = args.tty !== false,
      cols = boundedInteger(args.cols, 100, 20, 300, 'cols'),
      rows = boundedInteger(args.rows, 30, 5, 100, 'rows');
    let cwd = workspace || '',
      driver: TerminalDriver,
      detached = false;
    if (location === 'host') {
      if (!this.host || !this.interactions) throw Error('本机终端不可用');
      if (typeof args.stdin === 'string' && args.stdin.length > 262144) throw Error('stdin 过长');
      const reason = approvalReason(args, String(args.command));
      cwd = this.host.resolveFilePath(args.cwd || workspace || this.host.workspace(botId), workspace);
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw Error('终端工作目录不存在');
      cwd = realpathSync.native(cwd);
      await this.interactions.permission(
        botId,
        runId,
        {
          operation: 'command',
          reason,
          command: args.command,
          cwd,
          ...(typeof args.stdin === 'string' ? { stdin: args.stdin } : {}),
          tool: typeof args.tool === 'string' ? args.tool : 'terminal_start',
          arguments: { tty },
        },
        signal,
      );
      signal.throwIfAborted();
      if (realpathSync.native(cwd) !== cwd) throw Error('目录在审批期间发生变化');
      const env = hostEnvironment(this.host.options.env || process.env),
        shell = hostShell(args.command, env),
        shellArgs = tty ? shell.args.filter((arg) => arg !== '-NonInteractive') : shell.args;
      if (tty) {
        driver = spawnPty(this.runtimeDir, { executable: shell.executable, args: shellArgs, cwd, cols, rows, env });
      } else if (this.keepServices && args.purpose === 'service' && !args.stdin) {
        const log = join(mkdtempSync(join(tmpdir(), 'aelion-service-')), 'output.log'),
          out = openSync(log, 'a');
        const child = spawn(shell.executable, shellArgs, {
          cwd,
          env,
          windowsHide: true,
          detached: true,
          stdio: ['ignore', out, out],
        });
        closeSync(out);
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        });
        child.unref();
        detached = true;
        const reader = openSync(log, 'r'),
          decoder = new StringDecoder('utf8'),
          chunk = Buffer.alloc(65536);
        let position = 0,
          emit = (_text: string) => {};
        const pump = () => {
          for (let size: number; (size = readSync(reader, chunk, 0, chunk.length, position)) > 0; position += size)
            emit(decoder.write(chunk.subarray(0, size)));
        };
        const timer = setInterval(pump, 100);
        timer.unref();
        driver = {
          write: () => {},
          onData: (fn) => {
            emit = fn;
          },
          onExit: (fn) => {
            child.on('close', (code) => {
              clearInterval(timer);
              pump();
              closeSync(reader);
              fn(code ?? -1);
            });
          },
          kill: () => stopHostProcess(child, env),
        };
      } else {
        const child = spawn(shell.executable, shellArgs, {
          cwd,
          env,
          windowsHide: true,
          detached: shell.detached,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        });
        driver = {
          write: (value) => {
            child.stdin.write(value);
          },
          onData: (fn) => {
            child.stdout.on('data', (bytes) => fn(bytes.toString('utf8')));
            child.stderr.on('data', (bytes) => fn(bytes.toString('utf8')));
          },
          onExit: (fn) => {
            child.on('close', (code) => fn(code ?? -1));
          },
          kill: () => stopHostProcess(child, env),
        };
      }
    } else {
      cwd = posix.resolve(`/work/${botId}`, typeof args.cwd === 'string' ? args.cwd : '.');
      if (cwd !== `/work/${botId}` && !cwd.startsWith(`/work/${botId}/`))
        throw Error('VM 终端目录必须在当前 Bot 工作目录内');
      driver =
        typeof this.vm.openTerminal === 'function'
          ? await this.vm.openTerminal(botId, args.command, cwd, signal, tty ? { cols, rows } : undefined)
          : await oneShotTerminal(this.vm, botId, args.command, signal);
    }
    const session: Session = {
      id: randomUUID(),
      botId,
      runId,
      location,
      cwd,
      command: args.command,
      tty,
      purpose: args.purpose === 'service' ? 'service' : 'task',
      driver,
      output: '',
      baseOffset: 0,
      createdAt: new Date().toISOString(),
      closed: false,
      detached,
    };
    this.sessions.set(session.id, session);
    driver.onData((text) => {
      session.output += text;
      if (session.output.length > 2 * 1024 * 1024) {
        const remove = session.output.length - 1024 * 1024;
        session.output = session.output.slice(remove);
        session.baseOffset += remove;
      }
    });
    driver.onExit((code) => {
      session.exitCode = code;
      session.closed = true;
    });
    if (signal.aborted) {
      driver.kill();
      signal.throwIfAborted();
    }
    for (const [id, value] of this.sessions) if (value.closed && this.sessions.size > 64) this.sessions.delete(id);
    try {
      if (typeof args.stdin === 'string' && args.stdin) driver.write(args.stdin);
      return await this.read(
        botId,
        session.id,
        signal,
        boundedInteger(args.yieldTimeMs, 1000, 0, MAX_YIELD_MS, 'yieldTimeMs'),
        0,
      );
    } catch (error) {
      if (signal.aborted) {
        try {
          driver.kill();
        } catch {}
      }
      throw error;
    }
  }
  async input(botId: string, runId: string, args: Record<string, unknown>, signal: AbortSignal) {
    const session = this.get(botId, String(args.id));
    if (typeof args.chars !== 'string' || args.chars.length > 16000) throw Error('输入必须是最多 16000 字符的文本');
    const chars = args.chars;
    // Polling a command that has finished returns its remaining output and exit code.
    if (session.closed && !chars)
      return this.read(
        botId,
        session.id,
        signal,
        0,
        boundedInteger(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset'),
      );
    if (session.closed) throw Error('终端已退出');
    if (chars && session.location === 'host') {
      if (!this.interactions) throw Error('本机终端不可用');
      await this.interactions.permission(
        botId,
        runId,
        {
          operation: 'command',
          reason: approvalReason(args, chars),
          cwd: session.cwd,
          command: session.command + '\n# 继续向终端发送输入\n' + JSON.stringify(chars),
          tool: typeof args.tool === 'string' ? args.tool : 'terminal_input',
          arguments: { sessionId: session.id, input: chars, initialCommand: session.command },
        },
        signal,
      );
    }
    signal.throwIfAborted();
    if (session.closed) throw Error('终端已退出，未发送输入');
    if (chars) session.driver.write(chars);
    if (args.cols !== undefined || args.rows !== undefined)
      session.driver.resize?.(
        boundedInteger(args.cols, 100, 20, 300, 'cols'),
        boundedInteger(args.rows, 30, 5, 100, 'rows'),
      );
    return this.read(
      botId,
      session.id,
      signal,
      boundedInteger(args.yieldTimeMs, 250, 0, MAX_YIELD_MS, 'yieldTimeMs'),
      boundedInteger(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset'),
    );
  }
  async read(botId: string, id: string, signal: AbortSignal, waitMs = 1000, offset = 0) {
    const session = this.get(botId, id),
      until = Date.now() + waitMs,
      start = session.baseOffset + session.output.length;
    // A task yields when it exits or the time is up, not at its first output: a command that prints and then
    // finishes a moment later would come back as still running with half its output. A service never exits, so its
    // first output (usually the line saying it is listening) is the signal to hand control back.
    const settled = () =>
      session.closed || (session.purpose === 'service' && session.baseOffset + session.output.length !== start);
    while (!settled() && Date.now() < until) await backoff(Math.min(100, until - Date.now()), signal);
    signal.throwIfAborted();
    const safe = this.host?.redact(session.output) || session.output,
      page = textPage(safe, { offset: Math.max(0, offset - session.baseOffset), maxChars: 16000 });
    return {
      id: session.id,
      location: session.location,
      cwd: session.cwd,
      tty: session.tty,
      purpose: session.purpose,
      status: session.closed ? 'exited' : 'running',
      exitCode: session.exitCode,
      // A command that has been quiet for a while is not necessarily stuck: say how long it has run, and where its
      // output may have gone, so the model does not stop an install halfway.
      ...(!session.closed && session.purpose === 'task'
        ? {
            elapsedMs: Date.now() - Date.parse(session.createdAt),
            note: '命令仍在运行，没有输出不代表卡住。用 write_stdin 继续等待；若输出被重定向到文件，请读那个文件。不要停止仍在安装或构建的命令。',
          }
        : {}),
      output: stripVTControlCharacters(page.content),
      offset: session.baseOffset + page.offset,
      nextOffset: session.baseOffset + page.nextOffset,
      hasMore: !page.eof,
      truncated: offset < session.baseOffset,
    };
  }
  private guestGone() {
    const state = this.vm.state;
    return !state || state.status !== 'ready' || Boolean(state.maintenance);
  }
  async stop(botId: string, id: string, signal: AbortSignal) {
    const session = this.get(botId, id);
    if (!session.closed) {
      try {
        session.driver.kill();
      } catch {}
      if (session.location === 'vm' && this.guestGone()) {
        session.closed = true;
        session.exitCode ??= -1;
      } else {
        const until = Date.now() + 3000;
        while (!session.closed && Date.now() < until) await backoff(100, signal);
      }
    }
    const result = await this.read(botId, id, signal, 0, 0);
    return {
      ...result,
      stopped: result.status === 'exited',
      processExitCode: result.exitCode,
      exitCode: result.status === 'exited' ? 0 : undefined,
    };
  }
  list(botId: string, runId?: string) {
    return [...this.sessions.values()]
      .filter((session) => session.botId === botId && (!runId || session.runId === runId))
      .map(({ id, runId, purpose, exitCode, location, command, cwd, createdAt, closed }) => ({
        id,
        runId,
        purpose,
        exitCode,
        location,
        command,
        cwd,
        createdAt,
        status: closed ? 'exited' : 'running',
      }));
  }
  live(botId: string) {
    return [...this.sessions.values()]
      .filter((session) => session.botId === botId && !session.closed)
      .map(({ id, runId, purpose, location, command, cwd, createdAt }) => ({
        id,
        runId,
        purpose,
        location,
        command,
        cwd,
        createdAt,
      }));
  }
  async cancelRun(botId: string, runId: string) {
    const stopping = [...this.sessions.values()].filter(
      (session) => session.botId === botId && session.runId === runId && !session.closed,
    );
    await Promise.all(
      stopping.map((session) => this.stop(botId, session.id, AbortSignal.timeout(8000)).catch(() => {})),
    );
  }
  async forgetBot(botId: string, signal: AbortSignal) {
    for (const session of Array.from(this.sessions.values()))
      if (session.botId === botId) {
        if (!session.closed)
          try {
            await this.stop(botId, session.id, signal);
          } catch (error) {
            if (!(session.location === 'vm' && this.guestGone())) throw error;
            session.closed = true;
            session.exitCode ??= -1;
          }
        if (!session.closed && session.location === 'vm' && this.guestGone()) {
          session.closed = true;
          session.exitCode ??= -1;
        }
        if (!session.closed) throw Error('终端尚未确认退出，请稍后再删除 Bot');
        this.sessions.delete(session.id);
      }
  }
  dispose() {
    for (const session of this.sessions.values()) if (!session.closed && !session.detached) session.driver.kill();
    this.sessions.clear();
  }
}
