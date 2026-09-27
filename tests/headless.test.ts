import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { acquireHeadlessLock, runHeadless, type HeadlessEvent } from '../electron/core/agent/headless';
import { Store } from '../electron/core/storage/store';

type Step = (messages: any[]) => { tool?: { name: string; args: unknown }; text?: string };
async function modelServer(t: test.TestContext, step: Step) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const next = step(body.messages);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (next.tool)
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-' + requests.length, type: 'function', function: { name: next.tool.name, arguments: JSON.stringify(next.tool.args) } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
      );
    else
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: next.text || '' }, finish_reason: 'stop' }] })}\n\n`,
      );
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise<void>((ok) => server.close(() => ok())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}
function fixture(t: test.TestContext) {
  const parent = realpathSync.native(tmpdir()),
    root = mkdtempSync(join(parent, 'aelion-headless-')),
    workspace = join(root, 'project'),
    data = join(root, 'data'),
    home = join(root, 'home');
  for (const dir of [workspace, home]) mkdirSync(dir);
  t.after(() => {
    assert.equal(dirname(resolve(root)), parent);
    rmSync(root, { recursive: true, force: true });
  });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AELION_')));
  return { root, workspace, data, home, env: { ...env, HOME: home, USERPROFILE: home } };
}
const toolResults = (messages: any[]) =>
  messages.filter((message) => message.role === 'tool').map((message) => String(message.content));

test('headless run edits the workspace, denies what would wait for a person and reports the final reply', async (t) => {
  const f = fixture(t);
  const { baseUrl, requests } = await modelServer(t, (messages) => {
    const results = toolResults(messages);
    if (results.length === 0)
      return {
        tool: {
          name: 'host_file_write',
          args: { path: 'notes.txt', content: 'headless ok\n', reason: 'record the result' },
        },
      };
    if (results.length === 1)
      return { tool: { name: 'host_execute', args: { command: 'Remove-Item notes.txt', reason: 'clean up' } } };
    return { text: results[1].includes('headless') ? '写入完成，删除操作被拒绝。' : 'unexpected' };
  });
  const events: HeadlessEvent[] = [];
  const result = await runHeadless({
    prompt: '写一个 notes.txt',
    workspaceDir: f.workspace,
    dataDir: f.data,
    homeDir: f.home,
    configDir: join(f.home, '.aelion'),
    env: f.env,
    model: { baseUrl, model: 'fake-model', contextTokens: 64000 },
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.status, 'completed', result.error || '');
  assert.equal(result.reply, '写入完成，删除操作被拒绝。');
  assert.equal(result.denied, 1);
  assert.equal(readFileSync(join(f.workspace, 'notes.txt'), 'utf8'), 'headless ok\n');
  assert.ok(events.some((event) => event.type === 'started'));
  assert.ok(events.some((event) => event.type === 'denied' && event.operation === 'command'));
  const tools = new Set(requests[0].tools.map((tool: any) => tool.function.name));
  for (const name of ['host_execute', 'host_file_write', 'host_search_files']) assert.ok(tools.has(name), name);
  for (const name of ['computer', 'computer_execute', 'file_write', 'python_execute', 'request_user_input'])
    assert.ok(!tools.has(name), name);
  assert.match(requests[0].messages[0].content, /unattended headless run/);
  // The endpoint and model are saved for the next run; the key never is.
  const store = new Store(f.data, { incremental: true });
  try {
    assert.equal(store.data.defaultModel?.model, 'fake-model');
    assert.ok(!JSON.stringify(store.data.providers).includes('encryptedKey'));
  } finally {
    store.close();
  }
  assert.equal(existsSync(join(f.data, 'headless.lock')), false);
});

test('full permission runs host commands and a timeout stops a run that never finishes', async (t) => {
  const f = fixture(t);
  const { baseUrl } = await modelServer(t, (messages) => {
    const results = toolResults(messages);
    return results.length
      ? { text: results[0].includes('from-node') ? '命令已执行' : 'no output' }
      : {
          tool: {
            name: 'host_execute',
            args: { command: 'node -e "console.log(\'from-node\')"', reason: 'check node' },
          },
        };
  });
  const result = await runHeadless({
    prompt: '运行 node',
    workspaceDir: f.workspace,
    dataDir: f.data,
    homeDir: f.home,
    configDir: join(f.home, '.aelion'),
    env: f.env,
    permission: 'full',
    model: { baseUrl, model: 'fake-model' },
  });
  assert.equal(result.status, 'completed', result.error || '');
  assert.equal(result.reply, '命令已执行');
  assert.equal(result.denied, 0);
  assert.ok(result.executions.some((item) => item.tool === 'host_execute' && item.status === 'succeeded'));
  const slow = await modelServer(t, () => ({
    tool: { name: 'host_execute', args: { command: 'node -e "setTimeout(()=>{},60000)"', reason: 'wait' } },
  }));
  const started = Date.now(),
    stopped = await runHeadless({
      prompt: '等待',
      workspaceDir: f.workspace,
      dataDir: f.data,
      homeDir: f.home,
      configDir: join(f.home, '.aelion'),
      env: f.env,
      permission: 'full',
      timeoutMs: 1500,
      model: { baseUrl: slow.baseUrl, model: 'fake-model' },
    });
  assert.equal(stopped.status, 'cancelled');
  assert.ok(Date.now() - started < 20000);
});

test('one headless run owns a data directory at a time and a stale lock is replaced', (t) => {
  const f = fixture(t),
    release = acquireHeadlessLock(f.data);
  assert.throws(() => acquireHeadlessLock(f.data), /另一个 headless 任务/);
  release();
  writeFileSync(join(f.data, 'headless.lock'), '999999999');
  const again = acquireHeadlessLock(f.data);
  assert.equal(readFileSync(join(f.data, 'headless.lock'), 'utf8'), String(process.pid));
  again();
});

test('the bundled CLI validates arguments and exits with a usage code', async (t) => {
  const f = fixture(t),
    out = join(f.root, 'cli.cjs');
  await build({
    entryPoints: ['electron/cli.ts'],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: [
      'electron',
      'node-pty',
      'quickjs-emscripten',
      'ssh2',
      '@modelcontextprotocol/sdk',
      'yaml',
      'smol-toml',
      'jsonc-parser',
      'js-tiktoken',
    ],
    logLevel: 'silent',
  });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [out, ...args], {
      encoding: 'utf8',
      env: { ...f.env, NODE_PATH: resolve('node_modules') },
      input: '',
    });
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--permission/);
  assert.equal(run('task', '--permission', 'root').status, 2);
  assert.equal(run().status, 2);
  assert.equal(run('task', '--unknown').status, 2);
});
