// End-to-end encryption between a phone and the desktop app. The relay between them only forwards bytes; it never
// holds a key. WebCrypto only, so the same code runs in the desktop's main process and in the phone's browser.
//
// Handshake, in the spirit of Noise IK (P-256, HKDF-SHA-256, AES-256-GCM):
//   phone → desktop  hello { p: phone static key, e: phone ephemeral key, pair?: proof of the pairing secret }
//   desktop → phone  reply { e: desktop ephemeral key }
//   keys = HKDF(DH(e_p, D) ‖ DH(P, D) ‖ DH(e_p, e_d) ‖ DH(P, e_d), salt = SHA-256(transcript))
// The phone knows the desktop's static key D from the pairing QR code, so only that desktop can derive the keys; the
// desktop accepts P only if it paired it before, or if the hello proves knowledge of a one-time pairing secret.
// Every frame after that is AES-GCM with a counter nonce per direction, so a replayed, dropped or reordered frame
// fails to open.

export type Bytes = Uint8Array<ArrayBuffer>;

const subtle = () => globalThis.crypto.subtle;
const encoder = new TextEncoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const PROTOCOL = 'aelion-remote-v1';

export const utf8 = (text: string): Bytes => encoder.encode(text) as Bytes;

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function randomBytes(length: number): Bytes {
  const out = new Uint8Array(length);
  // getRandomValues fills at most 64 KiB per call.
  for (let offset = 0; offset < length; offset += 65536)
    globalThis.crypto.getRandomValues(out.subarray(offset, Math.min(length, offset + 65536)));
  return out;
}

/** Base64url without padding, as used in keys, URLs and JSON. */
export function toBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromBase64Url(text: string): Bytes {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('无效的 base64url 数据');
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
  return out;
}

/** Compares without stopping at the first difference. */
function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a[index] ^ b[index];
  return diff === 0;
}

async function sha256(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await subtle().digest('SHA-256', data as Bytes));
}
async function hmac(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const handle = await subtle().importKey('raw', key as Bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', handle, data as Bytes));
}
async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, length: number): Promise<Bytes> {
  const key = await subtle().importKey('raw', ikm as Bytes, 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as Bytes, info: utf8(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

// ---------- Keys ----------

/** A P-256 key pair for key agreement. The phone keeps its private key non-extractable in IndexedDB. */
export function generateAgreementKey(extractable = false) {
  return subtle().generateKey(ECDH, extractable, ['deriveBits']) as Promise<CryptoKeyPair>;
}
/** A P-256 key pair for signatures: the desktop proves to the relay that it owns its room. */
export function generateSigningKey(extractable = false) {
  return subtle().generateKey(ECDSA, extractable, ['sign', 'verify']) as Promise<CryptoKeyPair>;
}
/** The public key as 65 uncompressed bytes. */
export async function exportPublicKey(key: CryptoKey): Promise<Bytes> {
  return new Uint8Array(await subtle().exportKey('raw', key));
}
export async function exportPrivateKey(key: CryptoKey): Promise<Bytes> {
  return new Uint8Array(await subtle().exportKey('pkcs8', key));
}
export function importAgreementPublicKey(raw: Uint8Array) {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('无效的公钥');
  return subtle().importKey('raw', raw as Bytes, ECDH, true, []);
}
export function importAgreementPrivateKey(pkcs8: Uint8Array) {
  return subtle().importKey('pkcs8', pkcs8 as Bytes, ECDH, false, ['deriveBits']);
}
export function importSigningPublicKey(raw: Uint8Array) {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('无效的公钥');
  return subtle().importKey('raw', raw as Bytes, ECDSA, true, ['verify']);
}
export function importSigningPrivateKey(pkcs8: Uint8Array) {
  return subtle().importKey('pkcs8', pkcs8 as Bytes, ECDSA, false, ['sign']);
}
/** ECDSA with SHA-256; the signature is r ‖ s (64 bytes), the form JWS and WebCrypto use. */
export async function sign(privateKey: CryptoKey, data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data as Bytes));
}
export function verify(publicKey: CryptoKey, signature: Uint8Array, data: Uint8Array) {
  return subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature as Bytes, data as Bytes);
}
async function dh(privateKey: CryptoKey, publicKey: CryptoKey): Promise<Bytes> {
  return new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256));
}
/** The relay room of a desktop: derived from its signing key, so only that desktop can claim it. */
export async function roomId(signingPublicKey: Uint8Array) {
  return toBase64Url((await sha256(concat(utf8('aelion-room-v1'), signingPublicKey))).subarray(0, 24));
}

// ---------- Channel ----------

const nonce = (counter: number) => {
  const bytes = new Uint8Array(12);
  new DataView(bytes.buffer).setBigUint64(4, BigInt(counter));
  return bytes;
};

/**
 * One direction pair of an established session. `seal` and `open` assign counters in call order; callers must send
 * the sealed frames in that order (Wire does) and feed received frames in arrival order.
 */
export class Channel {
  private sent = 0;
  private received = 0;
  private broken = false;
  constructor(
    private readonly sendKey: CryptoKey,
    private readonly receiveKey: CryptoKey,
  ) {}

  async seal(plain: Uint8Array): Promise<Bytes> {
    if (this.broken) throw new Error('加密通道已关闭');
    const iv = nonce(this.sent++);
    return new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, this.sendKey, plain as Bytes));
  }

  async open(cipher: Uint8Array): Promise<Bytes> {
    if (this.broken) throw new Error('加密通道已关闭');
    const iv = nonce(this.received++);
    try {
      return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv }, this.receiveKey, cipher as Bytes));
    } catch {
      // A frame that does not open means tampering or a lost frame: nothing after it can be trusted.
      this.broken = true;
      throw new Error('收到无法解密的数据');
    }
  }
}

async function channelKeys(ikm: Uint8Array, transcript: Uint8Array) {
  const okm = await hkdf(ikm, await sha256(transcript), PROTOCOL + ' keys', 64);
  const key = (bytes: Uint8Array) =>
    subtle().importKey('raw', bytes as Bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { phoneToDesktop: await key(okm.subarray(0, 32)), desktopToPhone: await key(okm.subarray(32, 64)) };
}

// ---------- Handshake ----------

export interface Hello {
  v: 1;
  /** The phone's static public key. */
  p: string;
  /** The phone's ephemeral public key. */
  e: string;
  /** Present on the first connection: the pairing it answers and HMAC(secret, …) over the keys. */
  pair?: { id: string; proof: string };
}
export interface HelloReply {
  v: 1;
  e: string;
}

const pairingMessage = (desktop: Uint8Array, phone: Uint8Array, ephemeral: Uint8Array) =>
  concat(utf8('aelion-pair-v1'), desktop, phone, ephemeral);
const transcriptOf = (
  desktop: Uint8Array,
  phone: Uint8Array,
  phoneEphemeral: Uint8Array,
  desktopEphemeral: Uint8Array,
) => concat(utf8(PROTOCOL), desktop, phone, phoneEphemeral, desktopEphemeral);

/** The phone's side: builds the hello, then turns the desktop's reply into a channel. */
export async function startHandshake(input: {
  device: CryptoKeyPair;
  desktopKey: Uint8Array;
  pairing?: { id: string; secret: Uint8Array };
}) {
  const desktop = await importAgreementPublicKey(input.desktopKey),
    ephemeral = await generateAgreementKey(),
    phonePublic = await exportPublicKey(input.device.publicKey),
    ephemeralPublic = await exportPublicKey(ephemeral.publicKey);
  const hello: Hello = { v: 1, p: toBase64Url(phonePublic), e: toBase64Url(ephemeralPublic) };
  if (input.pairing)
    hello.pair = {
      id: input.pairing.id,
      proof: toBase64Url(
        await hmac(input.pairing.secret, pairingMessage(input.desktopKey, phonePublic, ephemeralPublic)),
      ),
    };
  const es = await dh(ephemeral.privateKey, desktop),
    ss = await dh(input.device.privateKey, desktop);
  return {
    hello,
    async finish(reply: HelloReply) {
      if (reply?.v !== 1 || typeof reply.e !== 'string') throw new Error('电脑的握手回复无效');
      const desktopEphemeralRaw = fromBase64Url(reply.e),
        desktopEphemeral = await importAgreementPublicKey(desktopEphemeralRaw);
      const ee = await dh(ephemeral.privateKey, desktopEphemeral),
        se = await dh(input.device.privateKey, desktopEphemeral);
      const keys = await channelKeys(
        concat(es, ss, ee, se),
        transcriptOf(input.desktopKey, phonePublic, ephemeralPublic, desktopEphemeralRaw),
      );
      return new Channel(keys.phoneToDesktop, keys.desktopToPhone);
    },
  };
}

/**
 * The desktop's side. `pairingSecret` looks up the secret of a pairing in progress; a hello without a valid proof is
 * still answered (the caller decides whether it knows the phone's key), but `paired` tells whether the proof held.
 */
export async function acceptHandshake(input: {
  desktop: CryptoKeyPair;
  desktopPublic: Uint8Array;
  hello: Hello;
  pairingSecret?: (id: string) => Uint8Array | undefined;
}) {
  const hello = input.hello;
  if (hello?.v !== 1 || typeof hello.p !== 'string' || typeof hello.e !== 'string') throw new Error('握手消息无效');
  const phoneRaw = fromBase64Url(hello.p),
    phoneEphemeralRaw = fromBase64Url(hello.e);
  const phone = await importAgreementPublicKey(phoneRaw),
    phoneEphemeral = await importAgreementPublicKey(phoneEphemeralRaw);
  let paired = false;
  if (hello.pair && typeof hello.pair.id === 'string' && typeof hello.pair.proof === 'string') {
    const secret = input.pairingSecret?.(hello.pair.id);
    if (secret) {
      const expected = await hmac(secret, pairingMessage(input.desktopPublic, phoneRaw, phoneEphemeralRaw));
      paired = sameBytes(expected, fromBase64Url(hello.pair.proof));
    }
  }
  const ephemeral = await generateAgreementKey(),
    ephemeralRaw = await exportPublicKey(ephemeral.publicKey);
  const es = await dh(input.desktop.privateKey, phoneEphemeral),
    ss = await dh(input.desktop.privateKey, phone),
    ee = await dh(ephemeral.privateKey, phoneEphemeral),
    se = await dh(ephemeral.privateKey, phone);
  const keys = await channelKeys(
    concat(es, ss, ee, se),
    transcriptOf(input.desktopPublic, phoneRaw, phoneEphemeralRaw, ephemeralRaw),
  );
  return {
    reply: { v: 1, e: toBase64Url(ephemeralRaw) } satisfies HelloReply,
    channel: new Channel(keys.desktopToPhone, keys.phoneToDesktop),
    phoneKey: hello.p,
    paired,
  };
}
