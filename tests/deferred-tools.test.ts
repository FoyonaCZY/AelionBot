import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tempDir, until } from './helpers';
import { Store } from '../electron/core/storage/store';
import { Integrations } from '../electron/core/extensions/integrations';
import { TaskScheduler } from '../electron/core/scheduler/task-scheduler';
import { Harness, TOOLS } from '../electron/core/agent/harness';
import {
  COMPACT_TOOLS,
  CORE_ACTIVE_TOOLS,
  EAGER_MCP_TOOL_THRESHOLD,
  extractHistoryToolNames,
  selectModelTools,
} from '../electron/core/agent/tool-loading';
import { discoverTools } from '../electron/core/tools/tool-discovery';
import type { Completion, ModelClient, ToolDefinition } from '../electron/core/model/model';
import type { VmController } from '../electron/core/vm/vm';
import type { WireMessage } from '../shared/types/core';
import { formatTeachingPrompt, isTeachingPrompt } from '../shared/teaching/teaching-events';

const call = (name: string, args: unknown) => ({
  id: randomUUID(),
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => resolve(text));
  });
const writeJson = (response: ServerResponse, value: unknown) =>
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));

/** A local MCP server exposing 6 tools (above EAGER_MCP_TOOL_THRESHOLD) so native MCP tools are deferred initially. */
async function trackerMcpServer(t: test.TestContext) {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const tools = [
    {
      name: 'search_issues',
      description: 'Search tracker issues by keyword',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'create_issue',
      description: 'Create a new tracker issue',
      inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_issue',
      description: 'Read one issue by id',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'list_prs',
      description: 'List open pull requests',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'merge_pr',
      description: 'Merge an approved pull request',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'search_code',
      description: 'Search repository source code',
      inputSchema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
      annotations: { readOnlyHint: true },
    },
  ];
  const http = createServer(async (request, response) => {
    if (request.method !== 'POST') return response.writeHead(405).end();
    const message = JSON.parse(await readBody(request));
    if (message.id === undefined) return response.writeHead(202).end();
    if (message.method === 'initialize')
      return writeJson(response, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'tracker', version: '1' },
        },
      });
    if (message.method === 'tools/list')
      return writeJson(response, { jsonrpc: '2.0', id: message.id, result: { tools } });
    if (message.method === 'tools/call') {
      calls.push(message.params);
      return writeJson(response, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: `ok:${message.params.name}:${JSON.stringify(message.params.arguments)}` }],
        },
      });
    }
    return writeJson(response, { jsonrpc: '2.0', id: message.id, result: {} });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  t.after(() => http.close());
  return { url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/mcp`, calls };
}

function assertCanonicalOrder(actualNames: string[], canonicalOrder: string[]) {
  let lastIndex = -1;
  for (const name of actualNames) {
    const idx = canonicalOrder.indexOf(name);
    assert.ok(idx > lastIndex, `Tool "${name}" appeared out of canonical order (index ${idx} after ${lastIndex})`);
    lastIndex = idx;
  }
}

test('large-context initial modelTools excludes deferred tools while keeping core tools', async (t) => {
  const dir = tempDir(t, 'aelion-deferred-init-');
  const store = new Store(dir);
  t.after(() => store.close());
  store.data.model.model = 'fixture';
  store.data.model.contextTokens = 128000;

  let turn1Tools: string[] = [];
  const model = {
    complete: async (_messages: WireMessage[], tools: ToolDefinition[]): Promise<Completion> => {
      turn1Tools = tools.map((tool) => tool.function.name);
      return { content: '完成。', calls: [], finishReason: 'stop' };
    },
  } as unknown as ModelClient;

  const harness = new Harness(store, {} as VmController, model, () => {});
  const scheduler = new TaskScheduler(store, { ready: () => false, send: () => {} }, () => {});
  harness.setTaskScheduler(scheduler);
  t.after(() => {
    scheduler.dispose();
    harness.disposeTools();
  });

  await harness.run(store.data.bots[0].id, '简单问答');
  assert.equal(store.data.runs[0].status, 'completed');

  for (const core of [
    'exec_command',
    'file_read',
    'apply_patch',
    'code_exec',
    'tool_search',
    'read_result',
    'plan_update',
  ])
    assert.ok(turn1Tools.includes(core), `Expected core tool ${core} in turn 1 modelTools`);

  for (const deferred of [
    'checkpoint_list',
    'checkpoint_restore',
    'execution_list',
    'execution_resolve',
    'goal_read',
    'task_read',
    'task_update',
    'automation_create',
    'automations_list',
    'skill_save',
    'attachment_save',
    'python_session',
  ])
    assert.ok(!turn1Tools.includes(deferred), `Expected deferred tool ${deferred} to be omitted on turn 1`);

  assertCanonicalOrder(
    turn1Tools,
    TOOLS.map((tool) => tool.function.name),
  );
});

test('tool_search activates matched built-in deferred tools into modelTools on the next turn in canonical order', async (t) => {
  const dir = tempDir(t, 'aelion-deferred-builtin-');
  const store = new Store(dir);
  t.after(() => store.close());
  store.data.model.model = 'fixture';
  store.data.model.contextTokens = 64000;

  const offeredPerTurn: string[][] = [];
  let searchToolPayload: Record<string, unknown> | undefined;
  let turn = 0;

  const model = {
    complete: async (messages: WireMessage[], tools: ToolDefinition[]): Promise<Completion> => {
      offeredPerTurn.push(tools.map((tool) => tool.function.name));
      turn++;
      if (turn === 1) {
        assert.ok(!offeredPerTurn[0].includes('checkpoint_list'));
        assert.ok(!offeredPerTurn[0].includes('checkpoint_restore'));
        return {
          content: '',
          finishReason: 'tool_calls',
          calls: [call('tool_search', { query: '回滚文件 checkpoint', includeMcp: false })],
        };
      }
      if (turn === 2) {
        const lastTool = messages.filter((m) => m.role === 'tool').at(-1);
        assert.ok(lastTool?.content);
        searchToolPayload = JSON.parse(lastTool.content).result;
        assert.ok(Array.isArray(searchToolPayload?.activated));
        assert.ok((searchToolPayload!.activated as string[]).includes('checkpoint_list'));
        assert.match(String(searchToolPayload!.note), /下一轮直接作为原生工具/);
        assert.ok(offeredPerTurn[1].includes('checkpoint_list'), 'checkpoint_list promoted on turn 2');
        assert.ok(offeredPerTurn[1].includes('checkpoint_restore'), 'checkpoint_restore promoted on turn 2');
        assert.ok(!offeredPerTurn[1].includes('automation_create'), 'unrelated deferred tools stay omitted');
        assertCanonicalOrder(
          offeredPerTurn[1],
          TOOLS.map((tool) => tool.function.name),
        );
        return {
          content: '',
          finishReason: 'tool_calls',
          calls: [call('checkpoint_list', {})],
        };
      }
      return { content: '已查看检查点。', finishReason: 'stop', calls: [] };
    },
  } as unknown as ModelClient;

  const harness = new Harness(store, {} as VmController, model, () => {});
  const scheduler = new TaskScheduler(store, { ready: () => false, send: () => {} }, () => {});
  harness.setTaskScheduler(scheduler);
  t.after(() => {
    scheduler.dispose();
    harness.disposeTools();
  });

  await harness.run(store.data.bots[0].id, '帮我看看文件检查点');
  assert.equal(store.data.runs[0].status, 'completed', store.data.runs[0].error || '');
  assert.equal(turn, 3);
  assert.ok(
    store.data.runs[0].executions?.some((entry) => entry.tool === 'checkpoint_list' && entry.status === 'succeeded'),
  );
});

test('connected MCP servers above threshold are deferred and tool_search activates matched mcp__* tools natively', async (t) => {
  const remote = await trackerMcpServer(t);
  const root = tempDir(t, 'aelion-deferred-mcp-');
  const paths = {
    homeDir: join(root, 'home'),
    projectDir: join(root, 'project'),
    dataDir: join(root, 'data'),
    configDir: join(root, 'aelion'),
    env: {},
  };
  for (const path of Object.values(paths)) if (typeof path === 'string') mkdirSync(path, { recursive: true });
  writeFileSync(join(paths.configDir, 'mcp.json'), JSON.stringify({ mcpServers: { Tracker: { url: remote.url } } }));

  const store = new Store(paths.dataDir);
  t.after(() => store.close());
  store.data.model.model = 'fixture';
  store.data.model.contextTokens = 128000;

  const integrations = new Integrations(store, paths, () => {});
  t.after(() => integrations.close());
  await integrations.refresh();
  await integrations.mcp.warm();
  assert.equal(integrations.snapshot().servers[0].status, 'connected');
  assert.ok((integrations.snapshot().servers[0].toolCount || 0) > EAGER_MCP_TOOL_THRESHOLD);

  const offeredPerTurn: string[][] = [];
  let turn1System = '';
  let turn = 0;

  const model = {
    complete: async (messages: WireMessage[], tools: ToolDefinition[]): Promise<Completion> => {
      offeredPerTurn.push(tools.map((tool) => tool.function.name));
      turn++;
      if (turn === 1) {
        turn1System = messages
          .filter((message) => message.role === 'system')
          .map((message) => message.content || '')
          .join('\n');
        assert.ok(
          !offeredPerTurn[0].some((name) => name.startsWith('mcp__tracker__')),
          'native MCP tools above threshold are deferred on turn 1',
        );
        assert.match(turn1System, /按需加载/);
        return {
          content: '',
          finishReason: 'tool_calls',
          calls: [call('tool_search', { query: 'tracker issue', limit: 3 })],
        };
      }
      if (turn === 2) {
        const result = JSON.parse(messages.filter((m) => m.role === 'tool').at(-1)!.content!).result;
        assert.ok(result.activated.includes('mcp__tracker__search_issues'));
        // No duplicate builtin entry for native MCP tools.
        assert.ok(result.tools.every((item: { source: string; name: string }) => !item.name.startsWith('mcp__')));
        assert.ok(offeredPerTurn[1].includes('mcp__tracker__search_issues'), 'matched MCP tool activated natively');
        assert.ok(!offeredPerTurn[1].includes('mcp__tracker__merge_pr'), 'unmatched MCP tool remains deferred');
        // Native MCP tools stay after built-in tools in canonical order.
        const mcpStart = offeredPerTurn[1].findIndex((name) => name.startsWith('mcp__'));
        assert.ok(mcpStart > 0);
        assert.ok(offeredPerTurn[1].slice(mcpStart).every((name) => name.startsWith('mcp__')));
        return {
          content: '',
          finishReason: 'tool_calls',
          calls: [call('mcp__tracker__search_issues', { query: 'login bug' })],
        };
      }
      assert.ok(messages.some((m) => m.role === 'tool' && m.content?.includes('ok:search_issues')));
      return { content: '已查到问题列表。', finishReason: 'stop', calls: [] };
    },
  } as unknown as ModelClient;

  const harness = new Harness(store, {} as VmController, model, () => {}, undefined, undefined, integrations);
  t.after(() => harness.disposeTools());
  await harness.run(store.data.bots[0].id, '查一下 Tracker 里的登录 bug');
  await until(() => store.data.runs[0]?.status !== 'running');
  assert.equal(store.data.runs[0].status, 'completed', store.data.runs[0].error || '');
  assert.deepEqual(remote.calls, [{ name: 'search_issues', arguments: { query: 'login bug' } }]);

  // Follow-up run in the same conversation keeps the previously used MCP tool active from turn 1.
  let followUpTools: string[] = [];
  const followUpModel = {
    complete: async (_messages: WireMessage[], tools: ToolDefinition[]): Promise<Completion> => {
      followUpTools = tools.map((tool) => tool.function.name);
      return { content: '继续处理完毕。', finishReason: 'stop', calls: [] };
    },
  } as unknown as ModelClient;
  const followUpHarness = new Harness(
    store,
    {} as VmController,
    followUpModel,
    () => {},
    undefined,
    undefined,
    integrations,
  );
  t.after(() => followUpHarness.disposeTools());
  await followUpHarness.run(store.data.bots[0].id, '再查一次');
  assert.ok(
    followUpTools.includes('mcp__tracker__search_issues'),
    'previously called deferred MCP tool stays active in follow-up run',
  );
  assert.ok(!followUpTools.includes('mcp__tracker__merge_pr'), 'unused deferred MCP tools stay deferred');
});

test('code_exec can invoke a deferred tool directly even before tool_search', async (t) => {
  const dir = tempDir(t, 'aelion-deferred-code-exec-');
  const store = new Store(dir);
  t.after(() => store.close());
  store.data.model.model = 'fixture';
  store.data.model.contextTokens = 64000;

  let turn = 0;
  const model = {
    complete: async (messages: WireMessage[], tools: ToolDefinition[]): Promise<Completion> => {
      const names = tools.map((tool) => tool.function.name);
      turn++;
      if (turn === 1) {
        assert.ok(!names.includes('checkpoint_list'), 'checkpoint_list is deferred on turn 1');
        return {
          content: '',
          finishReason: 'tool_calls',
          calls: [
            call('code_exec', {
              code: 'const res = await tools.checkpoint_list({}); emit({ count: Array.isArray(res.result) ? res.result.length : -1 });',
            }),
          ],
        };
      }
      const toolOutput = JSON.parse(messages.filter((m) => m.role === 'tool').at(-1)!.content!);
      assert.deepEqual(toolOutput.result.output, [{ count: 0 }]);
      return { content: '当前没有文件检查点。', finishReason: 'stop', calls: [] };
    },
  } as unknown as ModelClient;

  const harness = new Harness(store, {} as VmController, model, () => {});
  t.after(() => harness.disposeTools());
  await harness.run(store.data.bots[0].id, '直接检查回滚点');
  assert.equal(store.data.runs[0].status, 'completed', store.data.runs[0].error || '');
  assert.ok(
    store.data.runs[0].executions?.some((entry) => entry.tool === 'checkpoint_list' && entry.status === 'succeeded'),
  );
});

test('previously used deferred built-in tools in conversation history remain active on follow-up runs', async (t) => {
  const dir = tempDir(t, 'aelion-deferred-history-');
  const store = new Store(dir);
  t.after(() => store.close());
  store.data.model.model = 'fixture';
  store.data.model.contextTokens = 64000;
  const botId = store.data.bots[0].id;

  // Seed conversation history with a previous deferred tool call.
  store.data.conversations[botId] = [
    { role: 'user', content: '看看检查点' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'prev-1', type: 'function', function: { name: 'checkpoint_list', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'prev-1', content: '{"result":[]}' },
    { role: 'assistant', content: '目前没有检查点。' },
  ];

  let turn1Tools: string[] = [];
  const model = {
    complete: async (_messages: WireMessage[], tools: ToolDefinition[]): Promise<Completion> => {
      turn1Tools = tools.map((tool) => tool.function.name);
      return { content: '好的。', finishReason: 'stop', calls: [] };
    },
  } as unknown as ModelClient;

  const harness = new Harness(store, {} as VmController, model, () => {});
  t.after(() => harness.disposeTools());
  await harness.run(botId, '再检查一遍');
  assert.equal(store.data.runs[0].status, 'completed');
  assert.ok(turn1Tools.includes('checkpoint_list'), 'history-referenced deferred tool stays active');
  assert.ok(!turn1Tools.includes('checkpoint_restore'), 'uncalled sibling deferred tool stays omitted');
  assertCanonicalOrder(
    turn1Tools,
    TOOLS.map((tool) => tool.function.name),
  );
});

test('small-context (< 32k) compact mode stays unchanged and does not expand modelTools after tool_search', async (t) => {
  const dir = tempDir(t, 'aelion-deferred-compact-');
  const store = new Store(dir);
  t.after(() => store.close());
  store.data.model.model = 'fixture';
  store.data.model.contextTokens = 8000;

  const offeredPerTurn: string[][] = [];
  let turn = 0;
  const model = {
    complete: async (messages: WireMessage[], tools: ToolDefinition[]): Promise<Completion> => {
      offeredPerTurn.push(tools.map((tool) => tool.function.name));
      turn++;
      if (turn === 1) {
        assert.ok(offeredPerTurn[0].every((name) => COMPACT_TOOLS.has(name)));
        assert.ok(!offeredPerTurn[0].includes('checkpoint_list'));
        return {
          content: '',
          finishReason: 'tool_calls',
          calls: [call('tool_search', { query: 'checkpoint_list', includeMcp: false })],
        };
      }
      const payload = JSON.parse(messages.filter((m) => m.role === 'tool').at(-1)!.content!).result;
      assert.deepEqual(payload.activated, []);
      assert.deepEqual(offeredPerTurn[1], offeredPerTurn[0], 'compact mode modelTools stays strictly bounded');
      return { content: '已查到工具说明。', finishReason: 'stop', calls: [] };
    },
  } as unknown as ModelClient;

  const harness = new Harness(store, {} as VmController, model, () => {});
  t.after(() => harness.disposeTools());
  await harness.run(store.data.bots[0].id, '查一下检查点工具');
  assert.equal(store.data.runs[0].status, 'completed');
  assert.equal(turn, 2);
});

test('selectModelTools contextual rules and discoverTools keyword matching work accurately', async () => {
  const available = TOOLS;
  const scheduled = selectModelTools(available, {
    contextTokens: 64000,
    privateSession: false,
    groupOrigin: false,
    planning: false,
    designBound: false,
    scheduledRun: true,
    hasInitialWork: false,
  }).map((t) => t.function.name);
  assert.ok(scheduled.includes('automation_create'));
  assert.ok(!scheduled.includes('checkpoint_list'));

  const withWork = selectModelTools(available, {
    contextTokens: 64000,
    privateSession: false,
    groupOrigin: false,
    planning: false,
    designBound: false,
    scheduledRun: false,
    hasInitialWork: true,
  }).map((t) => t.function.name);
  assert.ok(withWork.includes('task_read') && withWork.includes('task_update') && withWork.includes('goal_read'));
  assert.ok(!withWork.includes('automation_create'));

  const designBound = selectModelTools(available, {
    contextTokens: 64000,
    privateSession: false,
    groupOrigin: false,
    planning: false,
    designBound: true,
    scheduledRun: false,
    hasInitialWork: false,
  }).map((t) => t.function.name);
  assert.ok(designBound.includes('design_file_create') && designBound.includes('design_publish'));

  const planning = selectModelTools(available.slice(0, 5), {
    contextTokens: 64000,
    privateSession: false,
    groupOrigin: false,
    planning: true,
    designBound: false,
    scheduledRun: false,
    hasInitialWork: false,
  });
  assert.equal(planning.length, 5);

  assert.deepEqual(
    [
      ...extractHistoryToolNames([
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: '1', type: 'function', function: { name: 'skill_save', arguments: '{}' } }],
        },
      ]),
    ],
    ['skill_save'],
  );

  // Chinese unspaced capability query matches deferred built-in tools cleanly.
  const zhResult = await discoverTools(
    { query: '定时任务', includeMcp: false },
    TOOLS,
    undefined,
    new AbortController().signal,
  );
  assert.ok(
    zhResult.tools.some((item) => item.name === 'automation_create'),
    'Chinese query "定时任务" finds automation_create',
  );

  // includeMcp: false excludes native mcp__* tools present in definitions.
  const fakeMcpDef: ToolDefinition = {
    type: 'function',
    function: { name: 'mcp__demo__ping', description: 'Ping demo service', parameters: { type: 'object' } },
  };
  const noMcp = await discoverTools(
    { query: 'ping', includeMcp: false },
    [...TOOLS, fakeMcpDef],
    undefined,
    new AbortController().signal,
  );
  assert.ok(!noMcp.tools.some((item) => item.name.includes('ping') && item.source === 'mcp'));
  assert.ok(CORE_ACTIVE_TOOLS.has('tool_search'));
  assert.ok(CORE_ACTIVE_TOOLS.has('widgets_list') && CORE_ACTIVE_TOOLS.has('widget_save'));

  const teaching = selectModelTools(available, {
    contextTokens: 64000,
    privateSession: false,
    groupOrigin: false,
    planning: false,
    designBound: false,
    scheduledRun: false,
    teachingRun: true,
    hasInitialWork: false,
  }).map((t) => t.function.name);
  assert.ok(
    teaching.includes('skill_save') && teaching.includes('skill_patch') && teaching.includes('skill_file_write'),
    'teachingRun activates skill authoring tools on turn 1',
  );
  assert.ok(!teaching.includes('checkpoint_list'), 'unrelated deferred tools stay omitted in teachingRun');
});

test('Teach-by-Showing prompt auto-activates skill_save on turn 1 inside Harness', async (t) => {
  const dir = tempDir(t, 'aelion-deferred-teaching-');
  const store = new Store(dir);
  t.after(() => store.close());
  store.data.model.model = 'fixture';
  store.data.model.contextTokens = 64000;

  const teachingPrompt = formatTeachingPrompt({
    target: 'host',
    durationMs: 12_000,
    title: 'export-report',
    steps: [{ id: 's1', atMs: 1000, clock: '0:01', kind: 'click', target: 'host', summary: '点击导出按钮' }],
    narration: [{ startMs: 0, endMs: 2000, clock: '0:00', text: '点击这里导出报表' }],
    attachments: [],
  });
  assert.ok(isTeachingPrompt(teachingPrompt));
  assert.ok(!isTeachingPrompt('普通对话消息'));

  let turn1Tools: string[] = [];
  const model = {
    complete: async (_messages: WireMessage[], tools: ToolDefinition[]): Promise<Completion> => {
      turn1Tools = tools.map((tool) => tool.function.name);
      return { content: '已收到演示。', finishReason: 'stop', calls: [] };
    },
  } as unknown as ModelClient;

  const paths = {
    homeDir: join(dir, 'home'),
    projectDir: join(dir, 'project'),
    dataDir: dir,
    configDir: join(dir, 'aelion'),
    env: {},
  };
  for (const path of Object.values(paths)) if (typeof path === 'string') mkdirSync(path, { recursive: true });
  const integrations = new Integrations(store, paths, () => {});
  t.after(() => integrations.close());
  const harness = new Harness(store, {} as VmController, model, () => {}, undefined, undefined, integrations);
  t.after(() => harness.disposeTools());
  await harness.run(store.data.bots[0].id, teachingPrompt);

  assert.equal(store.data.runs[0].status, 'completed');
  assert.ok(turn1Tools.includes('skill_save'), 'skill_save is offered on turn 1 for Teach-by-Showing runs');
  assert.ok(turn1Tools.includes('skill_patch'), 'skill_patch is offered on turn 1 for Teach-by-Showing runs');
  assert.ok(turn1Tools.includes('skill_file_write'), 'skill_file_write is offered on turn 1 for Teach-by-Showing runs');
  assert.ok(turn1Tools.includes('widgets_list') && turn1Tools.includes('widget_save'), 'widget tools are offered');
  assert.ok(!turn1Tools.includes('checkpoint_list'), 'unrelated deferred tools stay omitted');
});
