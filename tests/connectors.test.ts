import test from 'node:test';
import { Readable } from 'node:stream';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { delay, answer, settle, tempDir, until } from './helpers';
import { Store } from '../electron/core/storage/store';
import { Harness } from '../electron/core/agent/harness';
import { ChatPinQueue } from '../electron/core/agent/chat-pins';
import { Interactions } from '../electron/core/agent/interactions';
import { Attachments } from '../electron/core/attachments/attachments';
import { Connectors, type ConnectorDeps } from '../electron/core/connectors/connector-hub';
import type {
  AdapterHandlers,
  ConnectorAdapter,
  ConnectorCard,
  ConnectorTextStream,
  InboundMessage,
} from '../electron/core/connectors/connector-adapter';
import { WecomAdapter, decryptWecomFile } from '../electron/core/connectors/adapters/wecom';
import { WeixinAdapter } from '../electron/core/connectors/adapters/weixin';
import {
  FeishuAdapter,
  feishuCard,
  feishuMarkdownCard,
  type LarkSdk,
} from '../electron/core/connectors/adapters/feishu';
import { connectorStreamingText, connectorText, plainText, splitText } from '../electron/core/connectors/format';
import { chatInputText } from '../electron/core/agent/chat-input';
import type { ModelClient } from '../electron/core/model/model';
import type { VmController } from '../electron/core/vm/vm';
import type { HostPermissionMode } from '../shared/types/permission-types';

const codec = {
  encrypt: (value: string) => Buffer.from(value).toString('base64'),
  decrypt: (value: string) => Buffer.from(value, 'base64').toString('utf8'),
};

/** Records what the hub sends and lets a test deliver messages and button presses. */
class FakeAdapter implements ConnectorAdapter {
  handlers?: AdapterHandlers;
  texts: Array<{ chatId: string; text: string }> = [];
  files: Array<{ chatId: string; name: string }> = [];
  cards: Array<{ chatId: string; card: ConnectorCard }> = [];
  closed: Array<{ handle: string; result: string }> = [];
  cues: Array<{ chatId: string; active: boolean }> = [];
  constructor(readonly platform: 'feishu' | 'wecom' | 'weixin' = 'feishu') {}
  start(handlers: AdapterHandlers) {
    this.handlers = handlers;
    handlers.status('connected');
  }
  async stop() {}
  async sendText(chatId: string, text: string) {
    this.texts.push({ chatId, text });
  }
  async sendFile(chatId: string, file: { name: string; bytes: Buffer }) {
    this.files.push({ chatId, name: file.name });
  }
  async typing(chatId: string, active: boolean) {
    this.cues.push({ chatId, active });
  }
  async sendCard(chatId: string, card: ConnectorCard) {
    this.cards.push({ chatId, card });
    return 'card-' + this.cards.length;
  }
  async closeCard(handle: string, _card: ConnectorCard, result: string) {
    this.closed.push({ handle, result });
  }
  receive(message: Partial<InboundMessage> & { text: string }) {
    this.handlers!.message({
      messageId: 'm-' + Math.random().toString(36).slice(2),
      chatId: 'chat-owner',
      isGroup: false,
      sender: { id: 'owner', name: '小周' },
      resources: [],
      sentAt: Date.now(),
      ...message,
    });
  }
}

function fixture(t: test.TestContext, overrides: Partial<ConnectorDeps> = {}) {
  const dir = tempDir(t),
    store = new Store(dir),
    bot = store.data.bots[0],
    adapter = new FakeAdapter(),
    sent: Array<Parameters<ConnectorDeps['send']>[0]> = [],
    modes: Array<{ sessionId: string; mode: HostPermissionMode }> = [],
    interactions = new Interactions(() => connectors.interactionsChanged());
  store.data.model.model = 'fixture';
  const connectors: Connectors = new Connectors({
    store,
    dataDir: dir,
    codec,
    version: '0.0.0-test',
    attachments: new Attachments(store),
    send: (input) => void sent.push(input),
    cancel: () => {},
    isRunning: () => false,
    setPermission: (_botId, sessionId, mode) => void modes.push({ sessionId, mode }),
    interactions,
    changed: () => {},
    lark: () => {
      throw new Error('no SDK in tests');
    },
    createAdapter: () => adapter,
    ...overrides,
  });
  t.after(() => connectors.dispose());
  return { dir, store, bot, adapter, connectors, sent, modes, interactions };
}

test('text helpers split at line ends within a byte limit and flatten Markdown for WeChat', () => {
  const parts = splitText('第一段内容\n\n第二段内容比较长一些\n第三行', 30, true);
  assert.ok(parts.every((part) => Buffer.byteLength(part) <= 30));
  assert.equal(parts.join(''), '第一段内容第二段内容比较长一些第三行');
  assert.equal(
    plainText('# 标题\n**加粗** 和 `代码`\n- 项目\n[链接](https://example.com)'),
    '标题\n加粗 和 代码\n• 项目\n链接（https://example.com）',
  );
});

test('a manual connector pairs its first sender as owner, then routes their messages to a work session', async (t) => {
  const { store, bot, adapter, connectors, sent, modes } = fixture(t);
  const id = connectors.add({
    botId: bot.id,
    permissionMode: 'ask',
    credentials: { platform: 'wecom', botId: 'bot-1', secret: 'secret-1' },
  });
  assert.throws(
    () =>
      connectors.add({
        botId: bot.id,
        permissionMode: 'ask',
        credentials: { platform: 'wecom', botId: 'bot-1', secret: 'other' },
      }),
    { code: 'connector.duplicate' },
  );
  adapter.receive({ text: '你好' });
  await until(() => adapter.texts.length === 1);
  const code = /配对码：(\d{6})/.exec(adapter.texts[0].text)?.[1];
  assert.ok(code, adapter.texts[0].text);
  assert.equal(sent.length, 0);
  // A second message before confirmation asks nothing new and still reaches nobody.
  adapter.receive({ text: '在吗' });
  await settle();
  assert.equal(adapter.texts.length, 1);

  await connectors.decidePairing({ id, code: code!, allow: true });
  assert.equal(connectors.snapshot().connectors[0].owner?.id, 'owner');
  assert.match(adapter.texts.at(-1)!.text, /现在可以直接给/);

  adapter.receive({ text: '帮我整理一下日程', messageId: 'same' });
  adapter.receive({ text: '帮我整理一下日程', messageId: 'same' });
  await until(() => sent.length === 1);
  await settle();
  assert.equal(sent.length, 1, 'a redelivered message is handled once');
  const session = store.data.workSessions!.find((item) => item.id === sent[0].sessionId)!;
  assert.equal(session.botId, bot.id);
  assert.deepEqual(session.connector, {
    connectorId: id,
    platform: 'wecom',
    chatId: 'chat-owner',
    peer: { id: 'owner', name: '小周' },
  });
  assert.deepEqual(modes, [{ sessionId: session.id, mode: 'ask' }]);

  // The owner can talk to the Bot in a group; the session is tied to the group chat, while approvals stay private.
  adapter.receive({ text: '群里问一句', isGroup: true, chatId: 'group-1' });
  await until(() => sent.length === 2);
  const groupSession = store.data.workSessions!.find((item) => item.id === sent[1].sessionId)!;
  assert.equal(groupSession.name, '企业微信 · 群聊');
  assert.deepEqual(groupSession.connector, {
    connectorId: id,
    platform: 'wecom',
    chatId: 'group-1',
    peer: { id: 'owner', name: '小周' },
  });
  assert.equal(sent[1].message, '群里问一句');
  assert.equal(
    connectors.saved.data.connectors[0].owner?.chatId,
    'chat-owner',
    'a group message does not move approvals into the group',
  );

  // Any group member WeCom lets through reaches the same group session; private strangers still need pairing.
  adapter.receive({ text: '群友问一句', isGroup: true, chatId: 'group-1', sender: { id: 'guest' } });
  await until(() => sent.length === 3);
  assert.equal(sent[2].sessionId, groupSession.id);
  assert.equal(sent[2].message, '群友问一句');
  assert.equal(connectors.snapshot().connectors[0].pairings.length, 0);
  adapter.receive({ text: '我是陌生人', chatId: 'chat-x', sender: { id: 'stranger' } });
  await until(() => connectors.snapshot().connectors[0].pairings.length === 1);
  assert.equal(sent.length, 3);
  assert.ok(adapter.texts.some((item) => item.chatId === 'chat-owner' && /请求使用/.test(item.text)));

  // /new archives the private session; the next message opens another one.
  adapter.receive({ text: '/new' });
  await until(() => Boolean(session.archivedAt));
  adapter.receive({ text: '新的事情' });
  await until(() => sent.length === 4);
  assert.notEqual(sent[3].sessionId, session.id);

  connectors.update({ id, permissionMode: 'full' });
  assert.deepEqual(
    modes.slice(-2).map((item) => item.mode),
    ['full', 'full'],
  );
  await connectors.remove(id);
  assert.equal(session.connector, undefined, 'removing a connector leaves its sessions as ordinary ones');
});

test('several WeCom bots connect side by side, each answering as its own Bot', async (t) => {
  const adapters = new Map<string, FakeAdapter>();
  const { store, bot, connectors, sent } = fixture(t, {
    createAdapter: (connector) => {
      const adapter = new FakeAdapter('wecom');
      adapters.set(connector.account, adapter);
      return adapter;
    },
  });
  const other = store.createBot('设计师', '做设计');
  const first = connectors.add({
    botId: bot.id,
    permissionMode: 'ask',
    credentials: { platform: 'wecom', botId: 'bot-a', secret: 'secret-a' },
  });
  const second = connectors.add({
    botId: other.id,
    permissionMode: 'full',
    credentials: { platform: 'wecom', botId: 'bot-b', secret: 'secret-b' },
  });
  assert.deepEqual(
    connectors.snapshot().connectors.map((item) => [item.account, item.botId, item.status]),
    [
      ['bot-a', bot.id, 'connected'],
      ['bot-b', other.id, 'connected'],
    ],
  );
  const a = adapters.get('bot-a')!,
    b = adapters.get('bot-b')!;

  // Each bot pairs on its own: being let in through one does not open the other.
  a.receive({ text: '你好' });
  await until(() => a.texts.length === 1);
  await connectors.decidePairing({ id: first, code: /配对码：(\d{6})/.exec(a.texts[0].text)![1], allow: true });
  b.receive({ text: '你好' });
  await until(() => b.texts.length === 1);
  assert.match(b.texts[0].text, /配对码/);
  assert.equal(sent.length, 0);
  await connectors.decidePairing({ id: second, code: /配对码：(\d{6})/.exec(b.texts[0].text)![1], allow: true });

  a.receive({ text: '写周报' });
  b.receive({ text: '画个图标' });
  await until(() => sent.length === 2);
  const routed = Object.fromEntries(
    sent.map((input) => {
      const session = store.data.workSessions!.find((item) => item.id === input.sessionId)!;
      return [input.message, [session.botId, session.connector?.connectorId, input.connector.connectorId]];
    }),
  );
  assert.deepEqual(routed, { 写周报: [bot.id, first, first], 画个图标: [other.id, second, second] });

  // Commands answer through the bot they came in on, about that bot's Bot.
  b.receive({ text: '/status' });
  await until(() => b.texts.some((item) => item.text.startsWith('设计师：')));
  assert.ok(!a.texts.some((item) => item.text.includes('设计师')));

  // Switching one off leaves the other running.
  connectors.update({ id: second, enabled: false });
  b.receive({ text: '还在吗' });
  a.receive({ text: '还在' });
  await until(() => sent.length === 3);
  await settle();
  assert.equal(sent.length, 3);
  assert.equal(sent[2].message, '还在');
});

test('group messages only reach the Bot on WeCom, which pushes them for @mentions', async (t) => {
  const { bot, adapter, connectors, sent } = fixture(t);
  const id = connectors.add({
    botId: bot.id,
    permissionMode: 'ask',
    credentials: { platform: 'feishu', appId: 'cli_1', appSecret: 'test-secret' },
  });
  connectors.saved.get(id)!.owner = { id: 'owner', chatId: 'chat-owner' };
  adapter.receive({ text: '群里说一句', isGroup: true, chatId: 'group-1' });
  await settle();
  assert.equal(sent.length, 0);
  assert.equal(connectors.snapshot().connectors[0].lastMessageAt, undefined);
});

test('connector messages run the Bot and its answer goes back; desktop input in the session stays local', async (t) => {
  const dir = tempDir(t),
    store = new Store(dir),
    bot = store.data.bots[0],
    adapter = new FakeAdapter();
  store.data.model.model = 'fixture';
  let replies = 0;
  const requests: string[] = [];
  const model = {
    complete: async (...request: unknown[]) =>
      answer(
        (requests.push(JSON.stringify(request)), ++replies) === 1
          ? '日程已经整理好了。'
          : replies === 2
            ? '群里安排好了。'
            : replies === 3
              ? '群友的问题答好了。'
              : '桌面上的回答',
      ),
  } as unknown as ModelClient;
  const harness = new Harness(store, {} as VmController, model, () => {});
  let connectors: Connectors | undefined;
  const queue = new ChatPinQueue(
    store,
    {
      isRunning: (id, sessionId) => harness.isRunning(id, sessionId),
      run: (id, input, options) => connectors!.wrapRun(id, options, (wrapped) => harness.run(id, input, wrapped)),
    },
    () => {},
  );
  connectors = new Connectors({
    store,
    dataDir: dir,
    codec,
    version: 'test',
    attachments: new Attachments(store),
    send: ({ connector, ...input }) => queue.send(input, connector),
    cancel: () => {},
    isRunning: (botId, sessionId) => harness.isRunning(botId, sessionId),
    setPermission: () => {},
    interactions: new Interactions(() => {}),
    changed: () => queue.wake(),
    lark: () => ({}) as LarkSdk,
    createAdapter: () => adapter,
  });
  t.after(async () => {
    queue.dispose();
    await until(() => !harness.busy);
    await connectors!.dispose();
  });
  const id = connectors.add({
    botId: bot.id,
    permissionMode: 'auto',
    credentials: { platform: 'wecom', botId: 'bot-1', secret: 'test-secret' },
  });
  connectors.saved.get(id)!.owner = { id: 'owner' };
  store.data.userProfile = { displayName: '老板', role: '', background: '' };
  adapter.receive({ text: '整理日程' });
  await until(() => adapter.texts.length === 1);
  // Only the final answer is sent; while the Bot worked the chat showed the typing cue.
  assert.deepEqual(adapter.texts, [{ chatId: 'chat-owner', text: '日程已经整理好了。' }]);
  assert.deepEqual(adapter.cues.at(0), { chatId: 'chat-owner', active: true });
  assert.deepEqual(adapter.cues.at(-1), { chatId: 'chat-owner', active: false });
  const input = store.data.messages.find((message) => message.content === '整理日程')!;
  assert.equal(input.connector?.platform, 'wecom');
  assert.match(chatInputText(input), /^（这条消息来自企业微信，发送人：小周。/);
  assert.match(
    chatInputText({ ...input, connector: { ...input.connector!, isGroup: true } }),
    /^（这条消息来自企业微信群聊，发送人：小周。回复会发到群里/,
  );

  // A group message opens its own session and the final answer goes back to that group.
  adapter.receive({ text: '群里安排一下', isGroup: true, chatId: 'group-1' });
  await until(() => adapter.texts.length === 2);
  assert.deepEqual(adapter.texts[1], { chatId: 'group-1', text: '群里安排好了。' });
  const groupInput = store.data.messages.find((message) => message.content === '群里安排一下')!;
  assert.equal(groupInput.connector?.isGroup, true);
  assert.notEqual(groupInput.sessionId, input.sessionId);

  // Another group member gets an answer in the same group.
  adapter.receive({ text: '群友也问一句', isGroup: true, chatId: 'group-1', sender: { id: 'guest' } });
  await until(() => adapter.texts.length === 3);
  assert.deepEqual(adapter.texts[2], { chatId: 'group-1', text: '群友的问题答好了。' });
  // WeCom reports only an ID: that is what the model has for this person, in place of the owner's profile.
  const guestInput = store.data.messages.find((message) => message.content === '群友也问一句')!;
  assert.deepEqual(guestInput.connector?.sender, { id: 'guest' });
  assert.equal(guestInput.connector?.owner, false);
  assert.match(chatInputText(guestInput), /发送人：guest。/);
  assert.match(requests[2], /\\"displayName\\":\\"guest\\"/);
  assert.match(requests[2], /发送人：guest。.*群友也问一句/);
  assert.doesNotMatch(requests[2], /\\"displayName\\":\\"老板\\"/);
  // Earlier messages keep who really sent them: the owner's in the group stay the owner's.
  assert.match(requests[2], /\\"sender\\":\\"老板\\",\\"content\\":\\"群里安排一下/);
  assert.match(requests[2], /\\"sender\\":\\"guest\\",\\"content\\":\\"群友也问一句/);
  // The owner keeps the profile, in a private chat and in a group.
  assert.equal(groupInput.connector?.owner, true);
  assert.match(requests[0], /\\"displayName\\":\\"老板\\"/);
  assert.match(requests[1], /\\"displayName\\":\\"老板\\"/);

  // The same session, written from the app: the Bot answers in the app only.
  queue.send({ botId: bot.id, sessionId: input.sessionId, message: '桌面上问一句' });
  await until(() => replies === 4 && !harness.busy);
  await settle();
  assert.equal(adapter.texts.length, 3);
  // Written from the app, it is the owner again, whoever spoke before.
  assert.match(requests[3], /\\"displayName\\":\\"老板\\"/);
});

test('approvals of connector runs go to the owner as cards; only the owner decides', async (t) => {
  const { store, bot, adapter, connectors, interactions, sent } = fixture(t);
  const id = connectors.add({
    botId: bot.id,
    permissionMode: 'ask',
    credentials: { platform: 'feishu', appId: 'cli_2', appSecret: 's' },
  });
  connectors.saved.get(id)!.owner = { id: 'owner', chatId: 'chat-owner' };
  adapter.receive({ text: '运行一下测试' });
  await until(() => sent.length === 1);
  // Stand in for the chat queue: a run whose input is that connector message.
  const session = store.data.workSessions!.find((item) => item.connector?.connectorId === id)!;
  const message = store.message(bot.id, 'user', '运行一下测试', {
    sessionId: session.id,
    connector: { connectorId: id, platform: 'feishu', messageId: 'x', sender: { id: 'owner' } },
  });
  let finish!: () => void;
  const running = connectors.wrapRun(
    bot.id,
    { sessionId: session.id, inputMessageIds: [message.id] },
    async (options) => {
      options.onStarted?.('run-1');
      await new Promise<void>((resolve) => (finish = resolve));
    },
  );
  store.data.runs.push({
    id: 'run-1',
    botId: bot.id,
    sessionId: session.id,
    status: 'running',
    startedAt: new Date().toISOString(),
    modelCalls: 0,
    toolCalls: 0,
  });
  const controller = new AbortController();
  const permission = interactions.permission(
    bot.id,
    'run-1',
    { operation: 'command', command: 'pnpm test', reason: '运行测试' },
    controller.signal,
  );
  await until(() => adapter.cards.length === 1);
  const card = adapter.cards[0];
  assert.equal(card.chatId, 'chat-owner');
  assert.ok(card.card.lines.includes('命令：pnpm test'));
  const allow = card.card.buttons.find((button) => button.label === '允许一次')!;
  // Someone else pressing the button changes nothing.
  assert.equal(
    await adapter.handlers!.action({ chatId: 'chat-owner', operator: { id: 'stranger' }, key: allow.key }),
    undefined,
  );
  assert.equal(interactions.snapshot().length, 1);
  assert.equal(
    await adapter.handlers!.action({ chatId: 'chat-owner', operator: { id: 'owner' }, key: allow.key }),
    '已允许',
  );
  await permission;
  await until(() => adapter.closed.length === 1);

  // A text reply decides a request on platforms without cards.
  const denied = interactions.permission(
    bot.id,
    'run-1',
    { operation: 'delete_file', path: 'C:/work/a.txt', reason: '清理' },
    controller.signal,
  );
  await until(() => adapter.cards.length === 2);
  const code = adapter.cards[1].card.buttons[0].key.split(':')[1];
  adapter.receive({ text: `拒绝 ${code}` });
  await assert.rejects(denied, { code: 'permission.denied' });

  store.data.runs[0].status = 'completed';
  store.message(bot.id, 'assistant', '测试全部通过。', { runId: 'run-1', status: 'done', presentation: 'answer' });
  finish();
  await running;
  await until(() => adapter.texts.some((item) => item.text === '测试全部通过。'));

  // A run that is stopped sends nothing; a failed one sends a short note.
  for (const [status, error] of [
    ['cancelled', undefined],
    ['failed', '模型服务不可用'],
  ] as const) {
    const before = adapter.texts.length,
      runId = 'run-' + status;
    await connectors.wrapRun(bot.id, { sessionId: session.id, inputMessageIds: [message.id] }, async (options) => {
      options.onStarted?.(runId);
      store.data.runs.push({
        id: runId,
        botId: bot.id,
        sessionId: session.id,
        status,
        ...(error ? { error } : {}),
        startedAt: new Date().toISOString(),
        modelCalls: 0,
        toolCalls: 0,
      });
    });
    await settle();
    assert.deepEqual(
      adapter.texts.slice(before).map((item) => item.text),
      error ? ['这次没有完成：' + error] : [],
    );
  }
});

test('the owner allows or denies computer use of a connector run from the chat', async (t) => {
  const { store, bot, adapter, connectors, interactions, sent } = fixture(t);
  const id = connectors.add({
    botId: bot.id,
    permissionMode: 'ask',
    credentials: { platform: 'feishu', appId: 'cli_computer', appSecret: 'fixture-secret' },
  });
  connectors.saved.get(id)!.owner = { id: 'owner', chatId: 'chat-owner' };
  adapter.receive({ text: '帮我在电脑上打开设置' });
  await until(() => sent.length === 1);
  const session = store.data.workSessions!.find((item) => item.connector?.connectorId === id)!;
  const message = store.message(bot.id, 'user', '帮我在电脑上打开设置', {
    sessionId: session.id,
    connector: { connectorId: id, platform: 'feishu', messageId: 'y', sender: { id: 'owner' } },
  });
  let finish!: () => void;
  const running = connectors.wrapRun(
    bot.id,
    { sessionId: session.id, inputMessageIds: [message.id] },
    async (options) => {
      options.onStarted?.('run-computer');
      await new Promise<void>((resolve) => (finish = resolve));
    },
  );
  const controller = new AbortController();
  const allowed = interactions.computerAccess(bot.id, 'run-computer', controller.signal);
  await until(() => adapter.cards.length === 1);
  const card = adapter.cards[0];
  assert.equal(card.chatId, 'chat-owner');
  assert.match(card.card.title, /操控这台电脑/);
  const allow = card.card.buttons.find((button) => button.key.endsWith(':allow'))!;
  assert.equal(
    await adapter.handlers!.action({ chatId: 'chat-owner', operator: { id: 'stranger' }, key: allow.key }),
    undefined,
  );
  assert.equal(interactions.snapshot().length, 1);
  assert.equal(
    await adapter.handlers!.action({ chatId: 'chat-owner', operator: { id: 'owner' }, key: allow.key }),
    '已允许',
  );
  await allowed;
  await until(() => adapter.closed.length === 1);

  // A text reply from the owner decides the only request waiting, without its code.
  const denied = interactions.computerAccess(bot.id, 'run-computer', controller.signal);
  await until(() => adapter.cards.length === 2);
  adapter.receive({ text: '拒绝', sender: { id: 'stranger', name: '路人' }, chatId: 'chat-owner' });
  await settle();
  assert.equal(interactions.snapshot().length, 1);
  adapter.receive({ text: '拒绝' });
  await assert.rejects(denied, { code: 'permission.denied' });

  // Decided on the computer instead: the card says so.
  const local = interactions.computerAccess(bot.id, 'run-computer', controller.signal);
  await until(() => adapter.cards.length === 3);
  interactions.decideComputerAccess(interactions.snapshot()[0].id, true);
  await local;
  await until(() => adapter.closed.some((item) => item.result === '已在电脑上处理'));
  finish();
  await running;
});

test('the final reply to a private message sent while answering a connector chat goes back to that chat', async (t) => {
  const { store, bot, adapter, connectors, sent } = fixture(t);
  const id = connectors.add({
    botId: bot.id,
    permissionMode: 'ask',
    credentials: { platform: 'feishu', appId: 'cli_3', appSecret: 's' },
  });
  connectors.saved.get(id)!.owner = { id: 'owner', chatId: 'chat-owner' };
  adapter.receive({ text: '问问数据伙伴进度' });
  await until(() => sent.length === 1);
  const session = store.data.workSessions!.find((item) => item.connector?.connectorId === id)!,
    time = new Date().toISOString();
  // The run that sent the private message answered the connector message, then ended before the reply came.
  for (const [rootRunId, connector] of [
    ['root-im', { connectorId: id, platform: 'feishu' as const, messageId: 'y', sender: { id: 'owner' } }],
    ['root-desktop', undefined],
  ] as const) {
    store.data.runs.push({
      id: rootRunId,
      botId: bot.id,
      sessionId: session.id,
      status: 'completed',
      startedAt: time,
      modelCalls: 0,
      toolCalls: 0,
    });
    store.message(bot.id, 'user', '问问数据伙伴进度', { runId: rootRunId, ...(connector ? { connector } : {}) });
    store.data.peerExchanges.push({
      id: 'exchange-' + rootRunId,
      threadId: 't',
      fromBotId: bot.id,
      toBotId: 'other',
      rootRunId,
      rootBotId: bot.id,
      rootRequest: '问问数据伙伴进度',
      status: 'relaying',
      createdAt: time,
      updatedAt: time,
      requestMessageId: 'r',
    });
    const before = adapter.texts.length,
      runId = 'summary-' + rootRunId;
    await connectors.wrapRun(
      bot.id,
      { sessionId: session.id, peerOrigin: { kind: 'peer_summary', exchangeId: 'exchange-' + rootRunId } },
      async (options) => {
        options.onStarted?.(runId);
        store.data.runs.push({
          id: runId,
          botId: bot.id,
          sessionId: session.id,
          peerOrigin: options.peerOrigin,
          status: 'completed',
          startedAt: time,
          modelCalls: 0,
          toolCalls: 0,
        });
        // Still private when the run ends; the reply is published to the chat afterwards.
        store.message(bot.id, 'assistant', '数据伙伴说本周数据已核对完。', {
          runId,
          status: 'done',
          presentation: 'answer',
        });
      },
    );
    await settle();
    assert.deepEqual(
      adapter.texts.slice(before).map((item) => item.text),
      connector ? ['数据伙伴说本周数据已核对完。'] : [],
    );
  }
});

test('the WeCom adapter subscribes, receives, replies to the message and stops when displaced', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  t.after(() => server.close());
  await once(server, 'listening');
  const frames: any[] = [];
  let socket: WebSocket | undefined;
  server.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data));
      frames.push(frame);
      if (frame.cmd === 'aibot_subscribe')
        ws.send(
          JSON.stringify({
            headers: { req_id: frame.headers.req_id },
            errcode: frame.body.secret === 'ok' ? 0 : 40001,
          }),
        );
      else if (frame.cmd !== 'ping') ws.send(JSON.stringify({ headers: { req_id: frame.headers.req_id }, errcode: 0 }));
    });
  });
  const statuses: string[] = [],
    messages: InboundMessage[] = [];
  const adapter = new WecomAdapter(
    { botId: 'B1', secret: 'ok' },
    { url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, reconnectMs: () => 20 },
  );
  t.after(() => adapter.stop());
  adapter.start({
    status: (status) => void statuses.push(status),
    message: (message) => void messages.push(message),
    action: async () => undefined,
  });
  await until(() => statuses.includes('connected'));
  assert.deepEqual(frames[0].body, { bot_id: 'B1', secret: 'ok' });

  socket!.send(
    JSON.stringify({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'req-1' },
      body: {
        msgid: 'msg-1',
        chattype: 'single',
        from: { userid: 'zhou' },
        msgtype: 'mixed',
        mixed: {
          msg_item: [
            { msgtype: 'text', text: { content: '看看这张图' } },
            { msgtype: 'image', image: { url: 'u', aeskey: 'k' } },
          ],
        },
        create_time: 1760000000,
      },
    }),
  );
  await until(() => messages.length === 1);
  assert.equal(messages[0].chatId, 'zhou');
  assert.equal(messages[0].text, '看看这张图');
  assert.equal(messages[0].resources[0].kind, 'image');
  assert.equal(messages[0].sentAt, 1760000000000);

  await adapter.sendText('zhou', '完整的答复');
  const streams = frames.filter((frame) => frame.cmd === 'aibot_respond_msg');
  assert.ok(
    streams.every((frame) => frame.headers.req_id === 'req-1'),
    'replies answer the message request',
  );
  assert.equal(streams.at(-1).body.stream.content, '完整的答复');
  assert.equal(streams.at(-1).body.stream.finish, true);

  // A group message is tied to the group chat, and the bot's @mention is removed from the text.
  socket!.send(
    JSON.stringify({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'req-2' },
      body: {
        msgid: 'msg-2',
        chattype: 'group',
        chatid: 'group-1',
        from: { userid: 'zhou' },
        msgtype: 'text',
        text: { content: '@测试机器人 群里问一句' },
        create_time: 1760000001,
      },
    }),
  );
  await until(() => messages.length === 2);
  assert.equal(messages[1].chatId, 'group-1');
  assert.equal(messages[1].isGroup, true);
  assert.equal(messages[1].text, '群里问一句');

  await adapter.sendText('group-1', '群里的答复');
  const groupStreams = frames.filter((frame) => frame.cmd === 'aibot_respond_msg' && frame.headers.req_id === 'req-2');
  assert.equal(groupStreams.at(-1).body.stream.content, '群里的答复');

  // Without a recent message from a chat, text goes out as a proactive markdown message.
  await adapter.sendText('other', '提醒');
  const proactive = frames.find((frame) => frame.cmd === 'aibot_send_msg');
  assert.deepEqual(proactive.body, {
    chatid: 'other',
    msgtype: 'markdown',
    markdown: { content: '提醒' },
  });

  const before = server.clients.size;
  socket!.send(
    JSON.stringify({
      cmd: 'aibot_event_callback',
      headers: { req_id: 'e1' },
      body: { msgtype: 'event', event: { eventtype: 'disconnected_event' } },
    }),
  );
  await until(() => statuses.at(-1) === 'displaced');
  await settle(200);
  assert.ok(server.clients.size < before || server.clients.size === 0, 'a displaced connection is not taken back');
});

test('the WeCom adapter hears voice messages as spoken and answers with AMR voice messages', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  t.after(() => server.close());
  await once(server, 'listening');
  const frames: any[] = [];
  let socket: WebSocket | undefined;
  server.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data));
      frames.push(frame);
      if (frame.cmd === 'ping') return;
      const body =
        frame.cmd === 'aibot_upload_media_init'
          ? { upload_id: 'upload-1' }
          : frame.cmd === 'aibot_upload_media_finish'
            ? { media_id: 'media-1' }
            : undefined;
      ws.send(JSON.stringify({ headers: { req_id: frame.headers.req_id }, errcode: 0, ...(body ? { body } : {}) }));
    });
  });
  const statuses: string[] = [],
    messages: InboundMessage[] = [];
  const adapter = new WecomAdapter(
    { botId: 'B1', secret: 'ok' },
    { url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, reconnectMs: () => 20 },
  );
  t.after(() => adapter.stop());
  adapter.start({
    status: (status) => void statuses.push(status),
    message: (message) => void messages.push(message),
    action: async () => undefined,
  });
  await until(() => statuses.includes('connected'));
  socket!.send(
    JSON.stringify({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'req-voice' },
      body: {
        msgid: 'msg-voice',
        chattype: 'single',
        from: { userid: 'zhou' },
        msgtype: 'voice',
        voice: { content: '发条语音给我听听' },
        create_time: 1760000000,
      },
    }),
  );
  await until(() => messages.length === 1);
  assert.equal(messages[0].text, '发条语音给我听听');
  assert.equal(messages[0].spoken, true);

  assert.equal(adapter.voiceFormat, 'amr');
  const amr = Buffer.concat([Buffer.from('#!AMR\n'), Buffer.alloc(320, 0x3c)]);
  await adapter.sendVoice('zhou', { bytes: amr, durationMs: 200 });
  const init = frames.find((frame) => frame.cmd === 'aibot_upload_media_init');
  assert.equal(init.body.type, 'voice');
  assert.equal(init.body.filename, 'voice.amr');
  assert.equal(init.body.total_size, amr.length);
  const chunk = frames.find((frame) => frame.cmd === 'aibot_upload_media_chunk');
  assert.deepEqual(Buffer.from(chunk.body.base64_data, 'base64'), amr);
  const reply = frames.find((frame) => frame.cmd === 'aibot_respond_msg');
  assert.equal(reply.headers.req_id, 'req-voice', 'the voice answers the message');
  assert.deepEqual(reply.body, { msgtype: 'voice', voice: { media_id: 'media-1' } });

  // WeCom takes voice up to 2 MB; larger audio is refused before anything is uploaded.
  const uploads = () => frames.filter((frame) => frame.cmd === 'aibot_upload_media_init').length;
  await assert.rejects(adapter.sendVoice('zhou', { bytes: Buffer.alloc(2 * 1024 * 1024 + 1), durationMs: 1 }));
  assert.equal(uploads(), 1);
});

test('WeCom downloads decrypt with the message key', () => {
  const key = randomBytes(32),
    plain = Buffer.from('附件内容'),
    pad = 32 - (plain.length % 32);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  const data = Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])), cipher.final()]);
  assert.equal(decryptWecomFile(data, key.toString('base64')).toString(), '附件内容');
});

test('the WeChat adapter long-polls, keeps its cursor and replies with the context token', async (t) => {
  const requests: Array<{ url: string; body: any }> = [];
  let polls = 0;
  const fetcher = (async (url: URL | string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: String(url), body });
    if (String(url).endsWith('getupdates')) {
      polls++;
      if (polls === 1)
        return new Response(
          '{"ret":0,"get_updates_buf":"cur-2","msgs":[{"message_id":12345678901234567890,"from_user_id":"wx-user","message_type":1,"context_token":"ctx-1","item_list":[{"type":1,"text_item":{"text":"你好"}}]}]}',
        );
      if (polls === 2) return new Response(JSON.stringify({ ret: 0, errcode: -14 }));
    }
    return new Response('{"ret":0}');
  }) as typeof fetch;
  const statuses: string[] = [],
    states: Array<Record<string, string>> = [],
    messages: InboundMessage[] = [];
  const adapter = new WeixinAdapter(
    { token: 't', baseUrl: 'https://ilink.test', accountId: 'a', userId: 'wx-user' },
    'cur-1',
    '1.0.0',
    fetcher,
    10,
  );
  t.after(() => adapter.stop());
  adapter.start({
    status: (status) => void statuses.push(status),
    message: (message) => void messages.push(message),
    action: async () => undefined,
    state: (value) => void states.push(value),
  });
  await until(() => statuses.at(-1) === 'needs-config');
  assert.equal(requests[0].body.get_updates_buf, 'cur-1');
  assert.equal(messages[0].messageId, '12345678901234567890', 'uint64 IDs survive parsing');
  assert.equal(messages[0].text, '你好');
  assert.ok(states.some((value) => value.cursor === 'cur-2'));
  await adapter.sendText('wx-user', '**收到**');
  const sent = requests.find((request) => request.url.endsWith('sendmessage'))!;
  assert.equal(sent.body.msg.context_token, 'ctx-1');
  assert.equal(sent.body.msg.item_list[0].text_item.text, '收到');
  await assert.rejects(adapter.sendText('someone-else', 'hi'), /只能回复/);
});

test('the Feishu adapter maps channel messages and shows work as a typing reaction', async (t) => {
  const handlers: Record<string, (value: any) => any> = {},
    sent: Array<{ to: string; input: any }> = [],
    reactions: string[] = [],
    downloads: any[] = [];
  const channel = {
    connect: async () => {},
    disconnect: async () => {},
    on: (name: string, handler: (value: any) => any) => {
      handlers[name] = handler;
      return () => {};
    },
    send: async (to: string, input: any) => {
      sent.push({ to, input });
      return { messageId: 'om_1' };
    },
    updateCard: async () => {},
    addReaction: async (messageId: string, emoji: string) => {
      reactions.push(`+${messageId}:${emoji}`);
      return 'r1';
    },
    removeReaction: async (messageId: string, reactionId: string) => void reactions.push(`-${messageId}:${reactionId}`),
    rawClient: {
      im: {
        v1: {
          messageResource: {
            get: async (payload: any) => {
              downloads.push(payload);
              return { getReadableStream: () => Readable.from([Buffer.from('im'), Buffer.from('g')]) };
            },
          },
        },
      },
    },
  };
  const sdk = { createLarkChannel: () => channel, LoggerLevel: { error: 0 } } as unknown as LarkSdk;
  const statuses: string[] = [],
    messages: InboundMessage[] = [];
  const adapter = new FeishuAdapter({ appId: 'cli', appSecret: 's' }, () => sdk);
  t.after(() => adapter.stop());
  adapter.start({
    status: (status) => void statuses.push(status),
    message: (message) => void messages.push(message),
    action: async () => undefined,
  });
  await until(() => statuses.at(-1) === 'connected');
  handlers.message({
    messageId: 'om_2',
    chatId: 'oc_1',
    chatType: 'p2p',
    senderId: 'ou_1',
    content: '看图 <image key="img_1"/>',
    resources: [{ type: 'image', fileKey: 'img_1' }],
    createTime: 1760000000000,
  });
  await until(() => messages.length === 1);
  assert.equal(messages[0].text, '看图');
  assert.equal((await messages[0].resources[0].fetch(AbortSignal.timeout(1000))).bytes.toString(), 'img');
  assert.deepEqual(downloads.at(-1), { path: { message_id: 'om_2', file_key: 'img_1' }, params: { type: 'image' } });
  // A burst is one message to the hub, yet each resource downloads through the message it came in.
  const burst = (messageId: string, content: string, resources: object[], senderId = 'ou_1') =>
    handlers.message({
      messageId,
      chatId: 'oc_1',
      chatType: 'p2p',
      senderId,
      content,
      resources,
      createTime: 1760000000000,
    });
  burst('om_3', '<image key="img_2"/>', [{ type: 'image', fileKey: 'img_2' }]);
  burst('om_4', '<file key="file_1"/>', [{ type: 'file', fileKey: 'file_1', fileName: 'a.docx' }]);
  burst('om_5', '<audio key="audio_1"/>', [{ type: 'audio', fileKey: 'audio_1' }]);
  burst('om_6', '说明', [{ type: 'image', fileKey: 'img_2' }]);
  await until(() => messages.length === 2);
  assert.equal(messages[1].messageId, 'om_6');
  assert.equal(messages[1].text, '说明');
  assert.equal(messages[1].resources.length, 3);
  for (const resource of messages[1].resources) await resource.fetch(AbortSignal.timeout(1000));
  assert.deepEqual(downloads.slice(-3), [
    { path: { message_id: 'om_3', file_key: 'img_2' }, params: { type: 'image' } },
    { path: { message_id: 'om_4', file_key: 'file_1' }, params: { type: 'file' } },
    { path: { message_id: 'om_5', file_key: 'audio_1' }, params: { type: 'file' } },
  ]);
  // Two people in one chat stay two messages.
  burst('om_7', '甲', [], 'ou_a');
  burst('om_8', '乙', [], 'ou_b');
  await until(() => messages.length === 4);
  assert.deepEqual(
    messages
      .slice(-2)
      .map((message) => message.text)
      .sort(),
    ['乙', '甲'],
  );
  // The typing cue is a reaction on the latest message, added once and removed at the end.
  await adapter.typing('oc_1', true);
  await adapter.typing('oc_1', true);
  await adapter.typing('oc_1', false);
  assert.deepEqual(reactions, ['+om_8:Typing', '-om_8:r1']);
  await adapter.sendText('oc_1', '最终答复');
  assert.deepEqual(sent.at(-1), { to: 'oc_1', input: { markdown: '最终答复' } });
  const card = feishuCard({
    title: '请求',
    lines: ['命令：ls'],
    buttons: [{ label: '允许一次', key: 'p:AB12:allow' }],
  });
  assert.equal(card.schema, '2.0');
  assert.match(JSON.stringify(card), /"behaviors":\[\{"type":"callback","value":\{"key":"p:AB12:allow"\}\}\]/);
  assert.doesNotMatch(JSON.stringify(feishuCard({ title: '请求', lines: [], buttons: [] }, '已允许')), /column_set/);
  // Stopping delivers what is still held.
  burst('om_9', '最后一句', []);
  await adapter.stop();
  assert.equal(messages.at(-1)?.text, '最后一句');
});

test('Feishu QR setup creates a connector owned by the person who scanned', async (t) => {
  let options: any;
  const sdk = {
    registerApp: async (value: any) => {
      options = value;
      value.onQRCodeReady({ url: 'https://open.feishu.cn/page/qr', expireIn: 600 });
      await settle(50);
      return { client_id: 'cli_qr', client_secret: 'sec', user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' } };
    },
  } as unknown as LarkSdk;
  const { bot, connectors } = fixture(t, { lark: () => sdk });
  const setupId = connectors.startSetup({ platform: 'feishu', botId: bot.id, permissionMode: 'auto' });
  await until(() => connectors.snapshot().setups.some((setup) => setup.id === setupId && setup.phase === 'done'));
  const view = connectors.snapshot();
  assert.equal(view.connectors.length, 1);
  assert.equal(view.connectors[0].owner?.id, 'ou_owner');
  assert.equal(view.connectors[0].account, 'cli_qr');
  assert.equal(options.createOnly, true);
  assert.ok(options.addons.scopes.tenant.includes('cardkit:card:write'));
  assert.deepEqual(options.addons.events.items.tenant, ['im.message.receive_v1']);
  assert.equal(view.setups[0].connectorId, view.connectors[0].id);
  // Credentials are stored encrypted, never in the view.
  assert.doesNotMatch(JSON.stringify(view), /sec/);
});

test('connector runs stream live text, emit intermediate turns before tools and hide unclosed visual fences', async (t) => {
  assert.equal(
    connectorStreamingText('先看趋势：\n\n```chart\n{"chartType":"bar"'),
    '先看趋势：',
    'unclosed visual fences stay hidden while streaming',
  );
  assert.match(
    connectorText(
      '<think>内部思考</think>结论如下：\n\n[[block:b1]]\n```metrics\n{"items":[{"label":"收入","value":"100"}]}\n```',
    ),
    /结论如下：\s*收入 100/,
  );

  // Records chronological stream events alongside cards and plain sends.
  const timeline: string[] = [];
  class StreamingFakeAdapter extends FakeAdapter {
    streams: Array<{ chatId: string; updates: string[]; finished?: string }> = [];
    beginStream(chatId: string): ConnectorTextStream {
      const record: { chatId: string; updates: string[]; finished?: string } = { chatId, updates: [] };
      this.streams.push(record);
      const index = this.streams.length;
      return {
        intervalMs: 0,
        update: async (text) => {
          record.updates.push(text);
          timeline.push(`stream#${index}:update:${text}`);
        },
        finish: async (text) => {
          record.finished = text;
          timeline.push(`stream#${index}:finish:${text}`);
        },
      };
    }
    override async sendCard(chatId: string, card: ConnectorCard) {
      timeline.push(`card:${card.title}`);
      return super.sendCard(chatId, card);
    }
  }

  const dir = tempDir(t),
    store = new Store(dir),
    bot = store.data.bots[0],
    adapter = new StreamingFakeAdapter('wecom');
  store.data.model.model = 'fixture';
  let turn = 0;
  const model = {
    complete: async (_messages: unknown, _tools: unknown, _signal: AbortSignal, onDelta?: (delta: string) => void) => {
      turn++;
      if (turn === 1) {
        onDelta?.('<think>先思考</think>');
        onDelta?.('我先查一下');
        await delay(15);
        onDelta?.('可用工具。');
        return {
          content: '<think>先思考</think>我先查一下可用工具。',
          finishReason: 'tool_calls',
          calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'exec_command', arguments: JSON.stringify({ command: 'ls', location: 'vm' }) },
            },
          ],
        };
      }
      if (turn === 2) {
        // Reasoning-only intermediate turn: produces no IM stream or message.
        onDelta?.('<think>再确认一下</think>');
        return {
          content: '<think>再确认一下</think>',
          finishReason: 'tool_calls',
          calls: [
            {
              id: 'c2',
              type: 'function',
              function: { name: 'exec_command', arguments: JSON.stringify({ command: 'pwd', location: 'vm' }) },
            },
          ],
        };
      }
      onDelta?.('统计结果：\n\n```metrics\n{"items":[{"label":"通过"');
      await delay(15);
      onDelta?.(',"value":"3"}]}\n```\n\n全部搞定了。');
      return answer('统计结果：\n\n```metrics\n{"items":[{"label":"通过","value":"3"}]}\n```\n\n全部搞定了。');
    },
  } as unknown as ModelClient;
  const vm = {
    execute: async () => ({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1 }),
  } as unknown as VmController;
  const harness = new Harness(store, vm, model, () => {});
  let connectors: Connectors | undefined;
  const queue = new ChatPinQueue(
    store,
    {
      isRunning: (id, sessionId) => harness.isRunning(id, sessionId),
      run: (id, input, options) => connectors!.wrapRun(id, options, (wrapped) => harness.run(id, input, wrapped)),
    },
    () => {},
  );
  connectors = new Connectors({
    store,
    dataDir: dir,
    codec,
    version: 'test',
    attachments: new Attachments(store),
    send: ({ connector, ...input }) => queue.send(input, connector),
    cancel: () => {},
    isRunning: (botId, sessionId) => harness.isRunning(botId, sessionId),
    setPermission: () => {},
    interactions: new Interactions(() => {}),
    changed: () => queue.wake(),
    lark: () => ({}) as LarkSdk,
    createAdapter: () => adapter,
  });
  t.after(async () => {
    queue.dispose();
    await until(() => !harness.busy);
    await connectors!.dispose();
  });
  const id = connectors.add({
    botId: bot.id,
    permissionMode: 'auto',
    credentials: { platform: 'wecom', botId: 'bot-stream', secret: 's' },
  });
  connectors.saved.get(id)!.owner = { id: 'owner' };
  adapter.receive({ text: '帮我查一下情况' });
  await until(() => adapter.streams.length === 2 && adapter.streams[1].finished !== undefined && !harness.busy);
  assert.equal(adapter.texts.length, 0, 'both turns streamed cleanly without duplicate sendText');
  assert.ok(adapter.streams[0].updates.length >= 1);
  assert.ok(adapter.streams[0].updates.every((text) => !text.includes('<think>')));
  assert.equal(adapter.streams[0].finished, '我先查一下可用工具。');
  assert.ok(
    adapter.streams[1].updates.every((text) => !text.includes('{"items"')),
    'unclosed visual fence JSON is not flashed during live streaming',
  );
  assert.equal(adapter.streams[1].finished, '统计结果：\n\n通过 3\n\n全部搞定了。');
  assert.ok(
    timeline.indexOf('stream#1:finish:我先查一下可用工具。') <
      timeline.findIndex((entry) => entry.startsWith('stream#2:')),
    'intermediate turn finishes before the next turn streams',
  );
});

test('non-streaming adapters still send intermediate text turns immediately, and cancelled/failed runs close open streams', async (t) => {
  const dir = tempDir(t),
    store = new Store(dir),
    bot = store.data.bots[0],
    plainAdapter = new FakeAdapter('weixin');
  store.data.model.model = 'fixture';
  let turn = 0,
    releaseSecondTurn!: () => void;
  const secondTurnReady = new Promise<void>((resolve) => {
    releaseSecondTurn = resolve;
  });
  const model = {
    complete: async () => {
      turn++;
      if (turn === 1)
        return {
          content: '第一步：先读取信息。',
          finishReason: 'tool_calls',
          calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'exec_command', arguments: JSON.stringify({ command: 'cat a.txt', location: 'vm' }) },
            },
          ],
        };
      await secondTurnReady;
      return answer('全部完成了。');
    },
  } as unknown as ModelClient;
  const vm = {
    execute: async () => ({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1 }),
  } as unknown as VmController;
  const harness = new Harness(store, vm, model, () => {});
  let connectors: Connectors | undefined;
  const queue = new ChatPinQueue(
    store,
    {
      isRunning: (id, sessionId) => harness.isRunning(id, sessionId),
      run: (id, input, options) => connectors!.wrapRun(id, options, (wrapped) => harness.run(id, input, wrapped)),
    },
    () => {},
  );
  connectors = new Connectors({
    store,
    dataDir: dir,
    codec,
    version: 'test',
    attachments: new Attachments(store),
    send: ({ connector, ...input }) => queue.send(input, connector),
    cancel: () => {},
    isRunning: (botId, sessionId) => harness.isRunning(botId, sessionId),
    setPermission: () => {},
    interactions: new Interactions(() => {}),
    changed: () => queue.wake(),
    lark: () => ({}) as LarkSdk,
    createAdapter: () => plainAdapter,
  });
  t.after(async () => {
    releaseSecondTurn();
    queue.dispose();
    await until(() => !harness.busy);
    await connectors!.dispose();
  });
  const id = connectors.add({
    botId: bot.id,
    permissionMode: 'auto',
    credentials: { platform: 'wecom', botId: 'bot-plain', secret: 's' },
  });
  connectors.saved.get(id)!.owner = { id: 'owner' };
  plainAdapter.receive({ text: '做个多步任务' });
  // Intermediate text arrives while turn 2 is still blocked.
  await until(() => plainAdapter.texts.length === 1);
  assert.equal(plainAdapter.texts[0].text, '第一步：先读取信息。');
  releaseSecondTurn();
  await until(() => plainAdapter.texts.length === 2 && !harness.busy);
  assert.equal(plainAdapter.texts[1].text, '全部完成了。');

  // Cancelled or failed runs close any already-opened stream cleanly.
  const closedStreams: string[] = [];
  const {
    connectors: streamHub,
    bot: streamBot,
    store: streamStore,
  } = fixture(t, {
    createAdapter: () => ({
      platform: 'wecom',
      start: (handlers) => handlers.status('connected'),
      stop: async () => {},
      sendText: async (_chatId, text) => void closedStreams.push('text:' + text),
      sendFile: async () => {},
      beginStream: () => ({
        intervalMs: 0,
        update: async (text) => void closedStreams.push('update:' + text),
        finish: async (text) => void closedStreams.push('finish:' + text),
      }),
    }),
  });
  const cid = streamHub.add({
    botId: streamBot.id,
    permissionMode: 'auto',
    credentials: { platform: 'wecom', botId: 'b-cancel', secret: 's' },
  });
  const session = {
    id: 'sess-cancel',
    botId: streamBot.id,
    name: '企业微信',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    connector: { connectorId: cid, platform: 'wecom' as const, chatId: 'chat-owner', peer: { id: 'owner' } },
  };
  (streamStore.data.workSessions ||= []).push(session);
  const msg = streamStore.message(streamBot.id, 'user', '测试', {
    sessionId: session.id,
    connector: { connectorId: cid, platform: 'wecom', messageId: 'm-c', sender: { id: 'owner' } },
  });
  for (const status of ['cancelled', 'failed'] as const) {
    const runId = 'run-' + status;
    await streamHub.wrapRun(streamBot.id, { sessionId: session.id, inputMessageIds: [msg.id] }, async (options) => {
      options.onStarted?.(runId);
      streamStore.data.runs.push({
        id: runId,
        botId: streamBot.id,
        sessionId: session.id,
        status,
        ...(status === 'failed' ? { error: '出错了' } : {}),
        startedAt: new Date().toISOString(),
        modelCalls: 0,
        toolCalls: 0,
      });
      options.onAssistantStream?.({ runId, messageId: 'am-' + status, content: '写到一半' });
      await settle(20);
    });
    await settle(30);
  }
  assert.deepEqual(closedStreams, [
    'update:写到一半',
    'finish:',
    'update:写到一半',
    'finish:',
    'text:这次没有完成：出错了',
  ]);
});

test('the WeCom adapter streams passive replies with finish:false/true and rolls over on byte and lifetime limits', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  t.after(() => server.close());
  await once(server, 'listening');
  const frames: any[] = [];
  let socket: WebSocket | undefined;
  server.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data));
      frames.push(frame);
      if (frame.cmd !== 'ping') ws.send(JSON.stringify({ headers: { req_id: frame.headers.req_id }, errcode: 0 }));
    });
  });
  const statuses: string[] = [];
  const adapter = new WecomAdapter(
    { botId: 'B1', secret: 'ok' },
    {
      url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
      reconnectMs: () => 20,
      streamMaxBytes: 30,
      streamLifetimeMs: 35,
    },
  );
  t.after(() => adapter.stop());
  adapter.start({
    status: (status) => void statuses.push(status),
    message: () => {},
    action: async () => undefined,
  });
  await until(() => statuses.includes('connected'));
  // Without a recent inbound message, streaming is unavailable (proactive messages use sendText markdown).
  assert.equal(adapter.beginStream('zhou'), undefined);

  socket!.send(
    JSON.stringify({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'req-stream' },
      body: {
        msgid: 'msg-s1',
        chattype: 'single',
        from: { userid: 'zhou' },
        msgtype: 'text',
        text: { content: '开始' },
        create_time: 1760000000,
      },
    }),
  );
  await until(() => adapter.beginStream('zhou') !== undefined);

  // Basic live stream: same req_id and stream.id, finish:false updates then finish:true.
  const s1 = adapter.beginStream('zhou')!;
  await s1.update('前半句');
  await s1.update('前半句，后半句');
  await s1.finish('前半句，后半句。');
  const s1Frames = frames.filter((frame) => frame.cmd === 'aibot_respond_msg');
  assert.equal(s1Frames.length, 3);
  assert.ok(s1Frames.every((frame) => frame.headers.req_id === 'req-stream'));
  assert.equal(new Set(s1Frames.map((frame) => frame.body.stream.id)).size, 1);
  assert.deepEqual(
    s1Frames.map((frame) => [frame.body.stream.finish, frame.body.stream.content]),
    [
      [false, '前半句'],
      [false, '前半句，后半句'],
      [true, '前半句，后半句。'],
    ],
  );

  // Byte-limit rollover closes the first stream ID and continues on a new stream ID.
  const beforeRoll = frames.length;
  const s2 = adapter.beginStream('zhou')!;
  await s2.update('第一段内容\n\n第二段内容非常长超出限制');
  await s2.finish('第一段内容\n\n第二段内容非常长超出限制，结尾');
  const s2Frames = frames.slice(beforeRoll).filter((frame) => frame.cmd === 'aibot_respond_msg');
  const s2Ids = [...new Set(s2Frames.map((frame) => frame.body.stream.id))];
  assert.ok(s2Ids.length >= 2, 'exceeding maxBytes rolls over to a fresh stream ID');
  assert.ok(
    s2Frames.every((frame) => Buffer.byteLength(frame.body.stream.content, 'utf8') <= 30),
    'every frame stays within maxBytes',
  );
  for (const id of s2Ids) {
    const last = s2Frames.filter((frame) => frame.body.stream.id === id).at(-1);
    assert.equal(last.body.stream.finish, true, 'every stream ID is cleanly finalized');
  }

  // Lifetime rollover closes an aging stream ID before WeCom's 10-minute cutoff.
  const beforeLife = frames.length;
  const s3 = adapter.beginStream('zhou')!;
  await s3.update('第一部分');
  await delay(45);
  await s3.update('第一部分 第二部分');
  await s3.finish('第一部分 第二部分');
  const s3Frames = frames.slice(beforeLife).filter((frame) => frame.cmd === 'aibot_respond_msg');
  const s3Ids = [...new Set(s3Frames.map((frame) => frame.body.stream.id))];
  assert.equal(s3Ids.length, 2);
  assert.deepEqual(
    s3Frames.map((frame) => [
      frame.body.stream.id === s3Ids[0] ? 'a' : 'b',
      frame.body.stream.finish,
      frame.body.stream.content,
    ]),
    [
      ['a', false, '第一部分'],
      ['a', true, '第一部分'],
      ['b', false, '第二部分'],
      ['b', true, '第二部分'],
    ],
  );
});

test('the Feishu adapter streams with CardKit when allowed and falls back to card patching without cardkit:card:write', async (t) => {
  const ops: string[] = [];
  let streamError: Error | undefined;
  const channel = {
    connect: async () => {},
    disconnect: async () => {},
    on: () => () => {},
    send: async (to: string, input: any) => {
      ops.push(`send:${to}:${input.markdown ? 'md:' + input.markdown : 'card:' + input.card.body.elements[0].content}`);
      return { messageId: 'om_' + ops.length };
    },
    stream: async (to: string, input: { markdown: (ctrl: any) => Promise<void> }) => {
      ops.push(`stream:start:${to}`);
      if (streamError) throw streamError;
      await input.markdown({
        messageId: 'om_stream',
        append: async (chunk: string) => void ops.push(`stream:append:${chunk}`),
        setContent: async (full: string) => void ops.push(`stream:set:${full}`),
      });
      ops.push('stream:end');
      return { messageId: 'om_stream' };
    },
    updateCard: async (messageId: string, card: any) => {
      ops.push(`patch:${messageId}:${card.body.elements[0].content}`);
    },
    addReaction: async () => 'r1',
    removeReaction: async () => {},
    rawClient: {
      im: { v1: { messageResource: { get: async () => ({ getReadableStream: () => Readable.from([]) }) } } },
    },
  };
  const sdk = { createLarkChannel: () => channel, LoggerLevel: { error: 0 } } as unknown as LarkSdk;
  const statuses: string[] = [];
  const adapter = new FeishuAdapter({ appId: 'cli', appSecret: 's' }, () => sdk, {
    streamIntervalMs: 100,
    patchIntervalMs: 400,
    cardMaxChars: 80,
  });
  t.after(() => adapter.stop());
  adapter.start({ status: (s) => void statuses.push(s), message: () => {}, action: async () => undefined });
  await until(() => statuses.at(-1) === 'connected');

  // Tier 1: CardKit native streaming via channel.stream.
  const first = adapter.beginStream('oc_1')!;
  assert.equal(first.intervalMs, 100);
  await first.update('你好');
  await first.update('你好，世界');
  await first.update('重写后的内容');
  await first.finish('重写后的内容！');
  assert.deepEqual(ops, [
    'stream:start:oc_1',
    'stream:append:你好',
    'stream:append:你好，世界',
    'stream:set:重写后的内容',
    'stream:append:重写后的内容！',
    'stream:end',
  ]);

  // Tier 1 -> Tier 2 fallback when cardkit:card:write is missing.
  ops.length = 0;
  streamError = Object.assign(new Error('99991672 missing cardkit:card:write'), { code: 'permission_denied' });
  const second = adapter.beginStream('oc_1')!;
  await second.update('降级第一段');
  assert.equal(second.intervalMs, 400);
  await second.update('降级第一段，补充内容');
  await second.finish('降级第一段，补充内容。');
  assert.deepEqual(ops, [
    'stream:start:oc_1',
    'send:oc_1:card:降级第一段',
    'patch:om_2:降级第一段，补充内容',
    'patch:om_2:降级第一段，补充内容。',
  ]);

  // Once CardKit permission denial is observed, the next stream goes straight to card patching and splits long text.
  ops.length = 0;
  const third = adapter.beginStream('oc_1')!;
  assert.equal(third.intervalMs, 400);
  const longText = '甲'.repeat(60) + '\n\n' + '乙'.repeat(60);
  await third.update(longText);
  await third.finish(longText);
  assert.ok(!ops.some((entry) => entry.startsWith('stream:start')));
  assert.equal(ops.filter((entry) => entry.startsWith('send:')).length, 2);
  assert.deepEqual(feishuMarkdownCard('正文').body.elements, [{ tag: 'markdown', content: '正文' }]);
});
