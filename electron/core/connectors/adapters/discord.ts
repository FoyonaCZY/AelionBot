// Discord through its Gateway (a WebSocket the app opens, with heartbeats and session resume) for direct messages and
// button presses, and the REST API for everything sent. Servers are not served: only the DIRECT_MESSAGES intent is
// asked for, which needs no privileged access and delivers the content of messages sent to the bot itself.
import WebSocket from 'ws';
import type {
  AdapterHandlers,
  ConnectorAdapter,
  ConnectorCard,
  InboundMessage,
  InboundResource,
} from '../connector-adapter';
import type { ConnectorStatus } from '../../../../shared/types/connector-types';
import { AppError } from '../../../../shared/errors';
import { discordMarkdown, splitMarkdown } from '../markdown';
import { TypingCue, pause } from './timing';

const API_BASE = 'https://discord.com/api/v10';
const TEXT_CHARS = 2000;
/** GUILDS and the privileged intents stay off: 1 << 12 is DIRECT_MESSAGES. */
const INTENTS = 1 << 12;
/** "typing…" shows for ten seconds. */
const TYPING_MS = 8000;
const OP = { dispatch: 0, heartbeat: 1, identify: 2, resume: 6, reconnect: 7, invalid: 9, hello: 10, ack: 11 };
const VOICE_MESSAGE = 1 << 13;
const SUPPRESS_EMBEDS = 1 << 2;
const INVALID_TOKEN = 'Bot Token 无效或已被重置，请删除后用新的 token 重新添加';
/** Private chats whose last message is remembered, and how far back missed messages are still worth answering. */
const CHATS_KEPT = 30;
const MISSED_MS = 24 * 3600_000;
/** Close codes after which connecting again would fail the same way. */
const FATAL: Record<number, string> = {
  4004: INVALID_TOKEN,
  4010: 'Discord 拒绝了连接（分片设置无效）',
  4011: 'Discord 要求这个机器人分片连接，这里不支持',
  4012: 'Discord 不再支持这个接口版本，请更新 AelionBot',
  4013: 'Discord 拒绝了连接（intents 无效）',
  4014: 'Discord 拒绝了连接（没有开通所需的 intents）',
};

export interface DiscordOptions {
  fetch?: typeof fetch;
  /** https://discord.com/api/v10, or a test server. */
  apiBase?: string;
  /** Skips asking the API where the gateway is. */
  gatewayUrl?: string;
  /** The app version, for the User-Agent Discord asks of bots. */
  version?: string;
  reconnectMs?: (attempt: number) => number;
  /** How long a "retry after N seconds" answer waits. */
  retryAfterMs?: (seconds: number) => number;
  typingMs?: number;
}

class DiscordError extends Error {
  constructor(
    readonly status: number,
    /** Discord's own error number, such as 50007 for a person who takes no direct messages. */
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** One REST call; a rate-limited one waits as long as Discord asks and goes again. */
async function request(
  options: DiscordOptions,
  token: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  file?: { name: string; bytes: Buffer },
  halt?: AbortSignal,
) {
  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = {
      'User-Agent': `DiscordBot (https://aelion.chat, ${options.version || '0'})`,
      ...(token ? { Authorization: `Bot ${token}` } : {}),
    };
    let payload: BodyInit | undefined;
    if (file) {
      const form = new FormData();
      form.set('payload_json', JSON.stringify(body || {}));
      form.set('files[0]', new Blob([new Uint8Array(file.bytes)]), file.name);
      payload = form;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await (options.fetch || fetch)((options.apiBase || API_BASE) + path, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(file ? 180_000 : 20_000),
      });
    } catch (error) {
      throw new Error('连不上 Discord，请检查网络', { cause: error });
    }
    if (response.status === 204) return undefined;
    const text = await response.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      /* An error page instead of JSON is reported by its status below. */
    }
    if (response.status === 429 && attempt < 3) {
      const seconds = Number(data?.retry_after) || Number(response.headers.get('retry-after')) || 1;
      await pause(Math.min(60_000, options.retryAfterMs?.(seconds) ?? seconds * 1000), halt);
      if (halt?.aborted) throw new Error('连接器已停止');
      continue;
    }
    if (!response.ok)
      throw new DiscordError(
        response.status,
        Number(data?.code) || 0,
        response.status === 413 || data?.code === 40005
          ? '文件超过 Discord 的大小限制'
          : data?.code === 50007
            ? '发不出私信：对方关闭了私信，或和机器人没有共同的服务器'
            : String(data?.message || `Discord 接口错误 ${response.status}`),
      );
    return data;
  }
}

/** Who a token belongs to, asked of Discord: the check before a connector is saved. */
export async function discordIdentity(token: string, options: DiscordOptions = {}) {
  if (!/^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/.test(token))
    throw new AppError(
      'connector.credentials_invalid',
      '这不像 Bot token。请在 Developer Portal 的 Bot 页点 Reset Token 后复制',
    );
  try {
    const me = await request(options, token, 'GET', '/users/@me');
    const tag = me.discriminator && me.discriminator !== '0' ? '#' + me.discriminator : '';
    return { id: String(me.id), name: String(me.username || me.id) + tag };
  } catch (error) {
    if (error instanceof DiscordError && error.status === 401)
      throw new AppError('connector.credentials_invalid', 'Discord 不认这个 token，请重新复制 Bot token', {
        cause: error,
      });
    throw new AppError('connector.unreachable', (error as Error).message, { cause: error });
  }
}

const cardText = (card: ConnectorCard, result?: string) =>
  (`**${card.title}**\n${card.lines.join('\n')}`.slice(0, 1800) + (result ? `\n\n**${result}**` : '')).trim();

export class DiscordAdapter implements ConnectorAdapter {
  readonly platform = 'discord' as const;
  private handlers?: AdapterHandlers;
  private ws?: WebSocket;
  private halt?: AbortController;
  private last?: string;
  private attempts = 0;
  /** A session has been up since start(). */
  private ready = false;
  private gateway?: string;
  /** A session Discord can replay missed events into after a reconnect. */
  private session?: { id: string; url: string };
  private sequence: number | null = null;
  private beat?: ReturnType<typeof setTimeout>;
  private acked = true;
  private retry?: ReturnType<typeof setTimeout>;
  private cards = new Map<string, ConnectorCard>();
  /** Cards whose button press is being decided; the answer to the press rewrites them. */
  private pressing = new Set<string>();
  /** Private channels opened for people known only by their ID. */
  private channels = new Map<string, string>();
  private cue: TypingCue;
  /**
   * The last message seen in each private channel. Discord keeps nothing for a bot that was not connected, so after
   * a new session the messages that came later are read from the channels' history.
   */
  private seen: Map<string, string>;
  constructor(
    private token: string,
    private options: DiscordOptions = {},
    seen: Record<string, string> = {},
  ) {
    this.seen = new Map(Object.entries(seen));
    this.cue = new TypingCue(
      (chatId) => this.rest('POST', `/channels/${chatId}/typing`),
      options.typingMs ?? TYPING_MS,
    );
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
  private status(status: ConnectorStatus, issue?: string) {
    const key = status + '\0' + (issue || '');
    if (key === this.last) return;
    this.last = key;
    this.handlers?.status(status, issue);
  }
  private rest(method: string, path: string, body?: unknown, file?: { name: string; bytes: Buffer }) {
    return request(this.options, this.token, method, path, body, file, this.halt?.signal);
  }
  private again(halt: AbortSignal) {
    const delay = this.options.reconnectMs?.(this.attempts) ?? Math.min(30_000, 1000 * 2 ** this.attempts);
    // A session that will not resume is given up, with the address it came with: the next try starts over.
    if (++this.attempts >= 3) {
      this.forget();
      this.gateway = undefined;
    }
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect(halt), delay);
  }
  private async connect(halt: AbortSignal) {
    if (halt.aborted) return;
    // The first reconnect after a drop is quiet: sending goes through the REST API and still works meanwhile.
    if (!this.ready || this.attempts > 1)
      this.status(
        this.attempts > 3 ? 'error' : 'connecting',
        this.attempts > 3 ? '连不上 Discord，正在重试' : undefined,
      );
    let url = this.session?.url;
    if (!url)
      try {
        url = this.gateway ??= this.options.gatewayUrl || String((await this.rest('GET', '/gateway/bot')).url);
      } catch (error) {
        if (halt.aborted) return;
        if (error instanceof DiscordError && error.status === 401) return this.status('needs-config', INVALID_TOKEN);
        this.status(this.attempts > 3 ? 'error' : 'connecting', (error as Error).message);
        return this.again(halt);
      }
    if (halt.aborted) return;
    const ws = new WebSocket(`${url.replace(/\/+$/, '')}/?v=10&encoding=json`, { handshakeTimeout: 20_000 });
    this.ws = ws;
    ws.on('message', (data) => {
      let payload: any;
      try {
        payload = JSON.parse(String(data));
      } catch {
        return;
      }
      if (this.ws === ws) this.receive(ws, payload);
    });
    ws.on('error', () => {});
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      clearTimeout(this.beat);
      if (halt.aborted) return;
      if (FATAL[code]) return this.status(code === 4004 ? 'needs-config' : 'error', FATAL[code]);
      // 4007 and 4009: the session is gone, so the next connection starts a new one.
      if (code === 4007 || code === 4009) this.forget();
      this.again(halt);
    });
  }
  private forget() {
    this.session = undefined;
    this.sequence = null;
  }
  private receive(ws: WebSocket, payload: any) {
    if (typeof payload.s === 'number') this.sequence = payload.s;
    if (payload.op === OP.hello) {
      this.heartbeats(ws, Number(payload.d?.heartbeat_interval) || 41_250);
      ws.send(
        JSON.stringify(
          this.session && this.sequence !== null
            ? { op: OP.resume, d: { token: this.token, session_id: this.session.id, seq: this.sequence } }
            : {
                op: OP.identify,
                d: {
                  token: this.token,
                  intents: INTENTS,
                  properties: { os: process.platform, browser: 'AelionBot', device: 'AelionBot' },
                },
              },
        ),
      );
    } else if (payload.op === OP.ack) this.acked = true;
    else if (payload.op === OP.heartbeat) ws.send(JSON.stringify({ op: OP.heartbeat, d: this.sequence }));
    else if (payload.op === OP.reconnect)
      ws.close(4000); // Discord asks for a new connection; the session resumes on it.
    else if (payload.op === OP.invalid) {
      if (!payload.d) this.forget();
      ws.close(4000);
    } else if (payload.op === OP.dispatch) this.dispatch(payload.t, payload.d);
  }
  /** Heartbeats at the interval Discord names, the first one a random part of it later; a missed answer reconnects. */
  private heartbeats(ws: WebSocket, interval: number) {
    clearTimeout(this.beat);
    this.acked = true;
    const tick = () => {
      if (this.ws !== ws) return;
      if (!this.acked) return ws.terminate();
      this.acked = false;
      ws.send(JSON.stringify({ op: OP.heartbeat, d: this.sequence }));
      this.beat = setTimeout(tick, interval);
    };
    this.beat = setTimeout(tick, interval * Math.random());
  }
  private dispatch(type: string, data: any) {
    if (type === 'READY') {
      this.session = { id: String(data.session_id), url: String(data.resume_gateway_url || this.gateway || '') };
      this.attempts = 0;
      this.ready = true;
      this.status('connected');
      void this.missed();
    } else if (type === 'RESUMED') {
      this.attempts = 0;
      this.ready = true;
      this.status('connected');
    } else if (type === 'MESSAGE_CREATE') this.message(data);
    else if (type === 'INTERACTION_CREATE') void this.pressed(data);
  }
  private message(data: any) {
    // Direct messages have no guild; the bot's own messages and other bots are skipped. Types 0 and 19 are an
    // ordinary message and a reply.
    if (!data?.id || !data.channel_id || !data.author?.id || data.author.bot || data.guild_id || data.webhook_id)
      return;
    if (data.type !== undefined && data.type !== 0 && data.type !== 19) return;
    this.mark(String(data.channel_id), String(data.id));
    const spoken = Boolean(Number(data.flags) & VOICE_MESSAGE),
      resources: InboundResource[] = [];
    for (const item of Array.isArray(data.attachments) ? data.attachments : []) {
      if (!item?.url) continue;
      const type = String(item.content_type || ''),
        name = String(item.filename || `file-${item.id}`);
      resources.push({
        kind: spoken ? 'audio' : type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : 'file',
        name,
        fetch: async (signal) => {
          const response = await (this.options.fetch || fetch)(String(item.url), { signal });
          if (!response.ok) throw new Error(`Discord 文件下载失败（${response.status}）`);
          return { name, bytes: Buffer.from(await response.arrayBuffer()) };
        },
      });
    }
    const name = data.author.global_name || data.author.username,
      quoted = data.referenced_message?.content;
    const message: InboundMessage = {
      messageId: String(data.id),
      chatId: String(data.channel_id),
      isGroup: false,
      sender: { id: String(data.author.id), ...(name ? { name: String(name) } : {}) },
      text: String(data.content || '').trim(),
      ...(quoted ? { quoted: String(quoted) } : {}),
      resources,
      sentAt: Date.parse(data.timestamp) || Date.now(),
    };
    this.handlers?.message(message);
  }
  /** Remembers the newest message of a private channel; IDs grow with time. */
  private mark(channel: string, id: string) {
    const last = this.seen.get(channel);
    try {
      if (last && BigInt(last) >= BigInt(id)) return;
    } catch {
      return;
    }
    this.seen.delete(channel);
    this.seen.set(channel, id);
    if (this.seen.size > CHATS_KEPT) this.seen.delete(this.seen.keys().next().value!);
    this.handlers?.state?.({ seen: JSON.stringify(Object.fromEntries(this.seen)) });
  }
  /** What people wrote while no session was up, oldest first. The hub skips any it has handled already. */
  private async missed() {
    // A copy: every message read moves its channel's mark, which changes the map.
    for (const [channel, last] of Array.from(this.seen))
      try {
        const list = await this.rest('GET', `/channels/${channel}/messages?after=${last}&limit=50`);
        const messages: any[] = (Array.isArray(list) ? list : []).filter(
          (item) => /^\d+$/.test(String(item?.id)) && Date.now() - Date.parse(item.timestamp) < MISSED_MS,
        );
        messages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        for (const item of messages) this.message({ ...item, channel_id: channel });
      } catch {
        /* A channel that can no longer be read is skipped; new messages still arrive live. */
      }
  }
  /** A button press. Discord wants an answer within three seconds, or shows "This interaction failed". */
  private async pressed(data: any) {
    // Type 3 is a message component, component type 2 a button.
    if (data?.type !== 3 || data.data?.component_type !== 2 || !data.id || !data.token) return;
    const user = data.user || data.member?.user,
      key = String(data.data.custom_id || ''),
      handle = `${data.channel_id}:${data.message?.id}`,
      card = this.cards.get(handle);
    let result: string | undefined;
    this.pressing.add(handle);
    if (user?.id && key && !data.guild_id)
      try {
        result = await this.handlers?.action({
          chatId: String(data.channel_id),
          operator: {
            id: String(user.id),
            ...(user.global_name || user.username ? { name: String(user.global_name || user.username) } : {}),
          },
          key,
        });
      } catch {
        /* Answered below as a press that changed nothing. */
      }
    this.pressing.delete(handle);
    // 7 rewrites the message the button is on; 6 only acknowledges the press.
    await request(
      this.options,
      undefined,
      'POST',
      `/interactions/${data.id}/${data.token}/callback`,
      result
        ? {
            type: 7,
            data: {
              content: card ? cardText(card, result) : `${String(data.message?.content || '')}\n\n**${result}**`.trim(),
              components: [],
            },
          }
        : { type: 6 },
    ).catch(() => {});
    if (result) this.cards.delete(handle);
  }
  async stop() {
    this.halt?.abort();
    clearTimeout(this.retry);
    clearTimeout(this.beat);
    this.cue.clear();
    const ws = this.ws;
    this.ws = undefined;
    ws?.close(1000);
  }
  /**
   * Posts to a chat. The hub usually knows the private channel a person wrote in; when it has only their user ID
   * (an owner who has not written since the connector was added), the private channel is opened first.
   */
  private async post(chatId: string, body: Record<string, unknown>, file?: { name: string; bytes: Buffer }) {
    const send = (channel: string) => this.rest('POST', `/channels/${channel}/messages`, body, file);
    try {
      return await send(this.channels.get(chatId) || chatId);
    } catch (error) {
      // 10003: no channel has this ID, so it is a person's.
      if (!(error instanceof DiscordError) || error.code !== 10003 || this.channels.has(chatId)) throw error;
      const channel = await this.rest('POST', '/users/@me/channels', { recipient_id: chatId });
      this.channels.set(chatId, String(channel.id));
      return send(String(channel.id));
    }
  }
  async sendText(chatId: string, text: string) {
    for (const part of splitMarkdown(discordMarkdown(text), TEXT_CHARS))
      await this.post(chatId, { content: part, allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS });
  }
  async sendFile(chatId: string, file: { name: string; bytes: Buffer }) {
    await this.post(chatId, { attachments: [{ id: 0, filename: file.name }], allowed_mentions: { parse: [] } }, file);
  }
  async sendCard(chatId: string, card: ConnectorCard) {
    // Up to five buttons to a row, five rows to a message.
    const rows: Array<ConnectorCard['buttons']> = [];
    for (let index = 0; index < card.buttons.length && rows.length < 5; index += 5)
      rows.push(card.buttons.slice(index, index + 5));
    const sent = await this.post(chatId, {
      content: cardText(card),
      allowed_mentions: { parse: [] },
      components: rows.map((row) => ({
        type: 1,
        components: row.map((button) => ({
          type: 2,
          // 1 is the accent button, 4 the red one, 2 the plain one.
          style: button.style === 'primary' ? 1 : button.style === 'danger' ? 4 : 2,
          label: button.label.slice(0, 80),
          custom_id: button.key.slice(0, 100),
        })),
      })),
    });
    const handle = `${sent.channel_id}:${sent.id}`;
    this.cards.set(handle, card);
    if (this.cards.size > 200) this.cards.delete(this.cards.keys().next().value!);
    return handle;
  }
  async closeCard(handle: string, card: ConnectorCard, result: string) {
    // A card closed by its own button is rewritten in the answer to the press.
    if (this.pressing.has(handle) || !this.cards.delete(handle)) return;
    const [channel, message] = handle.split(':');
    await this.rest('PATCH', `/channels/${channel}/messages/${message}`, {
      content: cardText(card, result),
      components: [],
    });
  }
  async typing(chatId: string, active: boolean) {
    await this.cue.set(this.channels.get(chatId) || chatId, active);
  }
}
