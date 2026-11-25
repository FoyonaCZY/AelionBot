// Slack in Socket Mode: the app opens a WebSocket (no public address) with its app-level token, acknowledges every
// envelope, and answers through the Web API with its bot token. Only direct messages to the app are served. Slack has
// no typing cue for apps, so an "eyes" reaction on the person's message stands in for one.
import WebSocket from 'ws';
import type {
  AdapterHandlers,
  ConnectorAdapter,
  ConnectorCard,
  ConnectorTextStream,
  InboundMessage,
  InboundResource,
} from '../connector-adapter';
import type { ConnectorStatus } from '../../../../shared/types/connector-types';
import { AppError } from '../../../../shared/errors';
import { escapeMarkup, slackMrkdwn, slackPlain, splitMarkdown } from '../markdown';
import { pause } from './timing';

const API_BASE = 'https://slack.com/api';
/** Slack takes far longer messages, but shows the long ones collapsed. */
const TEXT_CHARS = 3500;
const PING_MS = 30_000;
const STREAM_INTERVAL_MS = 1000;
const CUE = 'eyes';
/** Answers that mean a token will not work again. */
const AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive']);
const INVALID_TOKENS = 'Slack 的 token 无效或已撤销，请删除后重新添加';
/** Chats whose last message is remembered, and how far back missed messages are still worth answering. */
const CHATS_KEPT = 30;
const MISSED_MS = 24 * 3600_000;

export interface SlackCredentials {
  /** The app-level token (xapp-) that opens the Socket Mode connection. */
  appToken: string;
  /** The bot token (xoxb-) that sends messages and reads files. */
  botToken: string;
}
export interface SlackOptions {
  fetch?: typeof fetch;
  /** https://slack.com/api, or a test server. */
  apiBase?: string;
  reconnectMs?: (attempt: number) => number;
  /** How long a "retry after N seconds" answer waits. */
  retryAfterMs?: (seconds: number) => number;
  pingMs?: number;
  streamIntervalMs?: number;
}

class SlackError extends Error {
  constructor(
    /** Slack's error word, such as `missing_scope`. */
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function issue(data: any) {
  const code = String(data?.error || 'unknown');
  if (code === 'missing_scope')
    return `Slack 应用缺少权限${data?.needed ? ' ' + data.needed : ''}，请在应用的 OAuth & Permissions 里补上后重新安装`;
  if (AUTH_ERRORS.has(code)) return INVALID_TOKENS;
  if (code === 'channel_not_found' || code === 'not_in_channel') return 'Slack 里找不到这个对话';
  return `Slack 返回错误 ${code}`;
}

/** One Web API call, form-encoded as every method accepts; a rate-limited one waits as long as Slack asks. */
async function request(
  options: SlackOptions,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  halt?: AbortSignal,
) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined) body.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await (options.fetch || fetch)(`${options.apiBase || API_BASE}/${method}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new Error('连不上 Slack，请检查网络', { cause: error });
    }
    if (response.status === 429 && attempt < 3) {
      const seconds = Number(response.headers.get('retry-after')) || 1;
      await pause(Math.min(60_000, options.retryAfterMs?.(seconds) ?? seconds * 1000), halt);
      if (halt?.aborted) throw new Error('连接器已停止');
      continue;
    }
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new SlackError('http_' + response.status, `Slack 接口错误 ${response.status}`);
    }
    if (!data?.ok) throw new SlackError(String(data?.error || 'unknown'), issue(data));
    return data;
  }
}

/** Which workspace and app the tokens belong to, asked of Slack: the check before a connector is saved. */
export async function slackIdentity(credentials: SlackCredentials, options: SlackOptions = {}) {
  const invalid = (message: string, cause?: unknown) =>
    new AppError('connector.credentials_invalid', message, cause ? { cause } : undefined);
  if (!credentials.appToken.startsWith('xapp-'))
    throw invalid('App Token 以 xapp- 开头，在应用的 Basic Information → App-Level Tokens 里生成');
  if (!credentials.botToken.startsWith('xoxb-')) throw invalid('Bot Token 以 xoxb- 开头，在应用的 Install App 页复制');
  const ask = async (token: string, method: string, name: string) => {
    try {
      return await request(options, token, method);
    } catch (error) {
      if (!(error instanceof SlackError)) throw new AppError('connector.unreachable', (error as Error).message);
      if (AUTH_ERRORS.has(error.code)) throw invalid(`Slack 不认这个 ${name}，请重新复制`, error);
      throw invalid(`${name}：${error.message}`, error);
    }
  };
  const auth = await ask(credentials.botToken, 'auth.test', 'Bot Token');
  // Opening a connection address proves the app-level token and that Socket Mode is on; it is not used.
  await ask(credentials.appToken, 'apps.connections.open', 'App Token');
  return {
    id: `${auth.team_id}:${auth.user_id}`,
    team: String(auth.team || ''),
    user: String(auth.user || ''),
  };
}

/** A card as Block Kit: its text, and a row of buttons until it is decided. */
function cardBlocks(card: ConnectorCard, result?: string) {
  const text =
    `*${escapeMarkup(card.title)}*\n${escapeMarkup(card.lines.join('\n'))}`.slice(0, 2800) +
    (result ? `\n\n*${escapeMarkup(result)}*` : '');
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    ...(result
      ? []
      : [
          {
            type: 'actions',
            elements: card.buttons.slice(0, 25).map((button, index) => ({
              type: 'button',
              action_id: 'aelion_' + index,
              text: { type: 'plain_text', text: button.label.slice(0, 75), emoji: true },
              value: button.key,
              ...(button.style ? { style: button.style } : {}),
            })),
          },
        ]),
  ];
}

export class SlackAdapter implements ConnectorAdapter {
  readonly platform = 'slack' as const;
  private handlers?: AdapterHandlers;
  private ws?: WebSocket;
  private halt?: AbortController;
  private last?: string;
  private attempts = 0;
  /** A connection has been up since start(). */
  private ready = false;
  /** Slack asked for a fresh connection, which is opened without the usual wait. */
  private refresh = false;
  /** What keeps the connection from working, shown until it works again. */
  private blocked?: string;
  /** The app's own user ID; its messages come back as events too. */
  private self?: string;
  private retry?: ReturnType<typeof setTimeout>;
  private ping?: ReturnType<typeof setInterval>;
  private heard = 0;
  /** Events are handled in order, each after the previous one's sender was looked up. */
  private queue: Promise<unknown> = Promise.resolve();
  private names = new Map<string, string>();
  /**
   * The person's latest message per chat. It carries the working cue, and marks where to read on from: Slack keeps
   * events only briefly for an app that is not connected, so after a gap later messages come from the chat's history.
   */
  private latest: Map<string, string>;
  private cues = new Map<string, Promise<string | undefined>>();
  /** Direct-message channels opened for people known only by their user ID. */
  private channels = new Map<string, string>();
  private cards = new Map<string, ConnectorCard>();
  /** Cards whose button press is being decided; the press rewrites them itself. */
  private pressing = new Set<string>();
  constructor(
    private credentials: SlackCredentials,
    private options: SlackOptions = {},
    latest: Record<string, string> = {},
  ) {
    this.latest = new Map(Object.entries(latest));
  }
  start(handlers: AdapterHandlers) {
    this.handlers = handlers;
    this.halt?.abort();
    this.halt = new AbortController();
    this.last = undefined;
    this.ready = false;
    this.attempts = 0;
    void this.connect(this.halt.signal);
  }
  private status(status: ConnectorStatus, text?: string) {
    const key = status + '\0' + (text || '');
    if (key === this.last) return;
    this.last = key;
    this.handlers?.status(status, text);
  }
  private api(method: string, params?: Record<string, unknown>) {
    return request(this.options, this.credentials.botToken, method, params, this.halt?.signal);
  }
  private again(halt: AbortSignal) {
    const delay = this.refresh
      ? 0
      : (this.options.reconnectMs?.(this.attempts) ?? Math.min(30_000, 1000 * 2 ** this.attempts));
    if (!this.refresh) this.attempts++;
    this.refresh = false;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect(halt), delay);
  }
  private async connect(halt: AbortSignal) {
    if (halt.aborted) return;
    // A requested refresh and the first reconnect after a drop are quiet: sending goes through the Web API and still
    // works meanwhile.
    const failing = this.attempts > 3 || Boolean(this.blocked);
    if (!this.ready || this.attempts > 1 || failing)
      this.status(failing ? 'error' : 'connecting', failing ? this.blocked || '连不上 Slack，正在重试' : undefined);
    let url: string;
    try {
      this.self ??= String((await this.api('auth.test')).user_id || '');
      url = String((await request(this.options, this.credentials.appToken, 'apps.connections.open', {}, halt)).url);
    } catch (error) {
      if (halt.aborted) return;
      if (error instanceof SlackError && AUTH_ERRORS.has(error.code))
        return this.status('needs-config', INVALID_TOKENS);
      this.status(this.attempts > 3 ? 'error' : 'connecting', (error as Error).message);
      return this.again(halt);
    }
    if (halt.aborted) return;
    const ws = new WebSocket(url, { handshakeTimeout: 20_000 });
    this.ws = ws;
    this.heard = Date.now();
    ws.on('message', (data) => {
      this.heard = Date.now();
      let payload: any;
      try {
        payload = JSON.parse(String(data));
      } catch {
        return;
      }
      if (this.ws === ws) this.receive(ws, payload);
    });
    ws.on('ping', () => (this.heard = Date.now()));
    ws.on('pong', () => (this.heard = Date.now()));
    ws.on('error', () => {});
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      clearInterval(this.ping);
      if (!halt.aborted) this.again(halt);
    });
    // A connection that went quiet without closing is replaced.
    const every = this.options.pingMs ?? PING_MS;
    clearInterval(this.ping);
    this.ping = setInterval(() => {
      if (Date.now() - this.heard > every * 2.5) return ws.terminate();
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, every);
    this.ping.unref?.();
  }
  private receive(ws: WebSocket, payload: any) {
    if (payload.type === 'hello') {
      // After a start or a dropped connection messages may have been missed; a requested refresh loses none.
      const gap = !this.ready || this.attempts > 0;
      this.attempts = 0;
      this.blocked = undefined;
      this.ready = true;
      this.status('connected');
      if (gap) void this.missed();
      return;
    }
    if (payload.type === 'disconnect') {
      // Slack retires connections now and then and says so first; "link_disabled" means Socket Mode was turned off.
      if (payload.reason === 'link_disabled') {
        this.blocked = 'Slack 应用关闭了 Socket Mode，请在应用设置里重新打开';
        this.attempts = Math.max(this.attempts, 5);
      } else this.refresh = true;
      return ws.close();
    }
    // Every envelope is acknowledged at once; Slack sends an unacknowledged one again.
    if (payload.envelope_id) ws.send(JSON.stringify({ envelope_id: payload.envelope_id }));
    const work =
      payload.type === 'events_api'
        ? () => this.event(payload.payload?.event)
        : payload.type === 'interactive'
          ? () => this.pressed(payload.payload)
          : undefined;
    if (work) this.queue = this.queue.then(work).catch(() => {});
  }
  private async event(event: any) {
    if (event?.type !== 'message' || event.channel_type !== 'im' || !event.user || !event.channel || !event.ts) return;
    // The app's own messages, and edits, deletions and joins, which arrive as subtypes.
    if (event.bot_id || event.user === this.self || (event.subtype && event.subtype !== 'file_share')) return;
    const chatId = String(event.channel),
      resources: InboundResource[] = [];
    if (!(Number(this.latest.get(chatId)) >= Number(event.ts))) {
      this.latest.delete(chatId);
      this.latest.set(chatId, String(event.ts));
      if (this.latest.size > CHATS_KEPT) this.latest.delete(this.latest.keys().next().value!);
      this.handlers?.state?.({ seen: JSON.stringify(Object.fromEntries(this.latest)) });
    }
    for (const file of Array.isArray(event.files) ? event.files : []) {
      if (!file?.id || file.mode === 'tombstone' || file.mode === 'hidden_by_limit') continue;
      const type = String(file.mimetype || ''),
        name = String(file.name || file.title || `file-${file.id}`);
      resources.push({
        // A clip recorded in Slack is speech to put into words; an audio file someone attached is a file.
        kind:
          file.subtype === 'slack_audio'
            ? 'audio'
            : type.startsWith('image/')
              ? 'image'
              : type.startsWith('video/')
                ? 'video'
                : 'file',
        name,
        fetch: (signal) => this.download(file, name, signal),
      });
    }
    const name = await this.name(String(event.user));
    const message: InboundMessage = {
      messageId: `${chatId}:${event.ts}`,
      chatId,
      isGroup: false,
      sender: { id: String(event.user), ...(name ? { name } : {}) },
      text: slackPlain(String(event.text || '')).trim(),
      resources,
      sentAt: Math.round(Number(event.ts) * 1000) || Date.now(),
    };
    this.handlers?.message(message);
  }
  /** What people wrote while the app was not connected, oldest first. The hub skips any it has handled already. */
  private async missed() {
    // A copy: every message read moves its chat's mark, which changes the map.
    for (const [channel, last] of Array.from(this.latest))
      try {
        const history = await this.api('conversations.history', { channel, oldest: last, limit: 50 });
        const messages: any[] = (Array.isArray(history.messages) ? history.messages : []).filter(
          (item: any) => item?.ts && item.ts !== last && Date.now() - Number(item.ts) * 1000 < MISSED_MS,
        );
        messages.sort((a, b) => Number(a.ts) - Number(b.ts));
        for (const item of messages)
          this.queue = this.queue
            .then(() => this.event({ ...item, type: 'message', channel, channel_type: 'im' }))
            .catch(() => {});
      } catch {
        /* A chat that can no longer be read is skipped; new messages still arrive live. */
      }
  }
  /** The bot token goes only to Slack's own hosts (or the test server standing in for them). */
  private trusted(url: URL) {
    return (
      (url.protocol === 'https:' && /(^|\.)(slack\.com|slack-files\.com)$/.test(url.hostname)) ||
      Boolean(this.options.apiBase && url.host === new URL(this.options.apiBase).host)
    );
  }
  private async download(file: any, name: string, signal: AbortSignal) {
    let url: URL;
    try {
      url = new URL(String(file.url_private_download || file.url_private));
    } catch {
      throw new Error('Slack 没有给出文件地址');
    }
    const response = await (this.options.fetch || fetch)(url, {
      headers: this.trusted(url) ? { Authorization: `Bearer ${this.credentials.botToken}` } : {},
      signal,
    });
    if (!response.ok) throw new Error(`Slack 文件下载失败（${response.status}）`);
    // Without files:read Slack answers with its sign-in page instead of the file.
    if (/^text\/html/i.test(response.headers.get('content-type') || '') && !/html/i.test(String(file.mimetype || '')))
      throw new Error('Slack 文件下载失败，请确认应用有 files:read 权限');
    return { name, bytes: Buffer.from(await response.arrayBuffer()) };
  }
  /** A person's display name; Slack events carry only the user ID. */
  private async name(userId: string) {
    if (!this.names.has(userId))
      try {
        const user = (await this.api('users.info', { user: userId })).user;
        this.names.set(userId, String(user?.profile?.display_name || user?.real_name || user?.name || ''));
      } catch {
        this.names.set(userId, '');
      }
    return this.names.get(userId) || undefined;
  }
  private async pressed(payload: any) {
    if (payload?.type !== 'block_actions') return;
    const action = payload.actions?.[0],
      channel = String(payload.container?.channel_id || payload.channel?.id || ''),
      ts = String(payload.container?.message_ts || payload.message?.ts || '');
    if (!action?.value || !channel || !ts || !payload.user?.id) return;
    const handle = `${channel}:${ts}`,
      card = this.cards.get(handle),
      name = payload.user.name || payload.user.username;
    let result: string | undefined;
    this.pressing.add(handle);
    try {
      result = await this.handlers?.action({
        chatId: channel,
        operator: { id: String(payload.user.id), ...(name ? { name: String(name) } : {}) },
        key: String(action.value),
      });
    } catch {
      /* A press that could not be decided leaves the card as it is. */
    }
    this.pressing.delete(handle);
    if (!result) return;
    this.cards.delete(handle);
    await this.api('chat.update', {
      channel,
      ts,
      text: card?.title || result,
      blocks: card
        ? cardBlocks(card, result)
        : [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `${String(payload.message?.text || '').slice(0, 2800)}\n\n*${escapeMarkup(result)}*`.trim(),
              },
            },
          ],
    }).catch(() => {});
  }
  async stop() {
    this.halt?.abort();
    clearTimeout(this.retry);
    clearInterval(this.ping);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
  }
  /** The channel to post in: the one a person wrote in, or their direct messages when only their ID is known. */
  private async channel(chatId: string) {
    if (!/^[UW]/.test(chatId)) return chatId;
    if (!this.channels.has(chatId))
      this.channels.set(chatId, String((await this.api('conversations.open', { users: chatId })).channel.id));
    return this.channels.get(chatId)!;
  }
  async sendText(chatId: string, text: string) {
    const channel = await this.channel(chatId);
    for (const part of splitMarkdown(text, TEXT_CHARS))
      await this.api('chat.postMessage', {
        channel,
        text: slackMrkdwn(part) || part,
        mrkdwn: true,
        unfurl_links: false,
        unfurl_media: false,
      });
  }
  /** Streams a reply in place with `chat.postMessage` + `chat.update`, throttled within Slack's Tier 3 rate limit. */
  beginStream(chatId: string): ConnectorTextStream {
    const intervalMs = this.options.streamIntervalMs ?? STREAM_INTERVAL_MS;
    const sent: Array<{ channel: string; ts: string; content: string }> = [];
    let finished = false;
    const sync = async (text: string) => {
      const channel = await this.channel(chatId),
        parts = splitMarkdown(text, TEXT_CHARS);
      for (let index = 0; index < parts.length; index++) {
        const formatted = slackMrkdwn(parts[index]) || parts[index];
        if (!sent[index]) {
          const posted = await this.api('chat.postMessage', {
            channel,
            text: formatted,
            mrkdwn: true,
            unfurl_links: false,
            unfurl_media: false,
          });
          sent.push({ channel: String(posted.channel || channel), ts: String(posted.ts), content: formatted });
        } else if (sent[index].content !== formatted) {
          await this.api('chat.update', {
            channel: sent[index].channel,
            ts: sent[index].ts,
            text: formatted,
          });
          sent[index].content = formatted;
        }
      }
    };
    return {
      intervalMs,
      update: async (text: string) => {
        if (finished || !text.trim()) return;
        await sync(text);
      },
      finish: async (text: string) => {
        if (finished) return;
        finished = true;
        const final = text.trim();
        if (!final) return;
        if (!sent.length) await this.sendText(chatId, final);
        else await sync(final);
      },
    };
  }
  /** Slack's upload in three steps: ask for an address, send the bytes there, then share the file in the chat. */
  async sendFile(chatId: string, file: { name: string; bytes: Buffer }) {
    const channel = await this.channel(chatId),
      upload = await this.api('files.getUploadURLExternal', { filename: file.name, length: file.bytes.length });
    const response = await (this.options.fetch || fetch)(String(upload.upload_url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(file.bytes),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`Slack 文件上传失败（${response.status}）`);
    await this.api('files.completeUploadExternal', {
      files: [{ id: upload.file_id, title: file.name }],
      channel_id: channel,
    });
  }
  async sendCard(chatId: string, card: ConnectorCard) {
    const sent = await this.api('chat.postMessage', {
      channel: await this.channel(chatId),
      text: card.title,
      blocks: cardBlocks(card),
    });
    const handle = `${sent.channel}:${sent.ts}`;
    this.cards.set(handle, card);
    if (this.cards.size > 200) this.cards.delete(this.cards.keys().next().value!);
    return handle;
  }
  async closeCard(handle: string, card: ConnectorCard, result: string) {
    // A card closed by its own button is rewritten when the press is answered.
    if (this.pressing.has(handle) || !this.cards.delete(handle)) return;
    const cut = handle.indexOf(':');
    await this.api('chat.update', {
      channel: handle.slice(0, cut),
      ts: handle.slice(cut + 1),
      text: card.title,
      blocks: cardBlocks(card, result),
    });
  }
  /** Shows work in progress as a reaction on the person's latest message, and takes it away afterwards. */
  async typing(chatId: string, active: boolean) {
    const channel = this.channels.get(chatId) || chatId;
    if (active) {
      const ts = this.latest.get(channel);
      if (!ts || this.cues.has(channel)) return;
      this.cues.set(
        channel,
        this.api('reactions.add', { channel, timestamp: ts, name: CUE }).then(
          () => ts,
          () => undefined,
        ),
      );
      await this.cues.get(channel);
      return;
    }
    const cue = this.cues.get(channel);
    this.cues.delete(channel);
    const ts = await cue;
    if (ts) await this.api('reactions.remove', { channel, timestamp: ts, name: CUE });
  }
}
