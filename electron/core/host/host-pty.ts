import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { TerminalDriver } from '../tools/terminal-sessions';

export interface PtyOptions {
  executable: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}
export function spawnPty(runtimeDir: string, { executable, args, cwd, cols, rows, env }: PtyOptions): TerminalDriver {
  // node-pty rewrites its Mac spawn-helper path itself. Loading its JS from
  // app.asar.unpacked on Mac would rewrite that path a second time.
  const load = createRequire(join(runtimeDir, 'terminal-loader.cjs')),
    resolved = load.resolve('node-pty'),
    file = process.platform === 'win32' ? resolved.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1') : resolved,
    pty = load(file) as typeof import('node-pty');
  const child = pty.spawn(executable, args, {
    name: 'xterm-256color',
    cwd,
    cols,
    rows,
    env: Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
    useConpty: true,
  });
  // node-pty 1.1.0 leaves its ConPTY reader worker alive on natural exit.
  // Release owned handles directly: public kill() enumerates an already exited
  // console, starting an unnecessary helper and printing AttachConsole errors.
  let released = false,
    stopping = false;
  const release = () => {
    if (released) return;
    released = true;
    if (process.platform === 'win32') {
      const agent = (child as any)._agent;
      // The console may still flush as it closes: the reader thread then writes to the socket destroyed below. With no
      // listener that EPIPE is an uncaught error, which Electron's main process shows as a blocking dialog.
      agent?._conoutSocketWorker?._worker?.on('error', () => {});
      agent?._conoutSocketWorker?.dispose();
      agent?._inSocket?.destroy();
      try {
        agent?._ptyNative?.kill(agent._pty, agent._useConptyDll);
      } catch {}
      agent?._outSocket?.destroy();
    }
  };
  return {
    write: (value) => child.write(value),
    resize: (cols, rows) => child.resize(cols, rows),
    onData: (fn) => child.onData(fn),
    onExit: (fn) =>
      child.onExit((event) => {
        release();
        fn(event.exitCode ?? -1);
      }),
    kill: () => {
      if (stopping || released) return;
      stopping = true;
      if (process.platform === 'win32') {
        const task = spawn(
          join(env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' },
        );
        task.on('error', release);
        task.on('close', release);
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          try {
            child.kill('SIGTERM');
          } catch {}
        }
        const timer = setTimeout(() => {
          if (!released)
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {}
        }, 1500);
        timer.unref();
      }
    },
  };
}
