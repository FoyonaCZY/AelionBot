// Telegram, Discord and Slack connectors against local stand-ins for their HTTP APIs and WebSocket gateways.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { delay, settle, tempDir, until } from './helpers';
import { Store } from '../electron/core/storage/store';
import { Interactions } from '../electron/core/agent/interactions';
import { Attachments } from '../electron/core/attachments/attachments';
import { Connectors, type ConnectorDeps } from '../electron/core/connectors/connector-hub';
import type {
  AdapterHandlers,
  ConnectorAdapter,
  ConnectorCard,
  InboundAction,
  InboundMessage,
} from '../electron/core/connectors/connector-adapter';
import { TelegramAdapter } from '../electron/core/connectors/adapters/telegram';
import { DiscordAdapter } from '../electron/core/connectors/adapters/discord';
import { SlackAdapter } from '../electron/core/connectors/adapters/slack';
import {
  discordMarkdown,
  slackMrkdwn,
  slackPlain,
  splitMarkdown,
  telegramHtml,
} from '../electron/core/connectors/markdown';
import { discordInviteUrl, slackManifest } from '../shared/connector-setup';
import type { ConnectorPlatform } from '../shared/types/connector-types';

// Token-shaped fixtures are put together at run time, so secret scanners do not take them for real tokens.
const token = (...parts: string[]) => parts.join('');
const TELEGRAM_TOKEN = token('123456789:', 'AAHk3-fixture_token_for_tests_only_xx');
// The first part is "112233445566778899" in base64, as a real bot token starts with the bot's ID.
const DISCORD_TOKEN = token('MTEyMjMzNDQ1NTY2Nzc4ODk5', '.Gfixtr.', 'fixture-token-for-tests-only-000000');
const CARD: ConnectorCard = {
  title: '研究员 请求本机权限',
  lines: ['运行命令', '命令：npm test'],
  buttons: [
    { label: '允许一次', key: 'p:AB12:allow', style: 'primary' },
    { label: '拒绝', key: 'p:AB12:deny', style: 'danger' },
  ],
};

interface Captured {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  /** The body as text; multipart bodies keep their part headers readable. */
  raw: string;
  body: any;
}
interface Reply {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  bytes?: Buffer;
}
/** A local HTTP server that records every request and answers with what `handler` returns. */
async function listen(t: test.TestContext, handler: (request: Captured) => Reply | void | Promise<Reply | void>) {
  const requests: Captured[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('latin1'),
        type = String(req.headers['content-type'] || '');
      let body: any;
      if (type.includes('json'))
        try {
          body = JSON.parse(Buffer.from(raw, 'latin1').toString('utf8'));
        } catch {}
      else if (type.includes('urlencoded'))
        body = Object.fromEntries(new URLSearchParams(Buffer.from(raw, 'latin1').toString('utf8')));
      const captured = { method: req.method || 'GET', path: req.url || '/', headers: req.headers, raw, body };
      requests.push(captured);
      void Promise.resolve(handler(captured)).then((reply) => {
        const answer = reply || {};
        res.writeHead(answer.status || 200, {
          'content-type': answer.bytes ? 'application/octet-stream' : 'application/json',
          ...answer.headers,
        });
        res.end(answer.bytes ?? (answer.json === undefined ? '' : JSON.stringify(answer.json)));
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests };
}
/** A local WebSocket server; `connected` runs for every connection, in order. */
async function gateway(t: test.TestContext, connected: (ws: WebSocket, index: number) => void) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const sockets: WebSocket[] = [];
  server.on('connection', (ws) => {
    sockets.push(ws);
    connected(ws, sockets.length - 1);
  });
  t.after(() => {
    for (const ws of sockets) ws.terminate();
    server.close();
  });
  return { url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, sockets };
}
/** Collects what an adapter reports; `press` is what the hub would answer to a button. */
function recorder(press: (action: InboundAction) => Promise<string | undefined> = async () => undefined) {
  const statuses: Array<{ status: string; issue?: string }> = [],
    messages: InboundMessage[] = [],
    states: Array<Record<string, string>> = [],
    actions: InboundAction[] = [];
  const handlers: AdapterHandlers = {
    status: (status, issue) => void statuses.push({ status, issue }),
    message: (message) => void messages.push(message),
    action: (action) => {
      actions.push(action);
      return press(action);
    },
    state: (value) => void states.push(value),
  };
  return { handlers, statuses, messages, states, actions, last: () => statuses.at(-1)?.status };
}

test('Markdown becomes Telegram HTML, with everything else escaped', () => {
  assert.equal(
    telegramHtml(
      '# 标题\n**加粗** 和 *斜体*、`a<b`、~~删除~~\n- [链接](https://example.com/a_b?x=1&y=2)\n> 引用 <tag>',
    ),
    [
      '<b>标题</b>',
      '<b>加粗</b> 和 <i>斜体</i>、<code>a&lt;b</code>、<s>删除</s>',
      '• <a href="https://example.com/a_b?x=1&amp;y=2">链接</a>',
      '<blockquote>引用 &lt;tag&gt;</blockquote>',
    ].join('\n'),
  );
  // Underscores inside an address or a name are not emphasis.
  assert.equal(
    telegramHtml('见 https://example.com/a_b_c 和 snake_case_name'),
    '见 https://example.com/a_b_c 和 snake_case_name',
  );
  assert.equal(
    telegramHtml('```ts\nconst a = 1 < 2 && "x";\n```'),
    '<pre><code class="language-ts">const a = 1 &lt; 2 &amp;&amp; "x";</code></pre>',
  );
  // A table has no HTML form in Telegram: it is laid out in a monospaced block, wide characters as two columns.
  assert.equal(
    telegramHtml('| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |\n| kiwi | 12 |'),
    '<pre>名称  数量\n苹果  3\nkiwi  12</pre>',
  );
});

test('Markdown is adjusted for Discord and rewritten as Slack mrkdwn', () => {
  assert.equal(
    discordMarkdown('#### 小节\n![图](https://example.com/a.png)\n| a | b |\n| - | - |\n| 1 | 2 |\n**原样**'),
    '**小节**\n[图](https://example.com/a.png)\n```\na  b\n1  2\n```\n**原样**',
  );
  assert.equal(
    slackMrkdwn('## 结论\n这是**重点**内容，*次要* <b>\n- [文档](https://example.com/?a=1&b=2)\n> 引用\n~~旧~~ `x<y`'),
    [
      '*结论*',
      '这是 *重点* 内容，_次要_ &lt;b&gt;',
      '• <https://example.com/?a=1&amp;b=2|文档>',
      '> 引用',
      '~旧~ `x&lt;y`',
    ].join('\n'),
  );
  assert.equal(slackMrkdwn('```js\nif (a < b) {}\n```'), '```\nif (a &lt; b) {}\n```');
  assert.equal(
    slackPlain('看 <https://example.com|这里> 和 <https://a.test>，<@U123> 说 1 &lt; 2 &amp;&amp; 3 &gt; 2'),
    '看 这里 (https://example.com) 和 https://a.test，@U123 说 1 < 2 && 3 > 2',
  );
});

test('a long reply splits under the limit and keeps a code block whole in every part', () => {
  const code = Array.from({ length: 60 }, (_, index) => `line ${index} of the listing`).join('\n'),
    parts = splitMarkdown(`说明\n\n\`\`\`python\n${code}\n\`\`\`\n\n结尾`, 500);
  assert.ok(parts.length > 2);
  for (const part of parts) {
    assert.ok(part.length <= 500, `part of ${part.length} characters`);
    assert.equal((part.match(/^```/gm) || []).length % 2, 0, 'every part closes the fences it opens');
  }
  assert.ok(parts[1].startsWith('```python\n'), 'a part that continues a block opens it again');
  assert.equal(
    parts
      .map((part) => telegramHtml(part).replace(/<[^>]+>/g, ''))
      .join('\n')
      .match(/line \d+ of the listing/g)?.length,
    60,
  );
});

test('the add dialog derives the Discord invite link and the Slack manifest', () => {
  assert.equal(
    discordInviteUrl(` ${DISCORD_TOKEN} `),
    'https://discord.com/oauth2/authorize?client_id=112233445566778899&scope=bot&permissions=0',
  );
  assert.equal(discordInviteUrl('not-a-token'), '');
  assert.equal(discordInviteUrl(TELEGRAM_TOKEN), '');
  const manifest = JSON.parse(slackManifest('研究员'));
  assert.equal(manifest.display_information.name, '研究员');
  assert.equal(manifest.settings.socket_mode_enabled, true);
  assert.deepEqual(manifest.settings.event_subscriptions.bot_events, ['message.im']);
  assert.equal(manifest.features.app_home.messages_tab_enabled, true);
  assert.ok(
    ['chat:write', 'im:history', 'files:read', 'files:write'].every((scope) =>
      manifest.oauth_config.scopes.bot.includes(scope),
    ),
  );
  assert.equal(JSON.parse(slackManifest('x'.repeat(40))).display_information.name, 'AelionBot');
});

// ---------- Telegram ----------

/** A Bot API stand-in: updates queued by the test are handed out by getUpdates from the asked offset on. */
async function telegramApi(t: test.TestContext, extra: (method: string, request: Captured) => Reply | void = () => {}) {
  const queue: any[] = [],
    offsets: number[] = [];
  const server = await listen(t, async (request) => {
    const [, method] = /^\/bot[^/]+\/(\w+)/.exec(request.path) || [];
    if (!method) return { bytes: Buffer.from('file-bytes') };
    const special = extra(method, request);
    if (special) return special;
    if (method === 'getUpdates') {
      offsets.push(request.body.offset);
      const ready = queue.filter((update) => update.update_id >= request.body.offset);
      if (!ready.length) await delay(15);
      return { json: { ok: true, result: queue.filter((update) => update.update_id >= request.body.offset) } };
    }
    if (method === 'getFile') return { json: { ok: true, result: { file_path: 'voice/file_7.oga' } } };
    if (method === 'sendMessage') return { json: { ok: true, result: { message_id: 500 + server.requests.length } } };
    return { json: { ok: true, result: true } };
  });
  const calls = (method: string) => server.requests.filter((request) => request.path.endsWith('/' + method));
  return { ...server, queue, offsets, calls };
}
const telegramUser = { id: 1001, is_bot: false, first_name: 'Li', last_name: 'Zhou', username: 'zhou' };
const telegramMessage = (id: number, fields: object) => ({
  update_id: id,
  message: { message_id: id, from: telegramUser, chat: { id: 1001, type: 'private' }, date: 1_760_000_000, ...fields },
});

test('the Telegram adapter long-polls private chats, keeps its offset and merges albums', async (t) => {
  const api = await telegramApi(t),
    seen = recorder();
  const adapter = new TelegramAdapter(TELEGRAM_TOKEN, 5, {
    apiBase: api.url,
    pollSeconds: 1,
    retryMs: 10,
    albumMs: 30,
  });
  t.after(() => adapter.stop());
  adapter.start(seen.handlers);
  await until(() => seen.last() === 'connected');
  assert.equal(api.offsets[0], 5, 'polling resumes from the saved offset');
  assert.equal(api.calls('deleteWebhook').length, 1, 'a webhook would take the updates away');
  assert.ok(api.requests.every((request) => request.path.startsWith(`/bot${TELEGRAM_TOKEN}/`)));

  api.queue.push(
    telegramMessage(10, { text: '帮我看看这个', reply_to_message: { text: '上一条' } }),
    {
      update_id: 11,
      message: { message_id: 11, from: telegramUser, chat: { id: -77, type: 'supergroup' }, text: '群里的' },
    },
    telegramMessage(12, { text: '/start' }),
    telegramMessage(13, {
      media_group_id: 'g1',
      caption: '两张图',
      photo: [{ file_id: 'small' }, { file_id: 'big-1' }],
    }),
    telegramMessage(14, { media_group_id: 'g1', photo: [{ file_id: 'big-2' }] }),
    telegramMessage(15, { voice: { file_id: 'v1', duration: 3 } }),
    telegramMessage(16, { document: { file_id: 'd1', file_name: '报告.pdf', mime_type: 'application/pdf' } }),
  );
  await until(() => seen.messages.length === 5);
  const [first, start, voice, file, album] = [
    seen.messages.find((message) => message.messageId === '1001:10')!,
    seen.messages.find((message) => message.messageId === '1001:12')!,
    seen.messages.find((message) => message.messageId === '1001:15')!,
    seen.messages.find((message) => message.messageId === '1001:16')!,
    seen.messages.find((message) => message.messageId === '1001:13')!,
  ];
  assert.deepEqual(
    { chatId: first.chatId, sender: first.sender, text: first.text, quoted: first.quoted, group: first.isGroup },
    { chatId: '1001', sender: { id: '1001', name: 'Li Zhou' }, text: '帮我看看这个', quoted: '上一条', group: false },
  );
  assert.equal(first.sentAt, 1_760_000_000_000);
  assert.equal(start.text, '/help', 'opening the bot again asks what it can do');
  assert.equal(album.text, '两张图');
  assert.deepEqual(
    album.resources.map((resource) => [resource.kind, resource.name]),
    [
      ['image', 'photo-13.jpg'],
      ['image', 'photo-14.jpg'],
    ],
  );
  assert.equal(voice.resources[0].kind, 'audio', 'a voice message is speech for the hub to put into words');
  assert.deepEqual([file.resources[0].kind, file.resources[0].name], ['file', '报告.pdf']);
  const download = await voice.resources[0].fetch(AbortSignal.timeout(5000));
  assert.deepEqual([download.name, download.bytes.toString()], ['voice-15.ogg', 'file-bytes']);
  assert.equal(api.calls('getFile')[0].body.file_id, 'v1');
  assert.ok(api.requests.some((request) => request.path === `/file/bot${TELEGRAM_TOKEN}/voice/file_7.oga`));
  assert.ok(
    seen.states.some((state) => state.offset === '17'),
    'the offset after the last update is kept for the next start',
  );
  await until(() => api.offsets.at(-1) === 17);
});

test('Telegram replies go out as HTML in parts, fall back to plain text and wait when told to slow down', async (t) => {
  let slowed = 0;
  const api = await telegramApi(t, (method, request) => {
    if (method !== 'sendMessage') return;
    if (request.body.parse_mode && String(request.body.text).includes('坏标记'))
      return { status: 400, json: { ok: false, error_code: 400, description: "Bad Request: can't parse entities" } };
    if (String(request.body.text).includes('慢一点') && !slowed++)
      return {
        status: 429,
        json: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } },
      };
  });
  const waits: number[] = [];
  const adapter = new TelegramAdapter(TELEGRAM_TOKEN, 0, {
    apiBase: api.url,
    pollSeconds: 1,
    retryAfterMs: (seconds) => (waits.push(seconds), 5),
  });
  const sent = () => api.calls('sendMessage').map((request) => request.body);

  await adapter.sendText('1001', '**结论**：见[文档](https://example.com)');
  assert.deepEqual(
    { chat: sent()[0].chat_id, text: sent()[0].text, mode: sent()[0].parse_mode },
    { chat: 1001, text: '<b>结论</b>：见<a href="https://example.com">文档</a>', mode: 'HTML' },
  );
  assert.equal(sent()[0].link_preview_options.is_disabled, true);

  await adapter.sendText(
    '1001',
    Array.from({ length: 400 }, (_, index) => `第 ${index} 行的内容比较长一些`).join('\n'),
  );
  const parts = sent().slice(1);
  assert.ok(parts.length >= 2 && parts.every((part) => part.text.length <= 4096));

  await adapter.sendText('1001', '**坏标记** 的内容');
  assert.deepEqual(
    sent()
      .slice(-2)
      .map((body) => [body.parse_mode, body.text]),
    [
      ['HTML', '<b>坏标记</b> 的内容'],
      [undefined, '坏标记 的内容'],
    ],
    'markup Telegram refuses is sent again as plain text',
  );

  await adapter.sendText('1001', '慢一点');
  assert.deepEqual(waits, [7], 'the wait Telegram asked for');
  assert.equal(sent().filter((body) => body.text === '慢一点').length, 2);
});

test('Telegram sends files, voice messages and a typing cue, and approvals as inline buttons', async (t) => {
  const api = await telegramApi(t, (method, request) => {
    if (method === 'sendPhoto' && request.raw.includes('filename="wide.png"'))
      return {
        status: 400,
        json: { ok: false, error_code: 400, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' },
      };
  });
  const seen = recorder(async (action) => (action.key.endsWith(':allow') ? '已允许' : undefined));
  const adapter = new TelegramAdapter(TELEGRAM_TOKEN, 0, { apiBase: api.url, pollSeconds: 1, typingMs: 20 });
  t.after(() => adapter.stop());
  adapter.start(seen.handlers);
  await until(() => seen.last() === 'connected');

  await adapter.sendFile('1001', { name: 'chart.png', bytes: Buffer.from('png') });
  await adapter.sendFile('1001', { name: 'wide.png', bytes: Buffer.from('png') });
  await adapter.sendFile('1001', { name: 'notes.txt', bytes: Buffer.from('text') });
  assert.equal(api.calls('sendPhoto').length, 2);
  assert.deepEqual(
    api.calls('sendDocument').map((request) => /filename="([^"]+)"/.exec(request.raw)?.[1]),
    ['wide.png', 'notes.txt'],
    'a picture Telegram refuses as a photo goes as a file',
  );
  assert.match(api.calls('sendPhoto')[0].raw, /name="chat_id"\r\n\r\n1001/);
  await assert.rejects(adapter.sendFile('1001', { name: 'big.bin', bytes: Buffer.alloc(51 * 1024 * 1024) }), /50 MB/);

  await adapter.sendVoice('1001', { bytes: Buffer.from('OggS'), durationMs: 2600 });
  assert.match(api.calls('sendVoice')[0].raw, /name="duration"\r\n\r\n3/);
  assert.match(api.calls('sendVoice')[0].raw, /filename="voice\.ogg"/);

  await adapter.typing('1001', true);
  await until(() => api.calls('sendChatAction').length >= 3, { message: 'the cue is repeated while the run works' });
  await adapter.typing('1001', false);
  const cues = api.calls('sendChatAction').length;
  await settle(80);
  assert.equal(api.calls('sendChatAction').length, cues, 'and stops with it');

  const handle = await adapter.sendCard('1001', CARD);
  const card = api.calls('sendMessage').at(-1)!.body;
  assert.equal(card.text, '<b>研究员 请求本机权限</b>\n运行命令\n命令：npm test');
  assert.deepEqual(card.reply_markup.inline_keyboard, [
    [
      { text: '允许一次', callback_data: 'p:AB12:allow' },
      { text: '拒绝', callback_data: 'p:AB12:deny' },
    ],
  ]);
  const messageId = Number(handle.split(':')[1]);
  const press = (id: string, data: string) =>
    api.queue.push({
      update_id: 100 + api.queue.length,
      callback_query: {
        id,
        from: telegramUser,
        data,
        message: { message_id: messageId, chat: { id: 1001, type: 'private' }, text: '卡片原文' },
      },
    });
  // A press that decides nothing is still answered, so the button stops spinning.
  press('q-1', 'p:AB12:deny');
  await until(() => api.calls('answerCallbackQuery').length === 1);
  assert.equal(api.calls('answerCallbackQuery')[0].body.text, undefined);
  assert.equal(api.calls('editMessageText').length, 0);
  // A deciding press on a card the outbox no longer tracks is written onto the card here.
  press('q-2', 'p:AB12:allow');
  await until(() => api.calls('editMessageText').length === 1);
  assert.deepEqual(seen.actions.at(-1), {
    chatId: '1001',
    operator: { id: '1001', name: 'Li Zhou' },
    key: 'p:AB12:allow',
  });
  assert.equal(api.calls('answerCallbackQuery')[1].body.text, '已允许');
  assert.deepEqual(
    [api.calls('editMessageText')[0].body.text, api.calls('editMessageText')[0].body.reply_markup],
    ['卡片原文\n\n已允许', { inline_keyboard: [] }],
  );
  // Closed by the outbox, the card shows its result and loses its buttons.
  await adapter.closeCard(handle, CARD, '已在电脑上处理');
  const closed = api.calls('editMessageText')[1].body;
  assert.deepEqual(
    [closed.chat_id, closed.message_id, closed.reply_markup],
    [1001, messageId, { inline_keyboard: [] }],
  );
  assert.ok(closed.text.endsWith('\n\n<b>已在电脑上处理</b>'));
});

test('Telegram reports a refused token, and steps aside while another program polls the bot', async (t) => {
  const refused = await telegramApi(t, () => ({
    status: 401,
    json: { ok: false, error_code: 401, description: 'Unauthorized' },
  }));
  const first = recorder(),
    rejected = new TelegramAdapter(TELEGRAM_TOKEN, 0, { apiBase: refused.url, pollSeconds: 1, retryMs: 5 });
  t.after(() => rejected.stop());
  rejected.start(first.handlers);
  await until(() => first.last() === 'needs-config');
  const asked = refused.requests.length;
  await settle(60);
  assert.equal(refused.requests.length, asked, 'a token that was refused is not tried again');

  let conflicts = 2;
  const busy = await telegramApi(t, (method) =>
    method === 'getUpdates' && conflicts-- > 0
      ? {
          status: 409,
          json: { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' },
        }
      : undefined,
  );
  const second = recorder(),
    shared = new TelegramAdapter(TELEGRAM_TOKEN, 0, { apiBase: busy.url, pollSeconds: 1, retryMs: 5 });
  t.after(() => shared.stop());
  shared.start(second.handlers);
  await until(() => second.last() === 'connected');
  assert.deepEqual(
    second.statuses.map((item) => item.status),
    ['connecting', 'displaced', 'connected'],
  );
});

// ---------- Discord ----------

/** A REST stand-in and a gateway that says hello, answers heartbeats, and starts or resumes sessions. */
async function discordApi(t: test.TestContext, extra: (request: Captured) => Reply | void = () => {}) {
  const frames: Array<{ connection: number; frame: any }> = [],
    control = { ackHeartbeats: true };
  const socket = await gateway(t, (ws, connection) => {
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 40 } }));
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data));
      frames.push({ connection, frame });
      if (frame.op === 1 && control.ackHeartbeats) ws.send(JSON.stringify({ op: 11 }));
      if (frame.op === 2)
        ws.send(
          JSON.stringify({
            op: 0,
            t: 'READY',
            s: 1,
            d: { session_id: 'session-' + connection, resume_gateway_url: socket.url, user: { id: '999' } },
          }),
        );
      if (frame.op === 6) ws.send(JSON.stringify({ op: 0, t: 'RESUMED', s: frame.d.seq + 1, d: {} }));
    });
  });
  const rest = await listen(t, (request) => {
    const special = extra(request);
    if (special) return special;
    if (request.path === '/gateway/bot') return { json: { url: socket.url } };
    if (request.path.startsWith('/cdn/')) return { bytes: Buffer.from('attachment-bytes') };
    if (request.method === 'POST' && /^\/channels\/[^/]+\/messages$/.test(request.path))
      return { json: { id: 'm' + rest.requests.length, channel_id: request.path.split('/')[2] } };
    if (request.path.endsWith('/typing') || request.path.includes('/interactions/')) return { status: 204 };
    return { json: {} };
  });
  const sent = (pattern: RegExp, method = 'POST') =>
    rest.requests.filter((request) => request.method === method && pattern.test(request.path));
  const dispatch = (type: string, data: object, sequence: number) =>
    socket.sockets.at(-1)!.send(JSON.stringify({ op: 0, t: type, s: sequence, d: data }));
  return { ...rest, gatewayUrl: socket.url, sockets: socket.sockets, frames, control, sent, dispatch };
}
const discordOptions = (api: { url: string }) => ({
  apiBase: api.url,
  version: '1.2.3',
  reconnectMs: () => 10,
  retryAfterMs: () => 5,
  typingMs: 20,
});
const identifies = (api: { frames: Array<{ frame: any }> }) => api.frames.filter((item) => item.frame.op === 2);
const resumes = (api: { frames: Array<{ frame: any }> }) => api.frames.filter((item) => item.frame.op === 6);

test('the Discord adapter identifies for direct messages only and maps them, their files and voice', async (t) => {
  const api = await discordApi(t),
    seen = recorder(),
    adapter = new DiscordAdapter(DISCORD_TOKEN, discordOptions(api));
  t.after(() => adapter.stop());
  adapter.start(seen.handlers);
  await until(() => seen.last() === 'connected');
  const gatewayRequest = api.requests.find((request) => request.path === '/gateway/bot')!;
  assert.equal(gatewayRequest.headers.authorization, `Bot ${DISCORD_TOKEN}`);
  assert.equal(gatewayRequest.headers['user-agent'], 'DiscordBot (https://aelion.chat, 1.2.3)');
  assert.deepEqual(
    [identifies(api)[0].frame.d.token, identifies(api)[0].frame.d.intents],
    [DISCORD_TOKEN, 4096],
    'only DIRECT_MESSAGES, which needs no privileged intent',
  );
  await until(() => api.frames.some((item) => item.frame.op === 1), { message: 'heartbeats start after hello' });

  const author = { id: '42', username: 'zhou', global_name: '小周' };
  api.dispatch('MESSAGE_CREATE', { id: 'g1', channel_id: 'c9', guild_id: 'guild', author, content: '服务器里的' }, 2);
  api.dispatch(
    'MESSAGE_CREATE',
    { id: 'b1', channel_id: 'dm1', author: { id: '999', bot: true }, content: '自己的' },
    3,
  );
  api.dispatch(
    'MESSAGE_CREATE',
    {
      id: 'm1',
      channel_id: 'dm1',
      author,
      content: '看看这两个',
      timestamp: '2026-11-17T08:00:00.000Z',
      type: 19,
      referenced_message: { content: '之前那条' },
      attachments: [
        { id: 'a1', filename: 'shot.png', content_type: 'image/png', url: api.url + '/cdn/shot.png' },
        { id: 'a2', filename: 'data.csv', content_type: 'text/csv', url: api.url + '/cdn/data.csv' },
      ],
    },
    4,
  );
  api.dispatch(
    'MESSAGE_CREATE',
    {
      id: 'm2',
      channel_id: 'dm1',
      author,
      content: '',
      flags: 8192,
      attachments: [
        { id: 'a3', filename: 'voice-message.ogg', content_type: 'audio/ogg', url: api.url + '/cdn/v.ogg' },
      ],
    },
    5,
  );
  await until(() => seen.messages.length === 2);
  await settle(40);
  assert.equal(seen.messages.length, 2, 'server messages and bots are not served');
  const [message, voice] = seen.messages;
  assert.deepEqual(
    { id: message.messageId, chat: message.chatId, sender: message.sender, text: message.text, quoted: message.quoted },
    { id: 'm1', chat: 'dm1', sender: { id: '42', name: '小周' }, text: '看看这两个', quoted: '之前那条' },
  );
  assert.equal(message.sentAt, Date.parse('2026-11-17T08:00:00.000Z'));
  assert.deepEqual(
    message.resources.map((resource) => [resource.kind, resource.name]),
    [
      ['image', 'shot.png'],
      ['file', 'data.csv'],
    ],
  );
  assert.equal((await message.resources[1].fetch(AbortSignal.timeout(5000))).bytes.toString(), 'attachment-bytes');
  assert.equal(voice.resources[0].kind, 'audio', 'a voice message is speech for the hub to put into words');
});

test('the Discord adapter resumes after a dropped or silent connection and starts over when told to', async (t) => {
  const api = await discordApi(t),
    seen = recorder(),
    adapter = new DiscordAdapter(DISCORD_TOKEN, discordOptions(api));
  t.after(() => adapter.stop());
  adapter.start(seen.handlers);
  await until(() => seen.last() === 'connected');
  api.dispatch(
    'MESSAGE_CREATE',
    { id: 'm1', channel_id: 'dm1', author: { id: '42', username: 'z' }, content: '一' },
    7,
  );
  await until(() => seen.messages.length === 1);

  // The connection drops: the next one resumes the session from the last sequence number.
  api.sockets[0].close(1001);
  await until(() => resumes(api).length === 1);
  assert.deepEqual(resumes(api)[0].frame.d, { token: DISCORD_TOKEN, session_id: 'session-0', seq: 7 });
  await until(() => seen.last() === 'connected' && api.sockets.length === 2);
  assert.equal(identifies(api).length, 1);

  // Heartbeats that go unanswered mean a dead connection: it is replaced and resumed too.
  api.control.ackHeartbeats = false;
  await until(() => resumes(api).length >= 2, { message: 'reconnects after a missed heartbeat answer' });
  api.control.ackHeartbeats = true;
  await until(() => seen.last() === 'connected');

  // "Invalid session, not resumable": the session is dropped and a new one identified.
  const before = identifies(api).length;
  api.sockets.at(-1)!.send(JSON.stringify({ op: 9, d: false }));
  await until(() => identifies(api).length === before + 1);
  await until(() => seen.last() === 'connected');
});

test('Discord stops on a refused token instead of reconnecting', async (t) => {
  const closing = await gateway(t, (ws) => {
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
    ws.on('message', () => ws.close(4004, 'Authentication failed.'));
  });
  const seen = recorder(),
    adapter = new DiscordAdapter(DISCORD_TOKEN, { gatewayUrl: closing.url, reconnectMs: () => 5 });
  t.after(() => adapter.stop());
  adapter.start(seen.handlers);
  await until(() => seen.last() === 'needs-config');
  await settle(60);
  assert.equal(closing.sockets.length, 1);

  const rest = await listen(t, () => ({ status: 401, json: { message: '401: Unauthorized', code: 0 } }));
  const other = recorder(),
    refused = new DiscordAdapter(DISCORD_TOKEN, { apiBase: rest.url, reconnectMs: () => 5 });
  t.after(() => refused.stop());
  refused.start(other.handlers);
  await until(() => other.last() === 'needs-config');
});

test('Discord sends text in parts, files, a typing cue, and waits out rate limits', async (t) => {
  let limited = 0;
  const api = await discordApi(t, (request) => {
    if (request.method !== 'POST') return;
    if (request.path === '/channels/dm1/messages' && request.body?.content === '慢一点' && !limited++)
      return { status: 429, json: { message: 'You are being rate limited.', retry_after: 0.3, global: false } };
    if (request.path === '/channels/42/messages')
      return { status: 404, json: { message: 'Unknown Channel', code: 10003 } };
    if (request.path === '/users/@me/channels') return { json: { id: 'dm-42' } };
    if (request.path === '/channels/dm1/messages' && request.raw.includes('filename="huge.bin"'))
      return { status: 413, json: { message: 'Request entity too large', code: 40005 } };
  });
  const adapter = new DiscordAdapter(DISCORD_TOKEN, discordOptions(api)),
    posts = (channel: string) => api.sent(new RegExp(`^/channels/${channel}/messages$`));

  await adapter.sendText('dm1', '**结论**\n\n| a | b |\n| - | - |\n| 1 | 2 |');
  assert.deepEqual(posts('dm1')[0].body, {
    content: '**结论**\n\n```\na  b\n1  2\n```',
    allowed_mentions: { parse: [] },
    flags: 4,
  });
  await adapter.sendText('dm1', Array.from({ length: 300 }, (_, index) => `第 ${index} 行的内容`).join('\n'));
  const parts = posts('dm1').slice(1);
  assert.ok(parts.length >= 2 && parts.every((part) => part.body.content.length <= 2000));

  await adapter.sendText('dm1', '慢一点');
  assert.equal(
    posts('dm1').filter((request) => request.body?.content === '慢一点').length,
    2,
    'sent again after the wait',
  );

  // Only a user ID is known: the private channel is opened, then used.
  await adapter.sendText('42', '你好');
  assert.deepEqual(api.sent(/^\/users\/@me\/channels$/)[0].body, { recipient_id: '42' });
  assert.equal(posts('dm-42')[0].body.content, '你好');
  await adapter.sendText('42', '再见');
  assert.equal(api.sent(/^\/users\/@me\/channels$/).length, 1);

  await adapter.sendFile('dm1', { name: 'report.pdf', bytes: Buffer.from('%PDF') });
  const upload = posts('dm1').at(-1)!;
  assert.match(String(upload.headers['content-type']), /^multipart\/form-data/);
  assert.match(upload.raw, /name="payload_json"\r\n\r\n\{"attachments":\[\{"id":0,"filename":"report\.pdf"\}\]/);
  assert.match(upload.raw, /name="files\[0\]"; filename="report\.pdf"/);
  await assert.rejects(adapter.sendFile('dm1', { name: 'huge.bin', bytes: Buffer.from('x') }), /大小限制/);

  await adapter.typing('dm1', true);
  await until(() => api.sent(/^\/channels\/dm1\/typing$/).length >= 3);
  await adapter.typing('dm1', false);
  await adapter.stop();
});

test('Discord approvals are buttons: a press is answered at once and rewrites the card', async (t) => {
  const api = await discordApi(t),
    seen = recorder(async (action) => (action.key.endsWith(':allow') ? '已允许' : undefined)),
    adapter = new DiscordAdapter(DISCORD_TOKEN, discordOptions(api));
  t.after(() => adapter.stop());
  adapter.start(seen.handlers);
  await until(() => seen.last() === 'connected');

  const handle = await adapter.sendCard('dm1', CARD);
  const card = api.sent(/^\/channels\/dm1\/messages$/)[0].body;
  assert.equal(card.content, '**研究员 请求本机权限**\n运行命令\n命令：npm test');
  assert.deepEqual(card.components, [
    {
      type: 1,
      components: [
        { type: 2, style: 1, label: '允许一次', custom_id: 'p:AB12:allow' },
        { type: 2, style: 4, label: '拒绝', custom_id: 'p:AB12:deny' },
      ],
    },
  ]);
  const [channel, message] = handle.split(':');
  const press = (id: string, key: string) =>
    api.dispatch(
      'INTERACTION_CREATE',
      {
        id,
        token: 'tok-' + id,
        type: 3,
        channel_id: channel,
        user: { id: '42', username: 'zhou' },
        message: { id: message, content: card.content },
        data: { custom_id: key, component_type: 2 },
      },
      9,
    );
  const answers = () => api.sent(/^\/interactions\//);
  press('i1', 'p:AB12:deny');
  await until(() => answers().length === 1);
  assert.deepEqual([answers()[0].path, answers()[0].body], ['/interactions/i1/tok-i1/callback', { type: 6 }]);
  assert.equal(answers()[0].headers.authorization, undefined, 'the callback is authorized by its own token');
  press('i2', 'p:AB12:allow');
  await until(() => answers().length === 2);
  assert.deepEqual(seen.actions.at(-1), { chatId: 'dm1', operator: { id: '42', name: 'zhou' }, key: 'p:AB12:allow' });
  assert.deepEqual(answers()[1].body, {
    type: 7,
    data: { content: card.content + '\n\n**已允许**', components: [] },
  });
  // The press rewrote the card; closing it again changes nothing.
  await adapter.closeCard(handle, CARD, '已允许');
  assert.equal(api.sent(/messages\//, 'PATCH').length, 0);

  // A card decided on the computer is rewritten by the outbox.
  const other = await adapter.sendCard('dm1', CARD);
  await adapter.closeCard(other, CARD, '已在电脑上处理');
  const patch = api.sent(/messages\//, 'PATCH')[0];
  assert.equal(patch.path, `/channels/dm1/messages/${other.split(':')[1]}`);
  assert.deepEqual(patch.body, { content: card.content + '\n\n**已在电脑上处理**', components: [] });
});

// ---------- Slack ----------

/** A Web API stand-in whose apps.connections.open points at a local Socket Mode server. */
async function slackApi(t: test.TestContext, extra: (method: string, request: Captured) => Reply | void = () => {}) {
  const acks: string[] = [];
  const socket = await gateway(t, (ws) => {
    ws.send(JSON.stringify({ type: 'hello', num_connections: 1 }));
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data));
      if (frame.envelope_id) acks.push(frame.envelope_id);
    });
  });
  const api = await listen(t, (request) => {
    const method = request.path.replace(/^\//, '');
    const special = extra(method, request);
    if (special) return special;
    if (method === 'auth.test')
      return { json: { ok: true, team: 'Acme', user: 'aelionbot', team_id: 'T1', user_id: 'UBOT', bot_id: 'B1' } };
    if (method === 'apps.connections.open') return { json: { ok: true, url: socket.url } };
    if (method === 'users.info')
      return { json: { ok: true, user: { name: 'zhou', profile: { display_name: '小周' } } } };
    if (method === 'chat.postMessage')
      return { json: { ok: true, channel: request.body.channel, ts: `1760000100.00${api.requests.length}` } };
    if (method === 'conversations.open') return { json: { ok: true, channel: { id: 'D-owner' } } };
    if (method === 'files.getUploadURLExternal')
      return { json: { ok: true, upload_url: api.url + '/upload/F1', file_id: 'F1' } };
    if (method.startsWith('upload/')) return { bytes: Buffer.from('OK') };
    if (method.startsWith('files/')) return { bytes: Buffer.from('slack-file') };
    return { json: { ok: true } };
  });
  const calls = (method: string) => api.requests.filter((request) => request.path === '/' + method);
  const envelope = (id: string, type: string, payload: object) =>
    socket.sockets.at(-1)!.send(JSON.stringify({ envelope_id: id, type, payload, accepts_response_payload: false }));
  return { ...api, sockets: socket.sockets, acks, calls, envelope };
}
const slackTokens = { appToken: 'xapp-1-A1-fixture', botToken: 'xoxb-fixture' };
const slackOptions = (api: { url: string }) => ({ apiBase: api.url, reconnectMs: () => 10, retryAfterMs: () => 5 });

test('the Slack adapter opens Socket Mode, acknowledges envelopes and maps direct messages', async (t) => {
  const api = await slackApi(t),
    seen = recorder(),
    adapter = new SlackAdapter(slackTokens, slackOptions(api));
  t.after(() => adapter.stop());
  adapter.start(seen.handlers);
  await until(() => seen.last() === 'connected');
  assert.equal(api.calls('apps.connections.open')[0].headers.authorization, 'Bearer xapp-1-A1-fixture');
  assert.equal(api.calls('auth.test')[0].headers.authorization, 'Bearer xoxb-fixture');

  const event = (fields: object) => ({ event: { type: 'message', channel_type: 'im', channel: 'D1', ...fields } });
  api.envelope('e1', 'events_api', event({ user: 'UBOT', bot_id: 'B1', text: '自己的回复', ts: '1760000001.000100' }));
  api.envelope('e2', 'events_api', event({ user: 'U1', subtype: 'message_changed', ts: '1760000002.000100' }));
  api.envelope('e3', 'events_api', {
    event: {
      type: 'message',
      channel_type: 'channel',
      channel: 'C1',
      user: 'U1',
      text: '频道里的',
      ts: '1760000003.000100',
    },
  });
  api.envelope(
    'e4',
    'events_api',
    event({
      user: 'U1',
      text: '看 <https://example.com|这里> 1 &lt; 2',
      ts: '1760000004.000200',
      subtype: 'file_share',
      files: [
        { id: 'F9', name: 'shot.png', mimetype: 'image/png', url_private_download: api.url + '/files/F9/shot.png' },
        {
          id: 'F10',
          name: 'clip.mp4',
          mimetype: 'audio/mp4',
          subtype: 'slack_audio',
          url_private: api.url + '/files/F10',
        },
      ],
    }),
  );
  await until(() => seen.messages.length === 1);
  await settle(40);
  assert.equal(seen.messages.length, 1, 'only what a person wrote to the app directly');
  assert.deepEqual(api.acks, ['e1', 'e2', 'e3', 'e4'], 'every envelope is acknowledged, served or not');
  const [message] = seen.messages;
  assert.deepEqual(
    { id: message.messageId, chat: message.chatId, sender: message.sender, text: message.text, group: message.isGroup },
    {
      id: 'D1:1760000004.000200',
      chat: 'D1',
      sender: { id: 'U1', name: '小周' },
      text: '看 这里 (https://example.com) 1 < 2',
      group: false,
    },
  );
  assert.equal(message.sentAt, 1_760_000_004_000);
  assert.equal(api.calls('users.info')[0].body.user, 'U1');
  assert.deepEqual(
    message.resources.map((resource) => [resource.kind, resource.name]),
    [
      ['image', 'shot.png'],
      ['audio', 'clip.mp4'],
    ],
  );
  const file = await message.resources[0].fetch(AbortSignal.timeout(5000));
  assert.equal(file.bytes.toString(), 'slack-file');
  assert.equal(
    api.requests.find((request) => request.path === '/files/F9/shot.png')!.headers.authorization,
    'Bearer xoxb-fixture',
    'private files download with the bot token',
  );

  // Slack retires a connection and says so first: a new one is opened at once.
  api.sockets[0].send(JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' }));
  await until(() => api.sockets.length === 2 && api.calls('apps.connections.open').length === 2);
  assert.deepEqual(
    seen.statuses.map((item) => item.status),
    ['connecting', 'connected'],
    'the connector stays up through the change: replies still go out over the Web API',
  );
});

test('Slack replies are mrkdwn, files upload in three steps and a reaction shows work in progress', async (t) => {
  let limited = 0;
  const api = await slackApi(t, (method, request) =>
    method === 'chat.postMessage' && request.body.text === '慢一点' && !limited++
      ? { status: 429, headers: { 'retry-after': '3' }, json: { ok: false, error: 'ratelimited' } }
      : undefined,
  );
  const seen = recorder(),
    adapter = new SlackAdapter(slackTokens, slackOptions(api));
  t.after(() => adapter.stop());
  adapter.start(seen.handlers);
  await until(() => seen.last() === 'connected');
  const posts = () => api.calls('chat.postMessage').map((request) => request.body);

  await adapter.sendText('D1', '这是**重点**，见[文档](https://example.com)');
  assert.deepEqual(posts()[0], {
    channel: 'D1',
    text: '这是 *重点*，见<https://example.com|文档>',
    mrkdwn: 'true',
    unfurl_links: 'false',
    unfurl_media: 'false',
  });
  await adapter.sendText('D1', Array.from({ length: 500 }, (_, index) => `第 ${index} 行的内容`).join('\n'));
  assert.ok(posts().length >= 3 && posts().every((post) => post.text.length <= 3600));
  await adapter.sendText('D1', '慢一点');
  assert.equal(posts().filter((post) => post.text === '慢一点').length, 2, 'sent again after the wait Slack asked for');

  // Only the owner's user ID is known: their direct messages are opened first.
  await adapter.sendText('U1', '你好');
  assert.equal(api.calls('conversations.open')[0].body.users, 'U1');
  assert.equal(posts().at(-1)!.channel, 'D-owner');

  await adapter.sendFile('D1', { name: '报告.pdf', bytes: Buffer.from('%PDF-1.7') });
  assert.deepEqual(api.calls('files.getUploadURLExternal')[0].body, { filename: '报告.pdf', length: '8' });
  assert.equal(api.requests.find((request) => request.path === '/upload/F1')!.raw, '%PDF-1.7');
  const shared = api.calls('files.completeUploadExternal')[0].body;
  assert.deepEqual([JSON.parse(shared.files), shared.channel_id], [[{ id: 'F1', title: '报告.pdf' }], 'D1']);

  // No message from the person yet: nothing to react to.
  await adapter.typing('D1', true);
  assert.equal(api.calls('reactions.add').length, 0);
  api.envelope('e1', 'events_api', {
    event: { type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: '开始吧', ts: '1760000009.000300' },
  });
  await until(() => seen.messages.length === 1);
  await adapter.typing('D1', true);
  await adapter.typing('D1', true);
  assert.deepEqual(
    api.calls('reactions.add').map((request) => request.body),
    [{ channel: 'D1', timestamp: '1760000009.000300', name: 'eyes' }],
  );
  await adapter.typing('D1', false);
  assert.deepEqual(api.calls('reactions.remove')[0].body, {
    channel: 'D1',
    timestamp: '1760000009.000300',
    name: 'eyes',
  });
});

test('Slack approvals are Block Kit buttons, decided through an interactive envelope', async (t) => {
  const api = await slackApi(t),
    seen = recorder(async (action) => (action.key.endsWith(':allow') ? '已允许' : undefined)),
    adapter = new SlackAdapter(slackTokens, slackOptions(api));
  t.after(() => adapter.stop());
  adapter.start(seen.handlers);
  await until(() => seen.last() === 'connected');

  const handle = await adapter.sendCard('D1', CARD);
  const sent = api.calls('chat.postMessage')[0].body,
    blocks = JSON.parse(sent.blocks);
  assert.equal(sent.text, '研究员 请求本机权限');
  assert.deepEqual(blocks[0], {
    type: 'section',
    text: { type: 'mrkdwn', text: '*研究员 请求本机权限*\n运行命令\n命令：npm test' },
  });
  assert.deepEqual(
    blocks[1].elements.map((item: any) => [item.type, item.text.text, item.value, item.style, item.action_id]),
    [
      ['button', '允许一次', 'p:AB12:allow', 'primary', 'aelion_0'],
      ['button', '拒绝', 'p:AB12:deny', 'danger', 'aelion_1'],
    ],
  );
  const [channel, ts] = [handle.slice(0, handle.indexOf(':')), handle.slice(handle.indexOf(':') + 1)];
  const press = (id: string, value: string) =>
    api.envelope(id, 'interactive', {
      type: 'block_actions',
      user: { id: 'U1', username: 'zhou' },
      container: { type: 'message', channel_id: channel, message_ts: ts },
      actions: [{ type: 'button', action_id: 'aelion_0', value }],
    });
  press('i1', 'p:AB12:deny');
  await until(() => seen.actions.length === 1);
  press('i2', 'p:AB12:allow');
  await until(() => api.calls('chat.update').length === 1);
  assert.deepEqual(api.acks, ['i1', 'i2']);
  assert.deepEqual(seen.actions.at(-1), { chatId: 'D1', operator: { id: 'U1', name: 'zhou' }, key: 'p:AB12:allow' });
  const update = api.calls('chat.update')[0].body,
    updated = JSON.parse(update.blocks);
  assert.deepEqual([update.channel, update.ts, updated.length], ['D1', ts, 1], 'the buttons are gone');
  assert.ok(updated[0].text.text.endsWith('\n\n*已允许*'));
  await adapter.closeCard(handle, CARD, '已允许');
  assert.equal(api.calls('chat.update').length, 1, 'a card its own button closed is not rewritten again');

  const other = await adapter.sendCard('D1', CARD);
  await adapter.closeCard(other, CARD, '已在电脑上处理');
  assert.ok(JSON.parse(api.calls('chat.update')[1].body.blocks)[0].text.text.endsWith('\n\n*已在电脑上处理*'));
});

test('Slack reports revoked tokens and keeps retrying a connection that fails', async (t) => {
  const revoked = await slackApi(t, (method) =>
    method === 'apps.connections.open' ? { json: { ok: false, error: 'invalid_auth' } } : undefined,
  );
  const first = recorder(),
    rejected = new SlackAdapter(slackTokens, slackOptions(revoked));
  t.after(() => rejected.stop());
  rejected.start(first.handlers);
  await until(() => first.last() === 'needs-config');
  await settle(60);
  assert.equal(revoked.calls('apps.connections.open').length, 1, 'tokens that were refused are not tried again');

  let failures = 2;
  const flaky = await slackApi(t, (method) =>
    method === 'apps.connections.open' && failures-- > 0
      ? { status: 500, json: { ok: false, error: 'fatal_error' } }
      : undefined,
  );
  const second = recorder(),
    patient = new SlackAdapter(slackTokens, slackOptions(flaky));
  t.after(() => patient.stop());
  patient.start(second.handlers);
  await until(() => second.last() === 'connected');
  assert.equal(flaky.calls('apps.connections.open').length, 3);
});

// ---------- Messages sent while the app was not connected ----------

test('Discord reads what was written while no session was up, oldest first, from where it left off', async (t) => {
  const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString(),
    author = { id: '42', username: 'zhou' };
  const api = await discordApi(t, (request) =>
    request.method === 'GET' && request.path.startsWith('/channels/dm1/messages')
      ? {
          // Newest first, as Discord lists a channel.
          json: [
            { id: '104', channel_id: 'dm1', author, content: '第二条', timestamp: ago(60) },
            {
              id: '103',
              channel_id: 'dm1',
              author: { id: '999', bot: true },
              content: '机器人自己的',
              timestamp: ago(90),
            },
            { id: '102', channel_id: 'dm1', author, content: '第一条', timestamp: ago(120) },
            { id: '101', channel_id: 'dm1', author, content: '前天的', timestamp: ago(2 * 24 * 3600) },
          ],
        }
      : undefined,
  );
  const seen = recorder(),
    adapter = new DiscordAdapter(DISCORD_TOKEN, discordOptions(api), { dm1: '100' });
  t.after(() => adapter.stop());
  adapter.start(seen.handlers);
  await until(() => seen.messages.length === 2);
  assert.equal(api.sent(/^\/channels\/dm1\/messages/, 'GET')[0].path, '/channels/dm1/messages?after=100&limit=50');
  assert.deepEqual(
    seen.messages.map((message) => [message.messageId, message.text]),
    [
      ['102', '第一条'],
      ['104', '第二条'],
    ],
    'a request from days ago is left alone',
  );
  assert.deepEqual(JSON.parse(seen.states.at(-1)!.seen), { dm1: '104' }, 'kept for the next start');

  // A live message moves the mark on; a resumed session replays by itself and reads no history.
  api.dispatch('MESSAGE_CREATE', { id: '105', channel_id: 'dm1', author, content: '在线时的' }, 3);
  await until(() => seen.messages.length === 3);
  assert.deepEqual(JSON.parse(seen.states.at(-1)!.seen), { dm1: '105' });
  api.sockets[0].close(1001);
  await until(() => resumes(api).length === 1 && api.sockets.length === 2);
  await settle(60);
  assert.equal(api.sent(/^\/channels\/dm1\/messages/, 'GET').length, 1);
});

test('Slack reads what was written while it was not connected, and not after a requested refresh', async (t) => {
  const stamp = (secondsAgo: number) => (Date.now() / 1000 - secondsAgo).toFixed(6),
    [last, first, reply, second] = [stamp(600), stamp(120), stamp(90), stamp(60)];
  const api = await slackApi(t, (method) =>
    method === 'conversations.history'
      ? {
          json: {
            ok: true,
            // Newest first, as Slack lists a conversation.
            messages: [
              { type: 'message', user: 'U1', text: '第二条', ts: second },
              { type: 'message', user: 'UBOT', bot_id: 'B1', text: '应用自己的', ts: reply },
              { type: 'message', user: 'U1', text: '第一条', ts: first },
            ],
          },
        }
      : undefined,
  );
  const seen = recorder(),
    adapter = new SlackAdapter(slackTokens, slackOptions(api), { D1: last });
  t.after(() => adapter.stop());
  adapter.start(seen.handlers);
  await until(() => seen.messages.length === 2);
  assert.deepEqual(api.calls('conversations.history')[0].body, { channel: 'D1', oldest: last, limit: '50' });
  assert.deepEqual(
    seen.messages.map((message) => [message.messageId, message.chatId, message.text]),
    [
      [`D1:${first}`, 'D1', '第一条'],
      [`D1:${second}`, 'D1', '第二条'],
    ],
  );
  assert.deepEqual(JSON.parse(seen.states.at(-1)!.seen), { D1: second }, 'kept for the next start');

  api.sockets[0].send(JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' }));
  await until(() => api.sockets.length === 2);
  await settle(60);
  assert.equal(api.calls('conversations.history').length, 1);
  // A connection that dropped by itself may have lost messages: the history is read again.
  api.sockets[1].close(1011);
  await until(() => api.calls('conversations.history').length === 2);
});

// ---------- The hub ----------

class FakeAdapter implements ConnectorAdapter {
  handlers?: AdapterHandlers;
  texts: Array<{ chatId: string; text: string }> = [];
  constructor(readonly platform: ConnectorPlatform) {}
  start(handlers: AdapterHandlers) {
    this.handlers = handlers;
    handlers.status('connected');
  }
  async stop() {}
  async sendText(chatId: string, text: string) {
    this.texts.push({ chatId, text });
  }
  async sendFile() {}
}
function hub(t: test.TestContext, overrides: Partial<ConnectorDeps>) {
  const dir = tempDir(t),
    store = new Store(dir),
    sent: Array<Parameters<ConnectorDeps['send']>[0]> = [];
  const connectors: Connectors = new Connectors({
    store,
    dataDir: dir,
    codec: {
      encrypt: (value) => Buffer.from(value).toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
    },
    version: '0.0.0-test',
    attachments: new Attachments(store),
    send: (input) => void sent.push(input),
    cancel: () => {},
    isRunning: () => false,
    setPermission: () => {},
    interactions: new Interactions(() => connectors.interactionsChanged()),
    changed: () => {},
    lark: () => {
      throw new Error('no SDK in tests');
    },
    ...overrides,
  });
  t.after(() => connectors.dispose());
  return { store, bot: store.data.bots[0], connectors, sent };
}

test('adding a Telegram, Discord or Slack connector checks the tokens with the platform and names the account', async (t) => {
  const asked: string[] = [];
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    asked.push(url.replace(TELEGRAM_TOKEN, '<token>'));
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (url.endsWith('/getMe'))
      return url.includes(TELEGRAM_TOKEN)
        ? json({ ok: true, result: { id: 123456789, is_bot: true, first_name: '研究员', username: 'aelion_test_bot' } })
        : json({ ok: false, error_code: 401, description: 'Unauthorized' }, 401);
    if (url.endsWith('/users/@me'))
      return json({ id: '112233445566778899', username: 'aelion', discriminator: '0420', bot: true });
    if (url.endsWith('/auth.test'))
      return String((init?.headers as Record<string, string> | undefined)?.Authorization).endsWith('xoxb-good')
        ? json({ ok: true, team: 'Acme', user: 'aelionbot', team_id: 'T1', user_id: 'UBOT' })
        : json({ ok: false, error: 'invalid_auth' });
    if (url.endsWith('/apps.connections.open')) return json({ ok: true, url: 'wss://unused.test' });
    return json({});
  }) as typeof fetch;
  const adapters: FakeAdapter[] = [];
  const { bot, connectors } = hub(t, {
    fetch: fetcher,
    createAdapter: (connector) => {
      adapters.push(new FakeAdapter(connector.platform));
      return adapters.at(-1)!;
    },
  });
  const add = (credentials: Parameters<Connectors['add']>[0]['credentials']) =>
    connectors.add({ botId: bot.id, permissionMode: 'ask', credentials });

  await add({ platform: 'telegram', token: ` ${TELEGRAM_TOKEN} ` });
  await add({ platform: 'discord', token: DISCORD_TOKEN });
  await add({ platform: 'slack', appToken: 'xapp-1-A1-good', botToken: 'xoxb-good' });
  assert.deepEqual(
    connectors.snapshot().connectors.map((connector) => [connector.platform, connector.account, connector.status]),
    [
      ['telegram', '@aelion_test_bot', 'connected'],
      ['discord', 'aelion#0420', 'connected'],
      ['slack', 'Acme · aelionbot', 'connected'],
    ],
  );
  assert.ok(asked.includes('https://api.telegram.org/bot<token>/getMe'));
  assert.ok(asked.includes('https://discord.com/api/v10/users/@me'));
  assert.ok(asked.includes('https://slack.com/api/auth.test'));

  await assert.rejects(async () => add({ platform: 'telegram', token: TELEGRAM_TOKEN }), {
    code: 'connector.duplicate',
  });
  await assert.rejects(async () => add({ platform: 'telegram', token: 'pasted the wrong thing' }), {
    code: 'connector.credentials_invalid',
  });
  await assert.rejects(
    async () => add({ platform: 'telegram', token: token('987654321:', 'AAHk3-another_fixture_token_value_xx') }),
    {
      code: 'connector.credentials_invalid',
    },
  );
  await assert.rejects(async () => add({ platform: 'discord', token: 'xoxb-not-a-discord-token' }), {
    code: 'connector.credentials_invalid',
  });
  // The two Slack tokens the wrong way round, and a bot token Slack refuses.
  await assert.rejects(async () => add({ platform: 'slack', appToken: 'xoxb-good', botToken: 'xapp-1-A1-good' }), {
    code: 'connector.credentials_invalid',
  });
  await assert.rejects(async () => add({ platform: 'slack', appToken: 'xapp-1-A1-good', botToken: 'xoxb-revoked' }), {
    code: 'connector.credentials_invalid',
  });
  assert.equal(connectors.snapshot().connectors.length, 3);

  // A first private message pairs like on every platform; the session is named after the platform.
  const telegram = adapters[0];
  telegram.handlers!.message({
    messageId: '1001:1',
    chatId: '1001',
    isGroup: false,
    sender: { id: '1001', name: 'Li Zhou' },
    text: '/help',
    resources: [],
    sentAt: Date.now(),
  });
  await until(() => telegram.texts.length === 1);
  assert.match(telegram.texts[0].text, /配对码：\d{6}/);
});

test('a Telegram connector runs its real adapter through the hub: pairing code out, messages in', async (t) => {
  const api = await telegramApi(t, (method) =>
    method === 'getMe' ? { json: { ok: true, result: { id: 123456789, username: 'aelion_test_bot' } } } : undefined,
  );
  // The hub talks to api.telegram.org; requests are sent to the stand-in instead.
  const fetcher = ((input: URL | string, init?: RequestInit) =>
    fetch(String(input).replace('https://api.telegram.org', api.url), init)) as typeof fetch;
  const { store, bot, connectors, sent } = hub(t, { fetch: fetcher });
  const id = await connectors.add({
    botId: bot.id,
    permissionMode: 'ask',
    credentials: { platform: 'telegram', token: TELEGRAM_TOKEN },
  });
  await until(() => connectors.snapshot().connectors[0].status === 'connected');

  api.queue.push(telegramMessage(1, { text: '/start' }));
  await until(() => api.calls('sendMessage').length === 1);
  const code = /配对码：(\d{6})/.exec(api.calls('sendMessage')[0].body.text)?.[1];
  assert.ok(code, api.calls('sendMessage')[0].body.text);
  assert.equal(api.calls('sendMessage')[0].body.chat_id, 1001);
  await connectors.decidePairing({ id, code, allow: true });
  assert.deepEqual(connectors.snapshot().connectors[0].owner, { id: '1001', name: 'Li Zhou' });

  api.queue.push(telegramMessage(2, { text: '整理一下今天的邮件' }));
  await until(() => sent.length === 1);
  assert.equal(sent[0].message, '整理一下今天的邮件');
  assert.deepEqual(
    { platform: sent[0].connector.platform, messageId: sent[0].connector.messageId, owner: sent[0].connector.owner },
    { platform: 'telegram', messageId: '1001:2', owner: true },
  );
  assert.equal(store.data.workSessions?.find((session) => session.id === sent[0].sessionId)?.name, 'Telegram');
  // The offset survives a restart of the adapter: the hub keeps it with the connector.
  await until(() => connectors.saved.get(id)?.state?.offset === '3');
  assert.equal(connectors.saved.get(id)?.state?.uid, '123456789');
});
