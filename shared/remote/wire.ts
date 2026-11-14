// Messages over an established channel: JSON values (split into several frames when large) and binary streams such
// as a remote desktop connection. Frames are sealed and handed to the transport strictly in order, and received
// frames are opened in arrival order, because the channel's nonces are counters.
import type { Bytes, Channel } from './crypto';

const JSON_LAST = 1;
const JSON_PART = 2;
const STREAM = 3;
/** Plaintext bytes per frame; with the tag and the relay's header a frame stays far below the relay's limit. */
const FRAME_BYTES = 192 * 1024;
/** The largest JSON value accepted: a 25 MB attachment as base64 plus its envelope. */
const MESSAGE_BYTES = 48 * 1024 * 1024;

const encoder = new TextEncoder(),
  decoder = new TextDecoder();

function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
function fromBase64(text: string): Bytes {
  const binary = atob(text),
    out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
  return out;
}

/** JSON in which byte arrays travel as `{ "$bytes": base64 }`. */
export function encodeJson(value: unknown): Bytes {
  return encoder.encode(
    JSON.stringify(value, (_key, item) => (item instanceof Uint8Array ? { $bytes: toBase64(item) } : item)),
  ) as Bytes;
}
export function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes), (_key, item) =>
    item && typeof item === 'object' && typeof item.$bytes === 'string' && Object.keys(item).length === 1
      ? fromBase64(item.$bytes)
      : item,
  );
}

export interface WireHandlers {
  json(value: unknown): void;
  stream(id: number, data: Bytes): void;
  /** The channel broke (a frame did not open, or the transport refused a frame); the connection must be dropped. */
  fail(error: Error): void;
}

export class Wire {
  private outgoing: Promise<void> = Promise.resolve();
  private incoming: Promise<void> = Promise.resolve();
  private parts: Uint8Array[] = [];
  private partBytes = 0;
  private failed = false;

  constructor(
    private readonly channel: Channel,
    private readonly transmit: (frame: Bytes) => void,
    private readonly handlers: WireHandlers,
  ) {}

  get closed() {
    return this.failed;
  }

  /** Sends a value; `sent` runs once its last frame was handed to the transport, before any later frame. */
  sendJson(value: unknown, sent?: () => void) {
    const body = encodeJson(value);
    if (body.length > MESSAGE_BYTES) throw new Error('消息太大');
    for (let offset = 0; offset < body.length; offset += FRAME_BYTES) {
      const chunk = body.subarray(offset, offset + FRAME_BYTES),
        last = offset + FRAME_BYTES >= body.length,
        frame = new Uint8Array(chunk.length + 1);
      frame[0] = last ? JSON_LAST : JSON_PART;
      frame.set(chunk, 1);
      this.enqueue(frame, last ? sent : undefined);
    }
  }

  sendStream(id: number, data: Uint8Array) {
    for (let offset = 0; offset < data.length; offset += FRAME_BYTES) {
      const chunk = data.subarray(offset, offset + FRAME_BYTES),
        frame = new Uint8Array(chunk.length + 5);
      frame[0] = STREAM;
      new DataView(frame.buffer).setUint32(1, id);
      frame.set(chunk, 5);
      this.enqueue(frame);
    }
  }

  /** Waits until every frame queued so far was handed to the transport. */
  flushed() {
    return this.outgoing;
  }

  receive(frame: Uint8Array) {
    if (this.failed) return;
    // Copy: the transport may reuse its buffer before the queued decryption runs.
    const copy = frame.slice();
    this.incoming = this.incoming.then(async () => {
      if (this.failed) return;
      try {
        this.dispatch(await this.channel.open(copy));
      } catch (error) {
        this.fail(error as Error);
      }
    });
  }

  private enqueue(frame: Bytes, sent?: () => void) {
    if (this.failed) throw new Error('连接已断开');
    this.outgoing = this.outgoing.then(async () => {
      if (this.failed) return;
      try {
        this.transmit(await this.channel.seal(frame));
        sent?.();
      } catch (error) {
        this.fail(error as Error);
      }
    });
  }

  private dispatch(plain: Bytes) {
    const kind = plain[0];
    if (kind === STREAM) {
      if (plain.length < 5) throw new Error('数据帧无效');
      this.handlers.stream(new DataView(plain.buffer, plain.byteOffset).getUint32(1), plain.subarray(5));
      return;
    }
    if (kind !== JSON_PART && kind !== JSON_LAST) throw new Error('未知的数据帧');
    this.parts.push(plain.subarray(1));
    this.partBytes += plain.length - 1;
    if (this.partBytes > MESSAGE_BYTES) throw new Error('消息太大');
    if (kind === JSON_PART) return;
    const body = this.parts.length === 1 ? this.parts[0] : new Uint8Array(this.partBytes);
    if (this.parts.length > 1) {
      let offset = 0;
      for (const part of this.parts) {
        body.set(part, offset);
        offset += part.length;
      }
    }
    this.parts = [];
    this.partBytes = 0;
    this.handlers.json(decodeJson(body));
  }

  private fail(error: Error) {
    if (this.failed) return;
    this.failed = true;
    this.handlers.fail(error);
  }
}
