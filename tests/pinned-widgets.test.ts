import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../electron/core/storage/store';
import { PinnedWidgets } from '../electron/core/preview/pinned-widgets';
import { GroupChats } from '../electron/core/group/group-chats';
import { Harness, TOOLS } from '../electron/core/agent/harness';
import type { ModelClient, Completion, ToolDefinition } from '../electron/core/model/model';
import type { VmController } from '../electron/core/vm/vm';
import type { WireMessage } from '../shared/types/core';
import {
  WIDGET_DEFAULT_TITLE,
  WIDGET_MAX_HTML_BYTES,
  WIDGET_MAX_PER_SCOPE,
  WIDGET_MAX_STATE_BYTES,
  extractWidgetTitle,
  widgetScopeKey,
} from '../shared/types/widget-types';
import { tempDir } from './helpers';

function makeStore(t: test.TestContext) {
  const dir = tempDir(t);
  const store = new Store(dir);
  const bot = store.data.bots[0];
  let changes = 0;
  const widgets = new PinnedWidgets(store, () => changes++);
  return { dir, store, bot, widgets, getChanges: () => changes };
}

test('extractWidgetTitle prioritizes HTML comment, title tag, heading, then fallback', () => {
  assert.equal(extractWidgetTitle('<!-- title: 待办清单 --><h1>Ignored</h1>'), '待办清单');
  assert.equal(extractWidgetTitle('<title> 参数 &amp; 配置 </title><h1>Heading</h1>'), '参数 & 配置');
  assert.equal(extractWidgetTitle('<div><h2><span>进度</span> 看板</h2></div>'), '进度 看板');
  assert.equal(extractWidgetTitle('<div>plain text only</div>'), WIDGET_DEFAULT_TITLE);
  assert.equal(extractWidgetTitle(`<!-- title: ${'A'.repeat(120)} -->`).length, 80);
});

test('PinnedWidgets CRUD, deduplication, state updates, and persistence across reload', (t) => {
  const { dir, bot, widgets } = makeStore(t);
  const scope = { kind: 'bot' as const, id: bot.id };

  const created = widgets.pin({
    scope,
    html: '<!-- title: Checklist --><div>Items</div>',
    state: { done: ['a'] },
    sourceMessageId: 'msg-1',
    sourceIndex: 0,
  });
  assert.equal(created.title, 'Checklist');
  assert.deepEqual(created.state, { done: ['a'] });
  assert.equal(widgets.list(scope).length, 1);

  // Re-pinning the same message slot updates rather than duplicating.
  const deduped = widgets.pin({
    scope,
    html: '<!-- title: Checklist --><div>Items v2</div>',
    state: { done: ['a', 'b'] },
    sourceMessageId: 'msg-1',
    sourceIndex: 0,
  });
  assert.equal(deduped.id, created.id);
  assert.equal(widgets.list(scope).length, 1);
  assert.deepEqual(deduped.state, { done: ['a', 'b'] });

  // A different fence index in the same message creates a second widget.
  const second = widgets.pin({
    scope,
    html: '<h1>Timer</h1>',
    sourceMessageId: 'msg-1',
    sourceIndex: 1,
  });
  assert.notEqual(second.id, created.id);
  assert.equal(second.title, 'Timer');
  assert.equal(widgets.list(scope).length, 2);

  // Rename + mergeState + resetState.
  const merged = widgets.update({
    id: created.id,
    title: 'Release Checklist',
    state: { note: 'v1' },
    mergeState: true,
  });
  assert.equal(merged.title, 'Release Checklist');
  assert.deepEqual(merged.state, { done: ['a', 'b'], note: 'v1' });

  const replaced = widgets.update({ id: created.id, state: { count: 3 } });
  assert.deepEqual(replaced.state, { count: 3 });

  const reset = widgets.update({ id: created.id, resetState: true });
  assert.deepEqual(reset.state, {});

  // Reload from disk preserves widgets.
  const reopened = new Store(dir);
  assert.equal(reopened.data.pinnedWidgets?.length, 2);
  assert.equal(reopened.data.pinnedWidgets?.find((w) => w.id === created.id)?.title, 'Release Checklist');

  // Unpin removes entry and rejects unknown id.
  widgets.unpin(second.id);
  assert.equal(widgets.list(scope).length, 1);
  assert.throws(() => widgets.unpin(second.id), { code: 'widget.not_found' });
});

test('PinnedWidgets persists properly with incremental SQLite store', (t) => {
  const dir = tempDir(t);
  const first = new Store(dir, { incremental: true });
  let createdId = '';
  try {
    const bot = first.data.bots[0];
    const service = new PinnedWidgets(first, () => {});
    const created = service.pin({
      scope: { kind: 'bot', id: bot.id },
      html: '<h1>SQLite Widget</h1>',
      state: { step: 1 },
    });
    createdId = created.id;
    service.update({ id: created.id, state: { step: 2 } });
  } finally {
    first.close();
  }

  const second = new Store(dir, { incremental: true });
  try {
    assert.equal(second.data.pinnedWidgets?.length, 1);
    assert.equal(second.data.pinnedWidgets?.[0].id, createdId);
    assert.deepEqual(second.data.pinnedWidgets?.[0].state, { step: 2 });
  } finally {
    second.close();
  }
});

test('PinnedWidgets enforces 64 KB HTML/state bounds, title rules, and per-scope limit', (t) => {
  const { store, bot, widgets } = makeStore(t);
  const scope = { kind: 'bot' as const, id: bot.id };
  const otherBot = store.createBot('Other', 'Helper');
  const otherScope = { kind: 'bot' as const, id: otherBot.id };

  assert.throws(() => widgets.pin({ scope, html: '   ' }), { code: 'widget.html_invalid' });
  assert.throws(() => widgets.pin({ scope, html: 'x'.repeat(WIDGET_MAX_HTML_BYTES + 1) }), {
    code: 'widget.html_too_large',
  });
  // Multi-byte UTF-8 check: 3 bytes per char -> > 64 KB even though char length < 64k.
  assert.throws(() => widgets.pin({ scope, html: '中'.repeat(Math.ceil(WIDGET_MAX_HTML_BYTES / 3) + 1) }), {
    code: 'widget.html_too_large',
  });

  assert.throws(() => widgets.pin({ scope, html: '<div>ok</div>', state: [] as unknown as Record<string, unknown> }), {
    code: 'widget.state_invalid',
  });
  assert.throws(
    () => widgets.pin({ scope, html: '<div>ok</div>', state: { big: 'a'.repeat(WIDGET_MAX_STATE_BYTES) } }),
    { code: 'widget.state_too_large' },
  );
  assert.throws(() => widgets.pin({ scope, html: '<div>ok</div>', title: '   ' }), { code: 'widget.title_invalid' });
  assert.throws(() => widgets.pin({ scope, html: '<div>ok</div>', title: 't'.repeat(81) }), {
    code: 'widget.title_invalid',
  });
  assert.throws(() => widgets.pin({ scope: { kind: 'bot', id: 'missing-bot' }, html: '<div>ok</div>' }), {
    code: 'widget.scope_invalid',
  });

  for (let i = 0; i < WIDGET_MAX_PER_SCOPE; i++) {
    widgets.pin({ scope, html: `<div>#${i}</div>`, title: `W${i}` });
  }
  assert.throws(() => widgets.pin({ scope, html: '<div>overflow</div>' }), { code: 'widget.limit_exceeded' });
  // Another scope is unaffected by the first scope's limit.
  const inOther = widgets.pin({ scope: otherScope, html: '<div>other</div>', title: 'Other' });
  assert.equal(widgets.list(otherScope).length, 1);
  // Cross-scope update restriction rejects mismatched scope.
  assert.throws(() => widgets.update({ id: inOther.id, title: 'Hijack' }, scope), { code: 'widget.not_found' });
});

test('scope isolation and cascade cleanup on work session, bot, and group delete', (t) => {
  const { store, bot, widgets } = makeStore(t);
  const bot2 = store.createBot('Bot2', 'Second');
  const session = {
    id: randomUUID(),
    botId: bot.id,
    name: 'Release',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.data.workSessions ||= [];
  store.data.workSessions.push(session);
  store.save();

  const groupChats = new GroupChats(store, {} as unknown as Harness, () => {});
  try {
    const group = groupChats.create({ name: 'Team', botIds: [bot.id, bot2.id] });

    const mainScope = { kind: 'bot' as const, id: bot.id };
    const sessionScope = { kind: 'bot' as const, id: bot.id, sessionId: session.id };
    const bot2Scope = { kind: 'bot' as const, id: bot2.id };
    const groupScope = { kind: 'group' as const, id: group.id };

    assert.notEqual(widgetScopeKey(mainScope), widgetScopeKey(sessionScope));
    assert.notEqual(widgetScopeKey(mainScope), widgetScopeKey(groupScope));

    widgets.pin({ scope: mainScope, title: 'Main', html: '<div>main</div>' });
    widgets.pin({ scope: sessionScope, title: 'Session', html: '<div>session</div>' });
    widgets.pin({ scope: bot2Scope, title: 'Bot2', html: '<div>bot2</div>' });
    widgets.pin({ scope: groupScope, title: 'Group', html: '<div>group</div>' });

    assert.equal(widgets.list(mainScope).length, 1);
    assert.equal(widgets.list(sessionScope).length, 1);
    assert.equal(widgets.list(bot2Scope).length, 1);
    assert.equal(widgets.list(groupScope).length, 1);

    // Deleting work session removes only that session's widgets.
    store.deleteWorkSession(session.id);
    assert.equal(widgets.list(sessionScope).length, 0);
    assert.equal(widgets.list(mainScope).length, 1);
    assert.equal(widgets.list(groupScope).length, 1);

    // Deleting group removes only group's widgets.
    groupChats.delete(group.id);
    assert.equal(widgets.list(groupScope).length, 0);
    assert.equal(widgets.list(mainScope).length, 1);
    assert.equal(widgets.list(bot2Scope).length, 1);

    // Deleting bot removes bot's main and work-session widgets while preserving other bots.
    const session2 = {
      id: randomUUID(),
      botId: bot.id,
      name: 'Draft',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.data.workSessions.push(session2);
    widgets.pin({ scope: { kind: 'bot', id: bot.id, sessionId: session2.id }, title: 'S2', html: '<div>s2</div>' });
    store.deleteBot(bot.id);
    assert.equal(widgets.list().length, 1);
    assert.equal(widgets.list(bot2Scope).length, 1);
  } finally {
    groupChats.dispose();
  }
});

test('widget tools are appended at the end of TOOLS (before Vault and Video Studio tools) and execute through Harness', async (t) => {
  const names = TOOLS.map((tool) => tool.function.name);
  assert.deepEqual(names.slice(-12), [
    'widgets_list',
    'widget_save',
    'vault_list',
    'vault_save',
    'vault_request',
    'video_project_create',
    'video_project_inspect',
    'video_asset_import',
    'video_edit',
    'video_preview_frame',
    'video_export',
    'video_export_status',
  ]);

  const { store, bot, widgets } = makeStore(t);
  store.data.model.model = 'fixture';
  store.data.model.contextTokens = 64000;

  let turn = 0;
  let savedId = '';
  let listedState: unknown;
  let offeredInteractive: string[] = [];

  const model = {
    complete: async (messages: WireMessage[], tools: ToolDefinition[]): Promise<Completion> => {
      turn++;
      if (turn === 1) {
        offeredInteractive = tools.map((item) => item.function.name);
        return {
          content: '',
          calls: [
            {
              id: randomUUID(),
              type: 'function',
              function: {
                name: 'widget_save',
                arguments: JSON.stringify({
                  title: 'Launch Checklist',
                  html: '<!-- title: Launch --><div>Checklist</div>',
                  state: { items: [{ text: 'Tests', done: false }] },
                }),
              },
            },
          ],
          finishReason: 'tool_calls',
        };
      }
      if (turn === 2) {
        const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
        const raw = JSON.parse(lastTool?.content || '{}');
        const payload = raw.result ?? raw;
        savedId = payload.id;
        // Simulate the user checking the item in the widget UI before the next tool call.
        widgets.update({ id: savedId, state: { items: [{ text: 'Tests', done: true }] } });
        return {
          content: '',
          calls: [
            {
              id: randomUUID(),
              type: 'function',
              function: { name: 'widgets_list', arguments: '{}' },
            },
          ],
          finishReason: 'tool_calls',
        };
      }
      if (turn === 3) {
        const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
        const raw = JSON.parse(lastTool?.content || '{}');
        const payload = raw.result ?? raw;
        listedState = payload.widgets?.[0]?.state;
        return {
          content: '',
          calls: [
            {
              id: randomUUID(),
              type: 'function',
              function: {
                name: 'widget_save',
                arguments: JSON.stringify({
                  id: savedId,
                  state: { verified: true },
                  mergeState: true,
                }),
              },
            },
          ],
          finishReason: 'tool_calls',
        };
      }
      return { content: 'Checklist updated.', calls: [], finishReason: 'stop' };
    },
  } as unknown as ModelClient;

  const harness = new Harness(store, { state: { status: 'stopped' } } as VmController, model, () => {});
  harness.setPinnedWidgets(widgets);
  t.after(() => harness.disposeTools());

  await harness.run(bot.id, 'Create and verify my checklist');
  assert.ok(offeredInteractive.includes('widgets_list'));
  assert.ok(offeredInteractive.includes('widget_save'));
  assert.deepEqual(listedState, { items: [{ text: 'Tests', done: true }] });
  const stored = widgets.list({ kind: 'bot', id: bot.id });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, savedId);
  assert.deepEqual(stored[0].state, { items: [{ text: 'Tests', done: true }], verified: true });
});

test('group runs receive richReplies and widget tools, while headless and peer_request hide them', async (t) => {
  const { store, bot, widgets } = makeStore(t);
  store.data.model.model = 'fixture';
  store.data.model.contextTokens = 64000;
  const bot2 = store.createBot('Peer', 'Peer bot');
  const groupChats = new GroupChats(store, {} as unknown as Harness, () => {});
  try {
    const group = groupChats.create({ name: 'Design Squad', botIds: [bot.id, bot2.id] });

    let systemText = '';
    let offeredTools: string[] = [];
    const captureModel = {
      complete: async (messages: WireMessage[], tools: ToolDefinition[]): Promise<Completion> => {
        systemText = messages.find((m) => m.role === 'system')?.content || '';
        offeredTools = tools.map((item) => item.function.name);
        return { content: 'Done', calls: [], finishReason: 'stop' };
      },
    } as unknown as ModelClient;

    // 1. Interactive group run gets richReplies + widgets_list/widget_save and saves into group scope.
    let groupTurn = 0;
    const groupModel = {
      complete: async (messages: WireMessage[], tools: ToolDefinition[]): Promise<Completion> => {
        groupTurn++;
        if (groupTurn === 1) {
          systemText = messages.find((m) => m.role === 'system')?.content || '';
          offeredTools = tools.map((item) => item.function.name);
          return {
            content: '',
            calls: [
              {
                id: randomUUID(),
                type: 'function',
                function: {
                  name: 'widget_save',
                  arguments: JSON.stringify({
                    title: 'Group Poll',
                    html: '<div>Poll</div>',
                    state: { votes: 0 },
                  }),
                },
              },
            ],
            finishReason: 'tool_calls',
          };
        }
        return { content: 'Done', calls: [], finishReason: 'stop' };
      },
    } as unknown as ModelClient;
    const groupHarness = new Harness(store, { state: { status: 'stopped' } } as VmController, groupModel, () => {});
    groupHarness.setPinnedWidgets(widgets);
    try {
      await groupHarness.run(bot.id, 'Build a group poll', {
        groupOrigin: { groupId: group.id, rootId: randomUUID(), deliveryId: randomUUID() },
        groupContext: 'Group context',
      });
    } finally {
      groupHarness.disposeTools();
    }
    assert.ok(systemText.includes('```widget'), 'interactive group prompt should include widget fence guidance');
    assert.ok(offeredTools.includes('widgets_list'));
    assert.ok(offeredTools.includes('widget_save'));
    assert.equal(widgets.list({ kind: 'group', id: group.id }).length, 1);
    assert.equal(widgets.list({ kind: 'bot', id: bot.id }).length, 0);

    // 2. Headless run hides widget tools and richReplies.
    const headlessHarness = new Harness(
      store,
      { state: { status: 'stopped' } } as VmController,
      captureModel,
      () => {},
    );
    headlessHarness.setPinnedWidgets(widgets);
    headlessHarness.setHeadless(true);
    try {
      await headlessHarness.run(bot.id, 'Headless check');
    } finally {
      headlessHarness.disposeTools();
    }
    assert.ok(!systemText.includes('```widget'));
    assert.ok(!offeredTools.includes('widgets_list'));
    assert.ok(!offeredTools.includes('widget_save'));

    // 3. Private peer_request run hides widget tools and richReplies.
    const peerHarness = new Harness(store, { state: { status: 'stopped' } } as VmController, captureModel, () => {});
    peerHarness.setPinnedWidgets(widgets);
    try {
      await peerHarness.run(bot.id, 'Peer question', {
        peerOrigin: { kind: 'peer_request', exchangeId: randomUUID(), sessionId: 'peer-sess-1' },
        privateSessionId: 'peer-sess-1',
        peerContext: 'Private peer context',
      });
    } finally {
      peerHarness.disposeTools();
    }
    assert.ok(!systemText.includes('```widget'));
    assert.ok(!offeredTools.includes('widgets_list'));
    assert.ok(!offeredTools.includes('widget_save'));
  } finally {
    groupChats.dispose();
  }
});
