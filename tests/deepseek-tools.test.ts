import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { deepseekTransport } from '../electron/core/extensions/deepseek-tools';
import { FILE_INPUTS_META } from '../electron/core/extensions/mcp-files';
import { appConnectorFor } from '../shared/app-connectors';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers';
import { Store } from '../electron/core/storage/store';
import { Integrations } from '../electron/core/extensions/integrations';
import { Attachments } from '../electron/core/attachments/attachments';
import { Harness } from '../electron/core/agent/harness';
import type { ModelClient } from '../electron/core/model/model';
import type { VmController } from '../electron/core/vm/vm';

interface Call {
  path: string;
  body: any;
  auth: string | null;
}
type Respond = (
  path: string,
  body: any,
  index: number,
) =>
  { status?: number; json?: unknown; body?: BodyInit } | Promise<{ status?: number; json?: unknown; body?: BodyInit }>;

/** Multipart fields as plain values, with files as their name, type and bytes. */
async function fields(form: FormData) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of form.entries())
    result[key] =
      typeof value === 'string'
        ? value
        : { name: value.name, type: value.type, bytes: Buffer.from(await value.arrayBuffer()) };
  return result;
}

function mockFetch(respond: Respond) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input)),
      body = init?.body instanceof FormData ? await fields(init.body) : JSON.parse(String(init?.body));
    calls.push({ path: url.pathname, body, auth: new Headers(init?.headers).get('authorization') });
    const reply = await respond(url.pathname, body, calls.length - 1);
    return new Response(reply.body ?? JSON.stringify(reply.json), { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

async function connect(respond: Respond) {
  const mock = mockFetch(respond);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(await deepseekTransport('sk-test'));
  return {
    client,
    calls: mock.calls,
    text: async (name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) => {
      const result: any = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
      return { text: result.content[0].text as string, isError: result.isError === true };
    },
    close: async () => {
      mock.restore();
      await client.close();
    },
  };
}

/** A file handed over by the tool layer, as the bridge passes it. */
function bridged(dir: string, name: string, bytes: Uint8Array, mime: string) {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return { [FILE_INPUTS_META]: { file: { path, name, mime, size: bytes.length } } };
}

test('DeepSeek is a token app in the catalog served inside the app', () => {
  const app = appConnectorFor('https://api.deepseek.com/v1/tools/');
  assert.equal(app?.id, 'deepseek');
  assert.equal(app?.auth, 'token');
  assert.equal(app?.builtin, true);
});

test('DeepSeek search sends the key and formats results for the model', async () => {
  const server = await connect(() => ({
    json: {
      results: [
        {
          rerank_score: 2.1,
          title: 'DeepSeek API',
          url: 'https://api-docs.deepseek.com/',
          snippet: 'short',
          summary: 'long summary',
          content: 'x'.repeat(5000),
          site_name: 'DeepSeek',
          date: '2026-10-01T00:00:00Z',
          authority: 3,
        },
      ],
    },
  }));
  try {
    const { tools } = await server.client.listTools();
    assert.deepEqual(
      tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint]),
      [
        ['search', true],
        ['fetch', true],
        ['ocr', true],
      ],
    );
    const result = await server.text('search', { query: 'deepseek site:deepseek.com', need_content: true });
    assert.equal(server.calls[0].path, '/v1/tools/search');
    assert.equal(server.calls[0].auth, 'Bearer sk-test');
    assert.deepEqual(server.calls[0].body, { query: 'deepseek site:deepseek.com', count: 10, need_content: true });
    assert.equal(result.isError, false);
    assert.match(result.text, /^1\. DeepSeek API\nhttps:\/\/api-docs\.deepseek\.com\/\nDeepSeek · 2026-10-01/);
    assert.match(result.text, /long summary/);
    assert.match(result.text, /正文已截断/);
    assert.ok(result.text.length < 4500);
  } finally {
    await server.close();
  }
});

test('DeepSeek fetch pages long content from one request', async () => {
  const server = await connect(() => ({ json: { title: 'Page', content: 'a'.repeat(150) + 'b'.repeat(100) } }));
  try {
    const first = await server.text('fetch', { url: 'https://example.com/', max_chars: 150 });
    assert.match(first.text, /^# Page\nhttps:\/\/example\.com\/\n\na{150}\n\n.*offset=150/);
    const second = await server.text('fetch', { url: 'https://example.com/', offset: 150, max_chars: 150 });
    assert.match(second.text, /b{100}$/);
    assert.equal(server.calls.length, 1);
    assert.deepEqual(server.calls[0].body, { url: 'https://example.com/' });
  } finally {
    await server.close();
  }
});

test('DeepSeek API errors come back as tool errors', async () => {
  const server = await connect(() => ({
    status: 402,
    json: { error: { message: 'Insufficient Balance', type: 'invalid_request_error', param: null, code: 'x' } },
  }));
  try {
    const result = await server.text('search', { query: 'test' });
    assert.equal(result.isError, true);
    assert.match(result.text, /余额不足.*Insufficient Balance/);
  } finally {
    await server.close();
  }
});

test('DeepSeek OCR uploads the bridged file and pages the recognized text', async (t) => {
  const dir = tempDir(t, 'aelion-deepseek-ocr-');
  const server = await connect(() => ({
    // The service sends newlines while it works, then the result.
    body:
      '\n\n' +
      JSON.stringify({
        object: 'ocr.result',
        page_count: 2,
        pages: [
          { index: 0, text: 'a'.repeat(120), finish_reason: 'stop' },
          { index: 1, text: '第二页', finish_reason: 'length' },
        ],
      }),
  }));
  try {
    const meta = bridged(dir, 'scan.pdf', Buffer.from('%PDF-1.7'), 'application/pdf');
    const first = await server.text('ocr', { file: { attachmentId: 'x' }, layout: true, max_chars: 100 }, meta);
    assert.equal(first.isError, false);
    assert.equal(server.calls[0].path, '/v1/tools/ocr');
    assert.equal(server.calls[0].auth, 'Bearer sk-test');
    assert.equal(server.calls[0].body.purpose, 'rich_layout_recognition');
    assert.equal(server.calls[0].body.file.name, 'scan.pdf');
    assert.equal(server.calls[0].body.file.bytes.toString(), '%PDF-1.7');
    assert.match(first.text, /^--- 第 1 页 ---\na+/);
    assert.match(first.text, /offset=100/);
    const second = await server.text('ocr', { file: { attachmentId: 'x' }, layout: true, offset: 100 }, meta);
    assert.match(second.text, /--- 第 2 页 ---\n第二页\n\[这一页的识别结果达到长度上限/);
    assert.equal(server.calls.length, 1);
    // Text-only recognition is a different result.
    await server.text('ocr', { file: { attachmentId: 'x' } }, meta);
    assert.equal(server.calls.length, 2);
    assert.equal(server.calls[1].body.purpose, 'text_recognition');
  } finally {
    await server.close();
  }
});

test('DeepSeek OCR reports a failure that arrives after recognition started', async (t) => {
  const dir = tempDir(t, 'aelion-deepseek-ocr-');
  const server = await connect(() => ({
    json: { error: { message: 'File is password protected', type: 'invalid_request_error', param: null, code: 'x' } },
  }));
  try {
    const result = await server.text(
      'ocr',
      { file: { attachmentId: 'x' } },
      bridged(dir, 'locked.pdf', Buffer.from('%PDF'), 'application/pdf'),
    );
    assert.equal(result.isError, true);
    assert.match(result.text, /password protected/);
    const outside = await server.text('ocr', { file: { path: '/etc/passwd' } });
    assert.equal(outside.isError, true);
    assert.match(outside.text, /需要在 AelionBot 里调用/);
    assert.equal(server.calls.length, 1);
  } finally {
    await server.close();
  }
});

test('adding DeepSeek with an API key offers its tools without a remote MCP server', async (t) => {
  const root = tempDir(t, 'aelion-deepseek-'),
    paths = {
      homeDir: join(root, 'home'),
      projectDir: join(root, 'project'),
      dataDir: join(root, 'data'),
      configDir: join(root, 'aelion'),
      env: {},
    };
  for (const path of Object.values(paths)) if (typeof path === 'string') mkdirSync(path, { recursive: true });
  const store = new Store(paths.dataDir);
  t.after(() => store.close());
  const codec = {
    encrypt: (value: string) => 'enc:' + Buffer.from(value).toString('base64'),
    decrypt: (value: string) => Buffer.from(value.slice(4), 'base64').toString(),
  };
  const integrations = new Integrations(store, paths, () => {}, undefined, codec);
  t.after(() => integrations.close());
  const id = await integrations.addApp({ app: 'deepseek', token: 'sk-test' });
  const view = integrations.snapshot().servers.find((server) => server.id === id)!;
  assert.equal(view.app, 'deepseek');
  assert.equal(view.login, 'signed-in');
  assert.deepEqual(
    (await integrations.mcp.listTools(id)).tools.map((tool) => tool.name),
    ['search', 'fetch', 'ocr'],
  );
  assert.ok(!readFileSync(join(paths.dataDir, 'mcp-auth.json'), 'utf8').includes('sk-test'));

  // Files reach the tools through the request's _meta, which only servers inside the app receive.
  assert.deepEqual(integrations.mcp.fileBridge(id, 'ocr'), { inputs: ['file'] });
  assert.equal(integrations.mcp.fileBridge(id, 'search'), undefined);
  const mock = mockFetch(() => ({ json: { pages: [{ index: 0, text: '发票', finish_reason: 'stop' }] } }));
  try {
    const result: any = await integrations.mcp.call(
      id,
      'ocr',
      { file: { attachmentId: 'x' } },
      new AbortController().signal,
      undefined,
      bridged(root, 'receipt.png', Buffer.from('png'), 'image/png'),
    );
    assert.equal(result.content[0].text, '发票');
    assert.equal(mock.calls[0].body.file.name, 'receipt.png');
  } finally {
    mock.restore();
  }

  await integrations.signOut(id);
  await assert.rejects(integrations.mcp.listTools(id), /需要登录/);
});

test('the tool layer hands named files to tools inside the app as stored attachments', async (t) => {
  const root = tempDir(t, 'aelion-deepseek-bridge-'),
    store = new Store(root);
  t.after(() => store.close());
  const bot = store.data.bots[0],
    scan = new Attachments(store).importForBot(bot.id, 'scan.png', Buffer.from('png bytes'));
  const seen: Array<{ tool: string; meta?: Record<string, any> }> = [];
  const mcp = {
    context: () => ({ tools: [], prompt: '' }),
    inspectCall: async () => ({ fingerprint: 'fixture' }),
    fileBridge: (_server: string, tool: string) => (tool === 'ocr' ? { inputs: ['file'] } : undefined),
    call: async (_server: string, tool: string, _args: unknown, _signal: AbortSignal, _fp: string, meta?: any) => {
      seen.push({ tool, meta });
      return { content: [{ type: 'text', text: 'ok' }], untrusted: true };
    },
  };
  const call = (id: string, name: string, args: unknown) => ({
    id,
    type: 'function',
    function: { name: 'mcp_call', arguments: JSON.stringify({ server: 'ds', name, arguments: args }) },
  });
  let turns = 0;
  const model = {
    complete: async () =>
      turns++
        ? { content: '好了', finishReason: 'stop', calls: [] }
        : {
            content: '',
            finishReason: 'tool_calls',
            calls: [call('ocr', 'ocr', { file: { attachmentId: scan.id } }), call('search', 'search', { query: 'x' })],
          },
  } as unknown as ModelClient;
  await new Harness(store, {} as VmController, model, () => {}, undefined, undefined, {
    mcp,
  } as unknown as Integrations).run(bot.id, '识别图片');
  const ocr = seen.find((item) => item.tool === 'ocr')!.meta![FILE_INPUTS_META].file;
  assert.equal(ocr.name, 'scan.png');
  assert.equal(ocr.mime, 'image/png');
  assert.equal(readFileSync(ocr.path, 'utf8'), 'png bytes');
  // Other servers' tools get no paths.
  assert.equal(seen.find((item) => item.tool === 'search')!.meta, undefined);
  assert.equal(store.data.runs[0].status, 'completed');
});
