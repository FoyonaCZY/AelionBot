// Web Push sent straight from this computer to the phone's push service (Apple, Google, Mozilla). The payload is
// encrypted for the phone's subscription key (RFC 8291, aes128gcm) and the request is signed with this computer's
// VAPID key (RFC 8292), so neither the push service nor the relay can read it.
import {
  concat,
  exportPublicKey,
  fromBase64Url,
  generateAgreementKey,
  randomBytes,
  sign,
  toBase64Url,
  utf8,
  type Bytes,
} from '../../../shared/remote/crypto';

export interface PushSubscriptionData {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const subtle = () => globalThis.crypto.subtle;
const RECORD_SIZE = 4096;

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Bytes> {
  const key = await subtle().importKey('raw', ikm as Bytes, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await subtle().deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: salt as Bytes, info: info as Bytes },
      key,
      length * 8,
    ),
  );
}

/** The request body for one push message. `salt` and `serverKeys` are fixed only by tests. */
export async function encryptPush(input: {
  payload: Uint8Array;
  subscription: PushSubscriptionData;
  salt?: Uint8Array;
  serverKeys?: CryptoKeyPair;
}): Promise<Bytes> {
  const uaPublic = fromBase64Url(input.subscription.keys.p256dh),
    authSecret = fromBase64Url(input.subscription.keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('推送订阅无效');
  const serverKeys = input.serverKeys || (await generateAgreementKey()),
    serverPublic = await exportPublicKey(serverKeys.publicKey),
    salt = input.salt || randomBytes(16);
  const ua = await subtle().importKey('raw', uaPublic as Bytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: ua }, serverKeys.privateKey, 256));
  const ikm = await hkdf(
    authSecret,
    shared,
    concat(utf8('WebPush: info'), new Uint8Array([0]), uaPublic, serverPublic),
    32,
  );
  const cek = await hkdf(salt, ikm, concat(utf8('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16),
    nonce = await hkdf(salt, ikm, concat(utf8('Content-Encoding: nonce'), new Uint8Array([0])), 12);
  if (input.payload.length > RECORD_SIZE - 17) throw new Error('推送内容太长');
  // One record: the payload, then the delimiter 2 marking the last record.
  const key = await subtle().importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(input.payload, new Uint8Array([2]))),
  );
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = serverPublic.length;
  return concat(header, serverPublic, cipher);
}

/** The Authorization header for one push service: a JWT signed with the VAPID key, valid for 12 hours. */
export async function vapidAuthorization(input: {
  endpoint: string;
  subject: string;
  privateKey: CryptoKey;
  publicKey: Uint8Array;
  now?: number;
}) {
  const header = toBase64Url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = toBase64Url(
    utf8(
      JSON.stringify({
        aud: new URL(input.endpoint).origin,
        exp: Math.floor((input.now ?? Date.now()) / 1000) + 12 * 3600,
        sub: input.subject,
      }),
    ),
  );
  const signature = toBase64Url(await sign(input.privateKey, utf8(header + '.' + claims)));
  return `vapid t=${header}.${claims}.${signature}, k=${toBase64Url(input.publicKey)}`;
}

/** Sends one push. `gone` means the subscription no longer exists and should be forgotten. */
export async function sendPush(input: {
  subscription: PushSubscriptionData;
  payload: unknown;
  vapid: { privateKey: CryptoKey; publicKey: Uint8Array; subject: string };
  urgency?: 'normal' | 'high';
  topic?: string;
  fetch?: typeof fetch;
}) {
  const url = new URL(input.subscription.endpoint);
  if (url.protocol !== 'https:') throw new Error('推送地址无效');
  const body = await encryptPush({ payload: utf8(JSON.stringify(input.payload)), subscription: input.subscription });
  const response = await (input.fetch || fetch)(url, {
    method: 'POST',
    headers: {
      authorization: await vapidAuthorization({ endpoint: url.href, ...input.vapid }),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '86400',
      urgency: input.urgency || 'normal',
      // A topic replaces an undelivered message with the same topic (base64url, at most 32 characters).
      ...(input.topic ? { topic: input.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, gone: response.status === 404 || response.status === 410 };
}
