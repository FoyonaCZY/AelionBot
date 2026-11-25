// Telegram through the Bot API: getUpdates as a long poll (no public address), private chats only. Replies go out as
// Telegram HTML with a plain-text retry; files and voice messages go both ways; approvals are inline-keyboard buttons.
import { randomInt } from 'node:crypto';
import type {
  AdapterHandlers,
  ConnectorAdapter,
  ConnectorCard,
  ConnectorTextStream,
  InboundMessage,
  InboundResource,
} from '../connector-adapter';
import type { ConnectorPerson, ConnectorStatus } from '../../../../shared/types/connector-types';
import type { VoiceClip } from '../../speech/speech-service';
import { AppError } from '../../../../shared/errors';
import { plainText } from '../format';
import { escapeMarkup, splitMarkdown, telegramHtml } from '../markdown';
import { TypingCue, pause } from './timing';

const API_BASE = 'https://api.telegram.org';
/** A message holds 4096 characters after formatting; parts are cut a little under that. */
const TEXT_CHARS = 3900;
const POLL_SECONDS = 30;
const PHOTO_BYTES = 10 * 1024 * 1024;
const FILE_BYTES = 50 * 1024 * 1024;
/** "typing…" shows for five seconds. */
const TYPING_MS = 4000;
const DRAFT_INTERVAL_MS = 400;
const EDIT_INTERVAL_MS = 1000;
/** The photos of an album arrive as separate messages, moments apart. */
const ALBUM_MS = 700;
const PHOTO_FILE = /\.(png|jpe?g|webp)$/i;
const INVALID_TOKEN = 'Bot Token 无效或已被重置，请删除后用新的 token 重新添加';
const COMMANDS = [
  { command: 'new', description: '开始新会话' },
  { command: 'stop', description: '停止当前任务' },
  { command: 'status', description: '查看状态' },
  { command: 'help', description: '查看帮助' },
];

export interface TelegramOptions {
  fetch?: typeof fetch;
  /** https://api.telegram.org, or a test server. */
  apiBase?: string;
  pollSeconds?: number;
  /** The wait after a failed poll; it grows with repeated failures. */
  retryMs?: number;
  /** How long a "retry after N seconds" answer waits. */
  retryAfterMs?: (seconds: number) => number;
  typingMs?: number;
  albumMs?: number;
  streamIntervalMs?: number;
  editIntervalMs?: number;
}

class TelegramError extends Error {
  constructor(
    readonly status: number,
    description: string,
    readonly retryAfter?: number,
  ) {
    super(description);
  }
}

/** One Bot API call. The token is part of the address, so no error text carries the address. */
async function request(
  options: TelegramOptions,
  token: string,
  method: string,
  body?: Record<string, unknown> | FormData,
  signal?: AbortSignal,
) {
  let response: Response;
  try {
    response = await (options.fetch || fetch)(`${options.apiBase || API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      ...(body instanceof FormData
        ? { body }
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }),
      signal: signal || AbortSignal.timeout(body instanceof FormData ? 180_000 : 20_000),
    });
  } catch (error) {
    if (['TimeoutError', 'AbortError'].includes((error as Error).name)) throw error;
    throw new Error('连不上 Telegram，请检查网络', { cause: error });
  }
  let result: any;
  try {
    result = await response.json();
  } catch {
    throw new TelegramError(response.status, `Telegram 接口错误 ${response.status}`);
  }
  if (!result?.ok)
    throw new TelegramError(
      Number(result?.error_code) || response.status,
      String(result?.description || `Telegram 接口错误 ${response.status}`),
      Number(result?.parameters?.retry_after) || undefined,
    );
  return result.result;
}

/** Who a token belongs to, asked of Telegram: the check before a connector is saved. */
export async function telegramIdentity(token: string, options: TelegramOptions = {}) {
  if (!/^\d+:[\w-]{20,}$/.test(token))
    throw new AppError('connector.credentials_invalid', '这不像 BotFather 给的 token，它的样子是 123456789:ABC-DEF…');
  try {
    const me = await request(options, token, 'getMe');
    return { id: String(me.id), username: String(me.username || ''), name: String(me.first_name || '') };
  } catch (error) {
    if (error instanceof TelegramError && (error.status === 401 || error.status === 404))
      throw new AppError('connector.credentials_invalid', 'Telegram 不认这个 token，请到 BotFather 重新复制', {
        cause: error,
      });
    throw new AppError('connector.unreachable', (error as Error).message, { cause: error });
  }
}

const person = (from: any): ConnectorPerson => {
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username;
  return { id: String(from.id), ...(name ? { name: String(name) } : {}) };
};
/** Chat IDs are numbers; the hub keeps them as text. */
const chat = (chatId: string) => (/^-?\d{1,15}$/.test(chatId) ? Number(chatId) : chatId);
/** "/start" is what opening a bot sends; in a chat that is already paired it asks what the Bot can do. */
const command = (text: string) =>
  text.replace(/^\/start(?:@\w+)?(?:\s.*)?$/i, '/help').replace(/^\/(new|stop|status|help)@\w+\s*$/i, '/$1');
const cardHtml = (card: ConnectorCard, result?: string) =>
  (
    `<b>${escapeMarkup(card.title)}</b>\n` +
    escapeMarkup(card.lines.join('\n')).slice(0, 3600) +
    (result ? `\n\n<b>${escapeMarkup(result)}</b>` : '')
  ).trim();

interface Album {
  messages: any[];
  timer?: ReturnType<typeof setTimeout>;
}

export class TelegramAdapter implements ConnectorAdapter {
  readonly platform = 'telegram' as const;
  readonly voiceFormat = 'ogg-opus' as const;
  private handlers?: AdapterHandlers;
  private halt?: AbortController;
  private last?: string;
  private albums = new Map<string, Album>();
  /** Cards already rewritten with their result, so a press does not rewrite them again. */
  private closed = new Set<string>();
  /** Set when Bot API rejects `sendMessageDraft`, falling back to editing a sent message. */
  private draftUnsupported = false;
  private cue: TypingCue;
  constructor(
    private token: string,
    /** The next update to ask for; kept across restarts so nothing is delivered twice. */
    private offset = 0,
    private options: TelegramOptions = {},
  ) {
    this.cue = new TypingCue(
      (chatId) => this.call('sendChatAction', { chat_id: chat(chatId), action: 'typing' }),
      options.typingMs ?? TYPING_MS,
    );
  }
  start(handlers: AdapterHandlers) {
    this.handlers = handlers;
    this.halt?.abort();
    this.halt = new AbortController();
    this.last = undefined;
    this.draftUnsupported = false;
    void this.loop(this.halt.signal);
  }
  private status(status: ConnectorStatus, issue?: string) {
    const key = status + '\0' + (issue || '');
    if (key === this.last) return;
    this.last = key;
    this.handlers?.status(status, issue);
  }
  /** A call that waits and tries again when Telegram says the bot is sending too fast. */
  private async call(method: string, body?: Record<string, unknown> | FormData, signal?: AbortSignal) {
    for (let attempt = 0; ; attempt++)
      try {
        return await request(this.options, this.token, method, body, signal);
      } catch (error) {
        if (!(error instanceof TelegramError) || error.status !== 429 || attempt >= 2) throw error;
        await pause(this.retryAfter(error.retryAfter), this.halt?.signal);
      }
  }
  private retryAfter(seconds = 1) {
    return Math.min(60_000, this.options.retryAfterMs?.(seconds) ?? seconds * 1000);
  }
  private async loop(halt: AbortSignal) {
    this.status('connecting');
    const retry = this.options.retryMs ?? 5000,
      seconds = this.options.pollSeconds ?? POLL_SECONDS;
    let failures = 0,
      prepared = false;
    while (!halt.aborted) {
      try {
        if (!prepared) {
          // A webhook another program set would take every update away from getUpdates.
          await this.call('deleteWebhook', { drop_pending_updates: false });
          void this.call('setMyCommands', { commands: COMMANDS }).catch(() => {});
          prepared = true;
        }
        const updates = await request(
          this.options,
          this.token,
          'getUpdates',
          { offset: this.offset, timeout: seconds, allowed_updates: ['message', 'callback_query'] },
          AbortSignal.any([halt, AbortSignal.timeout((seconds + 15) * 1000)]),
        );
        if (halt.aborted) return;
        failures = 0;
        this.status('connected');
        const list: any[] = Array.isArray(updates) ? updates : [];
        for (const update of list) {
          if (Number.isSafeInteger(update?.update_id)) this.offset = Math.max(this.offset, update.update_id + 1);
          if (update?.message) this.message(update.message);
          else if (update?.callback_query) void this.pressed(update.callback_query);
        }
        if (list.length) this.handlers?.state?.({ offset: String(this.offset) });
      } catch (error) {
        if (halt.aborted) return;
        if ((error as Error).name === 'TimeoutError') continue;
        const status = error instanceof TelegramError ? error.status : 0;
        if (status === 401 || status === 404) return this.status('needs-config', INVALID_TOKEN);
        if (status === 409) {
          // Only one program may poll a bot; the other one wins while it runs.
          this.status('displaced', '这个机器人正在别的程序里接收消息，那边停下后这里会自动恢复');
          await pause(retry * 6, halt);
        } else if (status === 429) await pause(this.retryAfter((error as TelegramError).retryAfter), halt);
        else {
          // One failed poll is a blip: sending still works, so the connector stays up until a second one fails.
          if (++failures > 1 || this.last === undefined || this.last.startsWith('connecting'))
            this.status(failures > 3 ? 'error' : 'connecting', (error as Error).message);
          await pause(Math.min(60_000, retry * failures), halt);
        }
      }
    }
  }
  private message(message: any) {
    // Groups and channels are not served; neither are other bots.
    if (message?.chat?.type !== 'private' || !message.from || message.from.is_bot) return;
    if (!message.media_group_id) return this.handlers?.message(this.inbound([message]));
    const key = `${message.chat.id}:${message.media_group_id}`,
      album = this.albums.get(key) || { messages: [] };
    this.albums.set(key, album);
    clearTimeout(album.timer);
    album.messages.push(message);
    album.timer = setTimeout(() => {
      this.albums.delete(key);
      this.handlers?.message(this.inbound(album.messages));
    }, this.options.albumMs ?? ALBUM_MS);
  }
  /** One message for the hub from one Telegram message, or from the messages of an album. */
  private inbound(messages: any[]): InboundMessage {
    const first = messages[0],
      chatId = String(first.chat.id),
      texts: string[] = [],
      resources: InboundResource[] = [];
    for (const message of messages) {
      const text = String(message.text ?? message.caption ?? '').trim();
      if (text) texts.push(text);
      else if (message.sticker?.emoji) texts.push(String(message.sticker.emoji));
      this.media(resources, message);
    }
    const quoted = first.quote?.text || first.reply_to_message?.text || first.reply_to_message?.caption;
    return {
      messageId: `${chatId}:${first.message_id}`,
      chatId,
      isGroup: false,
      sender: person(first.from),
      text: command(texts.join('\n')),
      ...(quoted ? { quoted: String(quoted) } : {}),
      resources,
      sentAt: Number(first.date) * 1000 || Date.now(),
    };
  }
  private media(resources: InboundResource[], message: any) {
    const add = (kind: InboundResource['kind'], file: any, name: string) => {
      if (file?.file_id)
        resources.push({ kind, name, fetch: (signal) => this.download(String(file.file_id), name, signal) });
    };
    const id = message.message_id;
    if (Array.isArray(message.photo) && message.photo.length) add('image', message.photo.at(-1), `photo-${id}.jpg`);
    // A GIF arrives as an animation with the same file as a document.
    if (message.document)
      add(
        String(message.document.mime_type || '').startsWith('image/') ? 'image' : 'file',
        message.document,
        message.document.file_name || `file-${id}`,
      );
    // A recording made in the chat is speech to put into words; a music file is a file.
    if (message.voice) add('audio', message.voice, `voice-${id}.ogg`);
    if (message.audio) add('file', message.audio, message.audio.file_name || `audio-${id}.mp3`);
    if (message.video) add('video', message.video, message.video.file_name || `video-${id}.mp4`);
    if (message.video_note) add('video', message.video_note, `video-${id}.mp4`);
  }
  private async download(fileId: string, name: string, signal: AbortSignal) {
    let file: any;
    try {
      file = await this.call('getFile', { file_id: fileId }, signal);
    } catch (error) {
      throw /too big/i.test((error as Error).message) ? new Error('文件超过 Telegram 机器人能下载的 20 MB') : error;
    }
    if (!file?.file_path) throw new Error('Telegram 没有返回文件地址');
    let response: Response;
    try {
      response = await (this.options.fetch || fetch)(
        `${this.options.apiBase || API_BASE}/file/bot${this.token}/${file.file_path}`,
        { signal },
      );
    } catch (error) {
      if (['TimeoutError', 'AbortError'].includes((error as Error).name)) throw error;
      throw new Error('Telegram 文件下载失败，请检查网络', { cause: error });
    }
    if (!response.ok) throw new Error(`Telegram 文件下载失败（${response.status}）`);
    const extension = /\.\w+$/.exec(String(file.file_path))?.[0] || '';
    return {
      name: /\.\w+$/.test(name) ? name : name + extension,
      bytes: Buffer.from(await response.arrayBuffer()),
    };
  }
  /** A press on an inline button. Telegram shows a spinner on the button until the press is answered. */
  private async pressed(query: any) {
    const message = query?.message,
      key = String(query?.data || '');
    let result: string | undefined;
    if (key && message?.chat?.type === 'private' && query.from)
      try {
        result = await this.handlers?.action({ chatId: String(message.chat.id), operator: person(query.from), key });
      } catch {
        /* The press is still answered below, so the button stops spinning. */
      }
    await this.call('answerCallbackQuery', {
      callback_query_id: query.id,
      ...(result ? { text: result.slice(0, 190) } : {}),
    }).catch(() => {});
    if (!result || !message?.message_id) return;
    // The outbox rewrites a card it still knows; one from before a restart gets its result here.
    if (this.closed.delete(`${message.chat.id}:${message.message_id}`)) return;
    await this.call('editMessageText', {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: `${String(message.text || '').slice(0, 3900)}\n\n${result}`.trim(),
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  }
  async stop() {
    this.halt?.abort();
    this.cue.clear();
    for (const album of this.albums.values()) clearTimeout(album.timer);
    this.albums.clear();
  }
  private async sendPart(chatId: string, part: string): Promise<number> {
    try {
      const sent = await this.call('sendMessage', {
        chat_id: chat(chatId),
        text: telegramHtml(part) || part,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      return Number(sent?.message_id);
    } catch (error) {
      // Markup Telegram cannot parse, such as emphasis that overlaps: the same part goes as plain text.
      if (!(error instanceof TelegramError) || error.status !== 400) throw error;
      const sent = await this.call('sendMessage', {
        chat_id: chat(chatId),
        text: (plainText(part) || part).slice(0, 4096),
        link_preview_options: { is_disabled: true },
      });
      return Number(sent?.message_id);
    }
  }
  private async editPart(chatId: string, messageId: number, part: string) {
    try {
      await this.call('editMessageText', {
        chat_id: chat(chatId),
        message_id: messageId,
        text: telegramHtml(part) || part,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      if (!(error instanceof TelegramError) || error.status !== 400) throw error;
      if (/message is not modified/i.test(error.message)) return;
      try {
        await this.call('editMessageText', {
          chat_id: chat(chatId),
          message_id: messageId,
          text: (plainText(part) || part).slice(0, 4096),
          link_preview_options: { is_disabled: true },
        });
      } catch (fallback) {
        if (fallback instanceof TelegramError && /message is not modified/i.test(fallback.message)) return;
        throw fallback;
      }
    }
  }
  async sendText(chatId: string, text: string) {
    for (const part of splitMarkdown(text, TEXT_CHARS)) await this.sendPart(chatId, part);
  }
  /**
   * Streams a reply using Bot API's native `sendMessageDraft` (persisted via `sendMessage` on finish), falling back
   * to `sendMessage` + `editMessageText` if the Bot API server does not support drafts.
   */
  beginStream(chatId: string): ConnectorTextStream {
    const draftIntervalMs = this.options.streamIntervalMs ?? DRAFT_INTERVAL_MS,
      editIntervalMs = this.options.editIntervalMs ?? EDIT_INTERVAL_MS,
      draftId = randomInt(1, 0x7fffffff),
      isDraftUnsupported = () => this.draftUnsupported;
    let mode: 'idle' | 'draft' | 'edit' = 'idle',
      finished = false,
      lastDraft = '';
    const sent: Array<{ messageId: number; content: string }> = [];
    const draftPreview = (text: string) => {
      const parts = splitMarkdown(text, TEXT_CHARS);
      return parts.length > 1 ? '…\n' + parts.at(-1)! : parts[0] || text;
    };
    const sendDraft = async (preview: string) => {
      try {
        await this.call('sendMessageDraft', {
          chat_id: chat(chatId),
          draft_id: draftId,
          text: telegramHtml(preview) || preview,
          parse_mode: 'HTML',
        });
      } catch (error) {
        if (error instanceof TelegramError && error.status === 400 && /parse entities/i.test(error.message)) {
          await this.call('sendMessageDraft', {
            chat_id: chat(chatId),
            draft_id: draftId,
            text: (plainText(preview) || preview).slice(0, 4096),
          });
          return;
        }
        throw error;
      }
    };
    const syncEdit = async (text: string) => {
      const parts = splitMarkdown(text, TEXT_CHARS);
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        if (!sent[index]) {
          const messageId = await this.sendPart(chatId, part);
          sent.push({ messageId, content: part });
        } else if (sent[index].content !== part) {
          await this.editPart(chatId, sent[index].messageId, part);
          sent[index].content = part;
        }
      }
    };
    return {
      get intervalMs() {
        return mode === 'edit' || isDraftUnsupported() ? editIntervalMs : draftIntervalMs;
      },
      update: async (text: string) => {
        if (finished || !text.trim()) return;
        if (mode === 'idle') {
          if (!this.draftUnsupported) {
            const preview = draftPreview(text);
            try {
              await sendDraft(preview);
              mode = 'draft';
              lastDraft = preview;
              return;
            } catch (error) {
              if (error instanceof TelegramError && (error.status === 404 || error.status === 400)) {
                if (error.status === 404 || /method.*not found|unknown method/i.test(error.message))
                  this.draftUnsupported = true;
                mode = 'edit';
              } else throw error;
            }
          } else mode = 'edit';
        }
        if (mode === 'draft') {
          const preview = draftPreview(text);
          if (preview === lastDraft) return;
          await sendDraft(preview);
          lastDraft = preview;
          return;
        }
        await syncEdit(text);
      },
      finish: async (text: string) => {
        if (finished) return;
        finished = true;
        const final = text.trim();
        if (!final) return;
        if (mode === 'edit' && sent.length) {
          await syncEdit(final);
          return;
        }
        await this.sendText(chatId, final);
      },
    };
  }
  private form(chatId: string, field: string, bytes: Buffer, name: string, type?: string) {
    const data = new FormData();
    data.set('chat_id', chatId);
    data.set(field, new Blob([new Uint8Array(bytes)], type ? { type } : undefined), name);
    return data;
  }
  async sendFile(chatId: string, file: { name: string; bytes: Buffer }) {
    if (file.bytes.length > FILE_BYTES) throw new Error('文件超过 Telegram 50 MB 的限制');
    if (PHOTO_FILE.test(file.name) && file.bytes.length <= PHOTO_BYTES)
      try {
        await this.call('sendPhoto', this.form(chatId, 'photo', file.bytes, file.name));
        return;
      } catch (error) {
        // A picture too long or too wide to be a photo still goes as a file.
        if (!(error instanceof TelegramError) || error.status !== 400) throw error;
      }
    await this.call('sendDocument', this.form(chatId, 'document', file.bytes, file.name));
  }
  /** A voice message: Ogg Opus, which Telegram plays in place. */
  async sendVoice(chatId: string, voice: VoiceClip) {
    const data = this.form(chatId, 'voice', voice.bytes, 'voice.ogg', 'audio/ogg');
    data.set('duration', String(Math.max(1, Math.round(voice.durationMs / 1000))));
    await this.call('sendVoice', data);
  }
  async sendCard(chatId: string, card: ConnectorCard) {
    // A few short choices sit in one row; longer ones get a row each.
    const oneRow = card.buttons.length <= 3 && card.buttons.reduce((total, item) => total + item.label.length, 0) <= 24,
      rows = oneRow ? [card.buttons] : card.buttons.map((button) => [button]);
    const sent = await this.call('sendMessage', {
      chat_id: chat(chatId),
      text: cardHtml(card),
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: rows.map((row) =>
          row.map((button) => ({ text: button.label.slice(0, 60), callback_data: button.key })),
        ),
      },
    });
    return `${chatId}:${sent.message_id}`;
  }
  async closeCard(handle: string, card: ConnectorCard, result: string) {
    this.closed.add(handle);
    if (this.closed.size > 200) this.closed.delete(this.closed.values().next().value!);
    const cut = handle.lastIndexOf(':');
    await this.call('editMessageText', {
      chat_id: chat(handle.slice(0, cut)),
      message_id: Number(handle.slice(cut + 1)),
      text: cardHtml(card, result),
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] },
    });
  }
  async typing(chatId: string, active: boolean) {
    await this.cue.set(chatId, active);
  }
}
