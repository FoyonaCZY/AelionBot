// WeCom AI bot over its WebSocket long connection (wss://openws.work.weixin.qq.com): JSON frames, a 30-second ping,
// replies, chunked media upload and AES-256-CBC encrypted downloads. The platform keeps one connection
// per bot; a newer one displaces this one, which then stops instead of taking it back.
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import type { AdapterHandlers, ConnectorAdapter, ConnectorCard, InboundMessage } from '../connector-adapter';
import { splitText } from '../format';

const DEFAULT_URL = 'wss://openws.work.weixin.qq.com';
/** Markdown and stream content limit, in UTF-8 bytes; kept a little under the documented 20480. */
const TEXT_BYTES = 20000;
/** Replies may follow a message for 24 hours. */
const REPLY_WINDOW_MS = 23 * 3600_000;
const CHUNK_BYTES = 512 * 1024;
const IMAGE_FILE = /\.(png|jpe?g|gif)$/i;
const LIMITS = { image: 10 * 1024 * 1024, file: 20 * 1024 * 1024 };
/** Group text starts with the bot's @mention, which is routing rather than part of the request. */
const GROUP_MENTION = /^(?:\s*@[^\s@]+\s+)+/u;

interface Frame {
  cmd?: string;
  headers?: { req_id?: string };
  body?: any;
  errcode?: number;
  errmsg?: string;
}
const requestId = (prefix: string) => `${prefix}_${Date.now()}_${randomBytes(4).toString('hex')}`;

function stripGroupMention(text: string) {
  return text.replace(GROUP_MENTION, '').trim();
}

/** Decrypts a WeCom download: AES-256-CBC, IV = first 16 key bytes, PKCS#7 padded to 32 bytes. */
export function decryptWecomFile(data: Buffer, aesKey: string) {
  const key = Buffer.from(aesKey, 'base64'),
    decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]),
    pad = plain[plain.length - 1];
  if (pad < 1 || pad > 32 || pad > plain.length) throw new Error('企业微信文件解密失败');
  return plain.subarray(0, plain.length - pad);
}

export class WecomAdapter implements ConnectorAdapter {
  readonly platform = 'wecom' as const;
  private ws?: WebSocket;
  private handlers?: AdapterHandlers;
  private stopped = true;
  private displaced = false;
  private attempts = 0;
  /** The platform refused the BotID and Secret. */
  private rejected = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private acks = new Map<
    string,
    { resolve: (frame: Frame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  /** Per request ID, replies go one at a time: each waits for the previous one's acknowledgement. */
  private lanes = new Map<string, Promise<unknown>>();
  /** The latest message request per chat; replies to it are passive and need no prior session. */
  private contexts = new Map<string, { reqId: string; at: number }>();
  private cards = new Map<string, ConnectorCard>();
  constructor(
    private credentials: { botId: string; secret: string },
    private options: {
      url?: string;
      heartbeatMs?: number;
      ackTimeoutMs?: number;
      fetch?: typeof fetch;
      reconnectMs?: (attempt: number) => number;
    } = {},
  ) {}
  start(handlers: AdapterHandlers) {
    this.handlers = handlers;
    this.stopped = false;
    this.displaced = false;
    this.connect();
  }
  private connect() {
    if (this.stopped || this.displaced) return;
    // After a rejected login the error stays shown while the slow retry waits.
    if (!this.rejected) this.handlers?.status('connecting');
    const ws = new WebSocket(this.options.url || DEFAULT_URL);
    this.ws = ws;
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          cmd: 'aibot_subscribe',
          headers: { req_id: requestId('aibot_subscribe') },
          body: { bot_id: this.credentials.botId, secret: this.credentials.secret },
        }),
      );
    });
    ws.on('message', (data) => {
      let frame: Frame;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      this.receive(frame);
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      clearInterval(this.heartbeat);
      for (const [id, pending] of this.acks) {
        clearTimeout(pending.timer);
        pending.reject(new Error('企业微信连接已断开'));
        this.acks.delete(id);
      }
      if (this.stopped || this.displaced) return;
      if (!this.rejected) this.handlers?.status('connecting');
      const delay = this.rejected
        ? 60_000
        : (this.options.reconnectMs?.(this.attempts) ?? Math.min(30_000, 1000 * 2 ** this.attempts));
      this.attempts++;
      this.reconnect = setTimeout(() => this.connect(), delay);
    });
  }
  private receive(frame: Frame) {
    const reqId = frame.headers?.req_id || '';
    if (frame.cmd === 'aibot_msg_callback') return this.message(reqId, frame.body);
    if (frame.cmd === 'aibot_event_callback') return void this.event(reqId, frame.body);
    if (reqId.startsWith('aibot_subscribe')) {
      if (frame.errcode) {
        // Wrong credentials stay wrong; retry slowly in case the platform was the one failing.
        this.rejected = true;
        this.handlers?.status('error', `BotID 或 Secret 无效（${frame.errcode}）`);
        this.ws?.close();
        return;
      }
      this.rejected = false;
      this.attempts = 0;
      this.handlers?.status('connected');
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(
        () => this.ws?.send(JSON.stringify({ cmd: 'ping', headers: { req_id: requestId('ping') } })),
        this.options.heartbeatMs ?? 30_000,
      );
      return;
    }
    const pending = this.acks.get(reqId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.acks.delete(reqId);
    if (frame.errcode) pending.reject(new Error(`企业微信拒绝了消息（${frame.errcode} ${frame.errmsg || ''}）`.trim()));
    else pending.resolve(frame);
  }
  private chatOf(body: any) {
    return body?.chattype === 'group' ? String(body.chatid || '') : String(body?.from?.userid || '');
  }
  private message(reqId: string, body: any) {
    const chatId = this.chatOf(body);
    if (!chatId || !body?.msgid) return;
    this.contexts.set(chatId, { reqId, at: Date.now() });
    const texts: string[] = [],
      resources: InboundMessage['resources'] = [];
    const media = (kind: 'image' | 'file' | 'video', item: any, name?: string) => {
      if (!item?.url) return;
      resources.push({
        kind,
        name,
        fetch: (signal) => this.download(item.url, item.aeskey, kind, signal),
      });
    };
    const take = (type: string, value: any) => {
      if (type === 'text' && value?.text?.content) texts.push(value.text.content);
      else if (type === 'voice' && value?.voice?.content) texts.push(value.voice.content);
      else if (type === 'image') media('image', value?.image);
      else if (type === 'file') media('file', value?.file);
      else if (type === 'video') media('video', value?.video);
      else if (type === 'mixed') for (const item of value?.mixed?.msg_item || []) take(item.msgtype, item);
    };
    take(body.msgtype, body);
    const quote = body.quote,
      quoted =
        quote?.msgtype === 'text' ? quote.text?.content : quote?.msgtype === 'voice' ? quote.voice?.content : undefined;
    const isGroup = body.chattype === 'group';
    this.handlers?.message({
      messageId: String(body.msgid),
      chatId,
      isGroup,
      sender: { id: String(body.from?.userid || ''), ...(body.from?.name ? { name: String(body.from.name) } : {}) },
      text: isGroup ? stripGroupMention(texts.join('\n')) : texts.join('\n').trim(),
      ...(quoted ? { quoted: isGroup ? stripGroupMention(quoted) : quoted } : {}),
      resources,
      sentAt: body.create_time ? Number(body.create_time) * (Number(body.create_time) < 1e12 ? 1000 : 1) : Date.now(),
    });
  }
  private async event(reqId: string, body: any) {
    const event = body?.event || {};
    if (event.eventtype === 'disconnected_event') {
      this.displaced = true;
      this.handlers?.status('displaced', '这个机器人已在其他设备或程序上连接');
      this.ws?.close();
      return;
    }
    if (event.eventtype !== 'template_card_event') return;
    const detail = event.template_card_event || event,
      key = String(detail.event_key || ''),
      taskId = String(detail.task_id || ''),
      chatId = this.chatOf(body);
    if (!key || !chatId) return;
    const result = await this.handlers?.action({ chatId, operator: { id: String(body.from?.userid || '') }, key });
    const card = this.cards.get(taskId);
    if (!result || !card) return;
    this.cards.delete(taskId);
    // Updating a card is allowed only in answer to its event, within 5 seconds.
    await this.request(
      reqId,
      { response_type: 'update_template_card', template_card: this.templateCard(card, taskId, result) },
      'aibot_respond_update_msg',
    ).catch(() => {});
  }
  private async download(url: string, aesKey: string | undefined, kind: string, signal: AbortSignal) {
    const response = await (this.options.fetch || fetch)(url, { signal });
    if (!response.ok) throw new Error(`企业微信文件下载失败（${response.status}）`);
    const raw = Buffer.from(await response.arrayBuffer()),
      disposition = response.headers.get('content-disposition') || '',
      named = /filename\*=UTF-8''([^;\s]+)/i.exec(disposition)?.[1] || /filename="?([^";]+)"?/i.exec(disposition)?.[1];
    let name = kind + '-' + Date.now().toString(36);
    try {
      if (named) name = decodeURIComponent(named);
    } catch {}
    if (kind === 'image' && !/\.\w+$/.test(name)) name += '.jpg';
    if (kind === 'video' && !/\.\w+$/.test(name)) name += '.mp4';
    return { name, bytes: aesKey ? decryptWecomFile(raw, aesKey) : raw };
  }
  /** Sends one frame and resolves with its acknowledgement; frames with the same request ID go in order. */
  private request(reqId: string, body: unknown, cmd: string) {
    const previous = this.lanes.get(reqId) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(
        () =>
          new Promise<Frame>((resolve, reject) => {
            const ws = this.ws;
            if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('企业微信连接尚未建立'));
            const timer = setTimeout(() => {
              this.acks.delete(reqId);
              reject(new Error('企业微信没有确认这条消息'));
            }, this.options.ackTimeoutMs ?? 10_000);
            this.acks.set(reqId, { resolve, reject, timer });
            ws.send(JSON.stringify({ cmd, headers: { req_id: reqId }, body }));
          }),
      );
    this.lanes.set(reqId, next);
    void next
      .finally(() => {
        if (this.lanes.get(reqId) === next) this.lanes.delete(reqId);
      })
      .catch(() => {});
    return next;
  }
  private context(chatId: string) {
    const context = this.contexts.get(chatId);
    return context && Date.now() - context.at < REPLY_WINDOW_MS ? context.reqId : undefined;
  }
  /** Sends a message: as a reply when the chat wrote recently, otherwise as a proactive message. */
  private deliver(chatId: string, passive: Record<string, unknown>, proactive: Record<string, unknown>) {
    const reqId = this.context(chatId);
    return reqId
      ? this.request(reqId, passive, 'aibot_respond_msg')
      : this.request(requestId('aibot_send_msg'), { chatid: chatId, ...proactive }, 'aibot_send_msg');
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
  }
  async sendText(chatId: string, text: string) {
    for (const part of splitText(text, TEXT_BYTES, true))
      await this.deliver(
        chatId,
        { msgtype: 'stream', stream: { id: requestId('stream'), finish: true, content: part } },
        { msgtype: 'markdown', markdown: { content: part } },
      );
  }
  async sendFile(chatId: string, file: { name: string; bytes: Buffer }) {
    const type = IMAGE_FILE.test(file.name) && file.bytes.length <= LIMITS.image ? 'image' : 'file';
    if (file.bytes.length > LIMITS.file) throw new Error('文件超过企业微信 20 MB 的限制');
    const chunks = Math.max(1, Math.ceil(file.bytes.length / CHUNK_BYTES));
    const init = await this.request(
      requestId('aibot_upload_media_init'),
      {
        type,
        filename: file.name,
        total_size: file.bytes.length,
        total_chunks: chunks,
        md5: createHash('md5').update(file.bytes).digest('hex'),
      },
      'aibot_upload_media_init',
    );
    const uploadId = init.body?.upload_id;
    if (!uploadId) throw new Error('企业微信没有返回上传编号');
    for (let index = 0; index < chunks; index++)
      await this.request(
        requestId('aibot_upload_media_chunk'),
        {
          upload_id: uploadId,
          chunk_index: index,
          base64_data: file.bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64'),
        },
        'aibot_upload_media_chunk',
      );
    const done = await this.request(
      requestId('aibot_upload_media_finish'),
      { upload_id: uploadId },
      'aibot_upload_media_finish',
    );
    const mediaId = done.body?.media_id;
    if (!mediaId) throw new Error('企业微信没有返回文件编号');
    const message = { msgtype: type, [type]: { media_id: mediaId } };
    await this.deliver(chatId, message, message);
  }
  private templateCard(card: ConnectorCard, taskId: string, result?: string) {
    return {
      card_type: 'button_interaction',
      main_title: { title: card.title.slice(0, 36) },
      sub_title_text: [...card.lines, ...(result ? ['', result] : [])].join('\n').slice(0, 1000),
      task_id: taskId,
      // A decided card keeps one inert button that shows the result; pressing it changes nothing.
      button_list: result
        ? [{ text: result.slice(0, 10), style: 2, key: 'closed' }]
        : card.buttons.slice(0, 6).map((button) => ({
            text: button.label.slice(0, 10),
            style: button.style === 'primary' ? 1 : 2,
            key: button.key,
          })),
    };
  }
  async sendCard(chatId: string, card: ConnectorCard) {
    const taskId = requestId('task').slice(0, 64);
    this.cards.set(taskId, card);
    await this.deliver(
      chatId,
      { msgtype: 'template_card', template_card: this.templateCard(card, taskId) },
      { msgtype: 'template_card', template_card: this.templateCard(card, taskId) },
    );
    return taskId;
  }
  /** WeCom updates a card only in answer to its button event; a decision made elsewhere leaves it as sent. */
  async closeCard(handle: string) {
    this.cards.delete(handle);
  }
}
