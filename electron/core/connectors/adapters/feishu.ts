// Feishu through the official SDK's channel: a WebSocket long connection (no public address), messages, files and
// card buttons. The SDK is loaded on first use; it is large and only connector users need it.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { AdapterHandlers, ConnectorAdapter, ConnectorCard, InboundMessage } from '../connector-adapter';

// The parts of @larksuiteoapi/node-sdk used here. Its own declarations are 17 MB and would slow every type check.
interface LarkMessage {
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  senderId: string;
  senderName?: string;
  content: string;
  resources: Array<{ type: 'image' | 'file' | 'audio' | 'video' | 'sticker'; fileKey: string; fileName?: string }>;
  replyToMessageId?: string;
  createTime: number;
}
interface LarkCardAction {
  chatId: string;
  operator: { openId: string; name?: string };
  action: { value: unknown };
}
interface LarkChannel {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on(name: 'message', handler: (message: LarkMessage) => void): () => void;
  on(name: 'cardAction', handler: (action: LarkCardAction) => Promise<void>): () => void;
  on(name: 'reconnecting' | 'reconnected', handler: () => void): () => void;
  on(name: 'error', handler: (error: Error) => void): () => void;
  send(to: string, input: object, options?: object): Promise<{ messageId: string }>;
  updateCard(messageId: string, card: object): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
  rawClient: {
    im: {
      v1: {
        messageResource: {
          get(payload: {
            path: { message_id: string; file_key: string };
            params: { type: 'image' | 'file' };
          }): Promise<{ getReadableStream(): AsyncIterable<Buffer> }>;
        };
      };
    };
  };
}
export interface LarkSdk {
  createLarkChannel(options: object): LarkChannel;
  registerApp(options: {
    source?: string;
    signal?: AbortSignal;
    createOnly?: boolean;
    appPreset?: { name?: string; desc?: string };
    addons?: object;
    onQRCodeReady: (info: { url: string; expireIn: number }) => void;
    onStatusChange?: (info: { status: string }) => void;
  }): Promise<{ client_id: string; client_secret: string; user_info?: { open_id?: string; tenant_brand?: string } }>;
  LoggerLevel: { error: number };
}
let sdk: LarkSdk | undefined;
/** Loads the SDK as the bundle's own dependency; `runtimeDir` is the directory of the running bundle. */
export const loadLarkSdk = (runtimeDir: string) =>
  (sdk ??= createRequire(join(runtimeDir, 'connectors-loader.cjs'))('@larksuiteoapi/node-sdk') as LarkSdk);

const RETRY_MS = 30_000;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp)$/i;
/** Messages someone sends in a burst (a picture and its caption, a long paste Feishu split) reach the Bot as one. */
const BURST = { delayMs: 600, longChars: 1000, longDelayMs: 2000, maxMessages: 8, maxChars: 4000 };
interface Burst {
  messages: LarkMessage[];
  timer?: ReturnType<typeof setTimeout>;
  flush(): void;
}

/** Card JSON 2.0: a header, Markdown lines and a row of buttons. */
export function feishuCard(card: ConnectorCard, result?: string) {
  const elements: object[] = [{ tag: 'markdown', content: card.lines.join('\n'), element_id: 'body' }];
  if (result) elements.push({ tag: 'markdown', content: `**${result}**`, element_id: 'result' });
  else
    elements.push({
      tag: 'column_set',
      element_id: 'actions',
      columns: card.buttons.map((button, index) => ({
        tag: 'column',
        width: 'auto',
        elements: [
          {
            tag: 'button',
            element_id: 'button_' + index,
            text: { tag: 'plain_text', content: button.label },
            type: button.style === 'danger' ? 'danger' : button.style === 'primary' ? 'primary' : 'default',
            behaviors: [{ type: 'callback', value: { key: button.key } }],
          },
        ],
      })),
    });
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: card.title }, template: result ? 'grey' : 'orange' },
    body: { elements },
  };
}

export class FeishuAdapter implements ConnectorAdapter {
  readonly platform = 'feishu' as const;
  private channel?: LarkChannel;
  /** The latest message per chat, which carries the typing reaction. */
  private latest = new Map<string, string>();
  private cues = new Map<string, Promise<{ messageId: string; reactionId: string } | undefined>>();
  private bursts = new Map<string, Burst>();
  private stopped = false;
  private retry?: ReturnType<typeof setTimeout>;
  constructor(
    private credentials: { appId: string; appSecret: string },
    private load: () => LarkSdk,
  ) {}
  start(handlers: AdapterHandlers) {
    this.stopped = false;
    void this.connect(handlers);
  }
  private async connect(handlers: AdapterHandlers) {
    if (this.stopped) return;
    handlers.status('connecting');
    let channel: LarkChannel;
    try {
      const lark = this.load();
      channel = lark.createLarkChannel({
        appId: this.credentials.appId,
        appSecret: this.credentials.appSecret,
        source: 'aelionbot',
        loggerLevel: lark.LoggerLevel.error,
        handshakeTimeoutMs: 20_000,
        // Access, groups and sessions are decided by the hub, which sees every message.
        policy: { dmMode: 'open', requireMention: false },
        // Its merging keeps only the last message's ID, and a resource downloads only through its own (see gather).
        safety: { batch: { text: { delayMs: 0 } } },
      });
    } catch (error) {
      handlers.status('error', (error as Error).message);
      return;
    }
    this.channel = channel;
    channel.on('message', (message) => this.gather(channel, handlers, message));
    channel.on('cardAction', async (event) => {
      const key = (event.action.value as { key?: unknown } | undefined)?.key;
      if (typeof key !== 'string') return;
      await handlers.action({
        chatId: event.chatId,
        operator: { id: event.operator.openId, name: event.operator.name },
        key,
      });
    });
    channel.on('reconnecting', () => handlers.status('connecting'));
    channel.on('reconnected', () => handlers.status('connected'));
    channel.on('error', () => {});
    try {
      await channel.connect();
      if (this.stopped) return void channel.disconnect().catch(() => {});
      handlers.status('connected');
    } catch (error) {
      if (this.stopped) return;
      this.channel = undefined;
      void channel.disconnect().catch(() => {});
      handlers.status('error', feishuError(error));
      this.retry = setTimeout(() => void this.connect(handlers), RETRY_MS);
    }
  }
  /** Holds one person's messages for a moment, so that a burst reaches the hub as one message. */
  private gather(channel: LarkChannel, handlers: AdapterHandlers, message: LarkMessage) {
    const key = message.chatId + '\0' + message.senderId;
    let burst = this.bursts.get(key);
    if (!burst) {
      const opened: Burst = {
        messages: [],
        flush: () => {
          clearTimeout(opened.timer);
          this.bursts.delete(key);
          handlers.message(this.inbound(channel, opened.messages));
        },
      };
      burst = opened;
      this.bursts.set(key, burst);
    }
    clearTimeout(burst.timer);
    burst.messages.push(message);
    const chars = burst.messages.reduce((total, item) => total + item.content.length, 0);
    if (burst.messages.length >= BURST.maxMessages || chars >= BURST.maxChars) return burst.flush();
    burst.timer = setTimeout(burst.flush, chars >= BURST.longChars ? BURST.longDelayMs : BURST.delayMs);
  }
  private inbound(channel: LarkChannel, messages: LarkMessage[]): InboundMessage {
    const message = messages[messages.length - 1];
    this.latest.set(message.chatId, message.messageId);
    const seen = new Set<string>();
    return {
      messageId: message.messageId,
      chatId: message.chatId,
      isGroup: message.chatType !== 'p2p',
      sender: { id: message.senderId, ...(message.senderName ? { name: message.senderName } : {}) },
      // Media arrive as resources; their inline placeholders carry nothing for the Bot.
      text: messages
        .map((item) => item.content.replace(/<(image|file|audio|video|sticker|media)\b[^>]*\/?>/g, '').trim())
        .filter(Boolean)
        .join('\n\n'),
      resources: messages.flatMap((item) =>
        item.resources.flatMap((resource) => {
          if (resource.type === 'sticker' || seen.has(resource.fileKey)) return [];
          seen.add(resource.fileKey);
          return [
            {
              kind: resource.type,
              name: resource.fileName,
              fetch: async () => {
                // What a person sent downloads through its message; the plain image and file APIs only serve what
                // the Bot uploaded itself. Audio and video count as files here.
                const response = await channel.rawClient.im.v1.messageResource.get({
                  path: { message_id: item.messageId, file_key: resource.fileKey },
                  params: { type: resource.type === 'image' ? 'image' : 'file' },
                });
                const chunks: Buffer[] = [];
                for await (const chunk of response.getReadableStream()) chunks.push(chunk);
                return {
                  name:
                    resource.fileName ||
                    `${resource.type}-${resource.fileKey.slice(-8)}${resource.type === 'image' ? '.png' : ''}`,
                  bytes: Buffer.concat(chunks),
                };
              },
            },
          ];
        }),
      ),
      sentAt: Number(message.createTime) || Date.now(),
    };
  }
  private connected() {
    if (!this.channel) throw new Error('飞书连接尚未建立');
    return this.channel;
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    for (const burst of this.bursts.values()) burst.flush();
    const channel = this.channel;
    this.channel = undefined;
    await channel?.disconnect().catch(() => {});
  }
  async sendText(chatId: string, text: string) {
    await this.connected().send(chatId, { markdown: text });
  }
  async sendFile(chatId: string, file: { name: string; bytes: Buffer }) {
    await this.connected().send(
      chatId,
      IMAGE_FILE.test(file.name)
        ? { image: { source: file.bytes } }
        : { file: { source: file.bytes, fileName: file.name } },
    );
  }
  async sendCard(chatId: string, card: ConnectorCard) {
    return (await this.connected().send(chatId, { card: feishuCard(card) })).messageId;
  }
  async closeCard(handle: string, card: ConnectorCard, result: string) {
    await this.connected().updateCard(handle, feishuCard(card, result));
  }
  /** Feishu has no typing indicator: a "Typing" reaction on the person's latest message stands in for one. */
  async typing(chatId: string, active: boolean) {
    const channel = this.connected();
    if (active) {
      const messageId = this.latest.get(chatId);
      if (!messageId || this.cues.has(chatId)) return;
      this.cues.set(
        chatId,
        channel.addReaction(messageId, 'Typing').then(
          (reactionId) => ({ messageId, reactionId }),
          () => undefined,
        ),
      );
      await this.cues.get(chatId);
      return;
    }
    const cue = this.cues.get(chatId);
    this.cues.delete(chatId);
    const added = await cue;
    if (added) await channel.removeReaction(added.messageId, added.reactionId);
  }
}

function feishuError(error: unknown) {
  const text = String((error as Error)?.message || error);
  // The channel first reads the bot's own identity; that fails for wrong credentials or an app without a bot.
  if (/bot identity|app.?secret|app_id|invalid.*(app|secret)|10003|10014/i.test(text))
    return 'App ID 或 App Secret 无效，或应用还没有添加机器人能力';
  if (/timeout|ETIMEDOUT|ENOTFOUND|ECONN/i.test(text)) return '无法连接飞书服务器，请检查网络';
  return text.slice(0, 300);
}
