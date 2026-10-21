import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { answer, settle, tempDir, until } from './helpers';
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
  InboundMessage,
} from '../electron/core/connectors/connector-adapter';
import { WecomAdapter, decryptWecomFile } from '../electron/core/connectors/adapters/wecom';
import { WeixinAdapter } from '../electron/core/connectors/adapters/weixin';
import { FeishuAdapter, feishuCard, type LarkSdk } from '../electron/core/connectors/adapters/feishu';
import { plainText, splitText } from '../electron/core/connectors/format';
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
    sent: Array<{ sessionId: string; message: string; attachmentIds: string[] }> = [],
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
  const model = {
    complete: async () =>
      answer(
        ++replies === 1
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

  // The same session, written from the app: the Bot answers in the app only.
  queue.send({ botId: bot.id, sessionId: input.sessionId, message: '桌面上问一句' });
  await until(() => replies === 4 && !harness.busy);
  await settle();
  assert.equal(adapter.texts.length, 3);
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
    reactions: string[] = [];
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
    downloadResource: async () => Buffer.from('img'),
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
  assert.equal(messages[0].text, '看图');
  assert.equal((await messages[0].resources[0].fetch(AbortSignal.timeout(1000))).bytes.toString(), 'img');
  // The typing cue is a reaction on the latest message, added once and removed at the end.
  await adapter.typing('oc_1', true);
  await adapter.typing('oc_1', true);
  await adapter.typing('oc_1', false);
  assert.deepEqual(reactions, ['+om_2:Typing', '-om_2:r1']);
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
  assert.deepEqual(options.addons.events.items.tenant, ['im.message.receive_v1']);
  assert.equal(view.setups[0].connectorId, view.connectors[0].id);
  // Credentials are stored encrypted, never in the view.
  assert.doesNotMatch(JSON.stringify(view), /sec/);
});
