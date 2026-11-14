import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { encryptPush, sendPush, vapidAuthorization } from '../electron/core/remote/web-push';
import { verifyAssertion, verifyRegistration } from '../electron/core/remote/webauthn';
import {
  exportPublicKey,
  fromBase64Url,
  generateSigningKey,
  importSigningPublicKey,
  toBase64Url,
  utf8,
  verify,
  type Bytes,
} from '../shared/remote/crypto';

// RFC 8291 Appendix A.
const VECTOR = {
  serverPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  serverPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  plaintext: 'When I grow up, I want to be a watermelon',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
const ecJwk = (privateKey: string, publicKey: string) => {
  const raw = fromBase64Url(publicKey);
  return {
    kty: 'EC',
    crv: 'P-256',
    d: privateKey,
    x: toBase64Url(raw.subarray(1, 33)),
    y: toBase64Url(raw.subarray(33, 65)),
  };
};
const importEcdh = async (privateKey: string, publicKey: string) => ({
  privateKey: await crypto.subtle.importKey(
    'jwk',
    ecJwk(privateKey, publicKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  ),
  publicKey: await crypto.subtle.importKey(
    'raw',
    fromBase64Url(publicKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  ),
});

/** The phone's side of RFC 8291, written separately from the sender to check one against the other. */
async function decryptPush(input: Uint8Array, uaPrivate: string, uaPublic: string, auth: string) {
  // A copy backed by a plain ArrayBuffer, as WebCrypto wants.
  const body = new Uint8Array(input);
  const salt = body.subarray(0, 16),
    keyLength = body[20],
    serverPublic = body.subarray(21, 21 + keyLength),
    cipher = body.subarray(21 + keyLength);
  const ua = await importEcdh(uaPrivate, uaPublic);
  const server = await crypto.subtle.importKey('raw', serverPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: server }, ua.privateKey, 256));
  const hkdf = async (saltBytes: Bytes, ikm: Bytes, info: Uint8Array, length: number) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: new Uint8Array(info) },
        await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']),
        length * 8,
      ),
    );
  const ikm = await hkdf(
    fromBase64Url(auth),
    shared,
    Buffer.concat([Buffer.from('WebPush: info\0'), fromBase64Url(uaPublic), serverPublic]),
    32,
  );
  const cek = await hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
    nonce = await hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']),
      cipher,
    ),
  );
  assert.equal(plain.at(-1), 2);
  return Buffer.from(plain.subarray(0, -1)).toString();
}

test('push messages match the RFC 8291 example and decrypt on the phone side', async () => {
  const subscription = { endpoint: 'https://push.example.net/x', keys: { p256dh: VECTOR.uaPublic, auth: VECTOR.auth } };
  const body = await encryptPush({
    payload: utf8(VECTOR.plaintext),
    subscription,
    salt: fromBase64Url(VECTOR.salt),
    serverKeys: await importEcdh(VECTOR.serverPrivate, VECTOR.serverPublic),
  });
  assert.equal(toBase64Url(body), VECTOR.body);
  const fresh = await encryptPush({ payload: utf8('{"title":"代码助手"}'), subscription });
  assert.equal(await decryptPush(fresh, VECTOR.uaPrivate, VECTOR.uaPublic, VECTOR.auth), '{"title":"代码助手"}');
});

test('VAPID tokens are signed for the push service and sent with the encrypted body', async () => {
  const key = await generateSigningKey(true),
    publicKey = await exportPublicKey(key.publicKey);
  const header = await vapidAuthorization({
    endpoint: 'https://web.push.apple.com/abc',
    subject: 'https://app.example.com',
    privateKey: key.privateKey,
    publicKey,
    now: 1_000_000_000_000,
  });
  const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
  assert.equal(k, toBase64Url(publicKey));
  const [head, claims, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(fromBase64Url(claims)).toString()), {
    aud: 'https://web.push.apple.com',
    exp: 1_000_000_000 + 12 * 3600,
    sub: 'https://app.example.com',
  });
  assert.ok(await verify(await importSigningPublicKey(publicKey), fromBase64Url(signature), utf8(head + '.' + claims)));

  const requests: Array<{ url: string; init: RequestInit }> = [];
  const result = await sendPush({
    subscription: { endpoint: 'https://push.example.net/sub', keys: { p256dh: VECTOR.uaPublic, auth: VECTOR.auth } },
    payload: { title: 't' },
    vapid: { privateKey: key.privateKey, publicKey, subject: 'https://app.example.com' },
    urgency: 'high',
    fetch: (async (url: URL, init: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(null, { status: 410 });
    }) as typeof fetch,
  });
  assert.deepEqual(result, { status: 410, gone: true });
  const headers = requests[0].init.headers as Record<string, string>;
  assert.equal(headers['content-encoding'], 'aes128gcm');
  assert.equal(headers.urgency, 'high');
  assert.equal(
    await decryptPush(requests[0].init.body as Uint8Array, VECTOR.uaPrivate, VECTOR.uaPublic, VECTOR.auth),
    '{"title":"t"}',
  );
});

test('a passkey assertion is accepted only when signed, verified by the user and for this origin', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = toBase64Url(publicKey.export({ format: 'der', type: 'spki' }));
  const origin = 'https://app.example.com',
    rpId = 'app.example.com';
  const data = (type: string, challenge: string, at = origin) =>
    toBase64Url(Buffer.from(JSON.stringify({ type, challenge, origin: at })));
  const stored = verifyRegistration({
    clientData: data('webauthn.create', 'reg'),
    challenge: 'reg',
    credentialId: 'Y3JlZA',
    publicKey: spki,
    rpId,
  });
  assert.equal(stored.origin, origin);
  assert.throws(() =>
    verifyRegistration({
      clientData: data('webauthn.create', 'reg', 'https://evil.example'),
      challenge: 'reg',
      credentialId: 'Y3JlZA',
      publicKey: spki,
      rpId,
    }),
  );

  const assertion = (flags: number, counter: number, challenge = 'c1', at = origin) => {
    const authData = Buffer.alloc(37);
    createHash('sha256').update(rpId).digest().copy(authData, 0);
    authData[32] = flags;
    authData.writeUInt32BE(counter, 33);
    const clientData = data('webauthn.get', challenge, at);
    const signature = nodeSign(
      'sha256',
      Buffer.concat([
        authData,
        createHash('sha256')
          .update(Buffer.from(fromBase64Url(clientData)))
          .digest(),
      ]),
      privateKey,
    );
    return { authenticatorData: toBase64Url(authData), clientData, signature: toBase64Url(signature) };
  };
  assert.equal(verifyAssertion({ ...assertion(0x05, 3), challenge: 'c1', stored }), 3);
  // Present but not verified (no Face ID), an old challenge, another origin, a counter going back.
  assert.throws(() => verifyAssertion({ ...assertion(0x01, 4), challenge: 'c1', stored }));
  assert.throws(() => verifyAssertion({ ...assertion(0x05, 4), challenge: 'c2', stored }));
  assert.throws(() =>
    verifyAssertion({ ...assertion(0x05, 4, 'c1', 'https://evil.example'), challenge: 'c1', stored }),
  );
  assert.throws(() => verifyAssertion({ ...assertion(0x05, 2), challenge: 'c1', stored: { ...stored, counter: 3 } }));
  const forged = assertion(0x05, 5);
  forged.signature = assertion(0x05, 6).signature;
  assert.throws(() => verifyAssertion({ ...forged, challenge: 'c1', stored }));
});
