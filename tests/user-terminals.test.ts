import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { errorCode } from '../shared/errors';
import type { TerminalEvent } from '../shared/types/core';
import { interactiveShell } from '../electron/core/host/host-platform';
import { UserTerminals } from '../electron/core/host/user-terminals';
import { spawnPty, type PtyOptions } from '../electron/core/host/host-pty';
import type { TerminalDriver } from '../electron/core/tools/terminal-sessions';
import { settle, tempDir, until } from './helpers';

function harness() {
  const events: TerminalEvent[] = [],
    spawned: Array<{
      options: PtyOptions;
      data: (text: string) => void;
      exit: (code: number) => void;
      written: string[];
      resized: number[][];
      killed: number;
    }> = [];
  const terminals = new UserTerminals({
    env: {},
    emit: (event) => events.push(event),
    spawn: (options) => {
      const entry = {
        options,
        data: (_text: string) => {},
        exit: (_code: number) => {},
        written: [] as string[],
        resized: [] as number[][],
        killed: 0,
      };
      spawned.push(entry);
      return {
        write: (text) => entry.written.push(text),
        resize: (cols, rows) => entry.resized.push([cols, rows]),
        kill: () => entry.killed++,
        onData: (fn) => (entry.data = fn),
        onExit: (fn) => (entry.exit = fn),
      } satisfies TerminalDriver;
    },
  });
  return { terminals, events, spawned };
}

test('reopening a conversation keeps its shell, and each conversation gets its own', (t) => {
  const { terminals, spawned } = harness(),
    cwd = tempDir(t);
  assert.deepEqual(terminals.open('bot:a', cwd, 100, 30), { id: 'bot:a', cwd });
  terminals.open('bot:a', cwd, 100, 30);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].options.cwd, cwd);
  assert.deepEqual([spawned[0].options.cols, spawned[0].options.rows], [100, 30]);
  terminals.open('session:b', cwd, 100, 30);
  assert.equal(spawned.length, 2);
  terminals.dispose();
});

test('a missing working directory and too many terminals fail with stable codes', (t) => {
  const { terminals, spawned } = harness(),
    cwd = tempDir(t);
  assert.throws(
    () => terminals.open('bot:a', join(cwd, 'missing'), 80, 24),
    (error) => errorCode(error) === 'terminal.cwd_missing',
  );
  assert.throws(
    () => terminals.open('bot:a', undefined, 80, 24),
    (error) => errorCode(error) === 'terminal.cwd_missing',
  );
  for (let index = 0; index < 12; index++) terminals.open(`bot:${index}`, cwd, 80, 24);
  assert.throws(
    () => terminals.open('bot:one-more', cwd, 80, 24),
    (error) => errorCode(error) === 'terminal.limit',
  );
  assert.equal(spawned.length, 12);
  terminals.dispose();
});

test('output is delivered in order and before the exit event', async (t) => {
  const { terminals, events, spawned } = harness();
  terminals.open('bot:a', tempDir(t), 80, 24);
  spawned[0].data('one ');
  spawned[0].data('two');
  await until(() => events.length === 1);
  assert.deepEqual(events[0], { type: 'data', id: 'bot:a', data: 'one two' });
  spawned[0].data('bye');
  spawned[0].exit(3);
  assert.deepEqual(events.slice(1), [
    { type: 'data', id: 'bot:a', data: 'bye' },
    { type: 'exit', id: 'bot:a', exitCode: 3 },
  ]);
  // The shell is gone, so opening again starts a new one.
  terminals.open('bot:a', tempDir(t), 80, 24);
  assert.equal(spawned.length, 2);
  terminals.dispose();
});

test('input and resizes reach the right shell, and bad sizes are bounded', (t) => {
  const { terminals, spawned } = harness(),
    cwd = tempDir(t);
  terminals.open('bot:a', cwd, 80, 24);
  terminals.open('bot:b', cwd, 80, 24);
  terminals.write('bot:b', 'ls\r');
  terminals.write('bot:b', 42);
  terminals.write('bot:missing', 'ignored');
  terminals.resize('bot:a', 9999, 0);
  terminals.resize('bot:a', 'wide', 40);
  assert.deepEqual(spawned[0].written, []);
  assert.deepEqual(spawned[1].written, ['ls\r']);
  assert.deepEqual(spawned[0].resized, [
    [500, 2],
    [80, 40],
  ]);
  terminals.dispose();
});

test('closing stops the shell and drops what it was still printing', async (t) => {
  const { terminals, events, spawned } = harness(),
    cwd = tempDir(t);
  terminals.open('bot:a', cwd, 80, 24);
  terminals.open('bot:b', cwd, 80, 24);
  spawned[0].data('late');
  terminals.close('bot:a');
  terminals.close('bot:a');
  assert.equal(spawned[0].killed, 1);
  spawned[0].data('later');
  spawned[0].exit(0);
  spawned[1].data('done');
  await until(() => events.length > 0);
  assert.deepEqual(events, [{ type: 'data', id: 'bot:b', data: 'done' }]);
  terminals.dispose();
  assert.equal(spawned[1].killed, 1);
});

test('the interactive shell runs no command, unlike the one Bots use', () => {
  assert.deepEqual(interactiveShell({ SHELL: '/usr/bin/fish' }, 'linux'), {
    executable: '/usr/bin/fish',
    args: ['-l'],
  });
  assert.deepEqual(interactiveShell({}, 'darwin'), { executable: '/bin/zsh', args: ['-l'] });
  const windows = interactiveShell({ AELION_PWSH: 'off', SystemRoot: 'C:\\Windows' }, 'win32');
  assert.deepEqual(windows.args, ['-NoLogo']);
  assert.match(windows.executable, /powershell\.exe$/);
});

test('a real shell in a pty echoes input from its working directory', async (t) => {
  const cwd = tempDir(t),
    events: TerminalEvent[] = [];
  const terminals = new UserTerminals({
    env: process.env,
    emit: (event) => events.push(event),
    spawn: (options) => spawnPty(join(process.cwd(), 'electron', 'core'), options),
  });
  t.after(() => terminals.dispose());
  terminals.open('bot:a', cwd, 120, 30);
  const output = () =>
    stripVTControlCharacters(events.map((event) => (event.type === 'data' ? event.data : '')).join(''));
  // Computed by the shell, so the echo of the typed line alone cannot satisfy the wait.
  terminals.write(
    'bot:a',
    process.platform === 'win32' ? 'echo "aelion-$(6*7)-marker"\r' : 'echo aelion-$((6*7))-marker\r',
  );
  await until(() => output().includes('aelion-42-marker'), { timeoutMs: 20_000, message: () => output() });
  terminals.write('bot:a', 'exit\r');
  await until(() => events.some((event) => event.type === 'exit'), { timeoutMs: 20_000 });
});

test('killing a real shell ends it without an uncaught error from the pty teardown', async (t) => {
  const shell = interactiveShell(process.env),
    driver = spawnPty(join(process.cwd(), 'electron', 'core'), {
      executable: shell.executable,
      args: shell.args,
      cwd: tempDir(t),
      cols: 100,
      rows: 30,
      env: process.env,
    });
  let exited = false,
    output = '';
  driver.onData((text) => (output += text));
  driver.onExit(() => (exited = true));
  await until(() => output.length > 0, { timeoutMs: 20_000 });
  // Killed once the shell has settled: the teardown only fails with the reader thread connected and idle.
  await settle(2500);
  driver.kill();
  await until(() => exited, { timeoutMs: 20_000 });
  // The pty's reader thread reports a failed write only after the shell has gone.
  await settle(1000);
});
