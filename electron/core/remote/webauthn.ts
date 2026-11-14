// Face ID / fingerprint on the phone, checked by this computer. The phone registers a passkey (the browser hands over
// its public key directly, so no CBOR parsing is needed); later it signs a challenge with it before the computer lets
// it act. Only ES256 passkeys are accepted, which is what iOS and Android create.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { fromBase64Url } from '../../../shared/remote/crypto';

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
}
function clientData(encoded: string, type: string, challenge: string): ClientData {
  const data = JSON.parse(Buffer.from(fromBase64Url(encoded)).toString('utf8')) as ClientData;
  if (data?.type !== type) throw new Error('验证数据类型不符');
  if (data.challenge !== challenge) throw new Error('验证已过期，请重试');
  const origin = new URL(data.origin);
  if (origin.protocol !== 'https:' && origin.hostname !== 'localhost') throw new Error('验证来源无效');
  return data;
}

export function verifyRegistration(input: {
  clientData: string;
  challenge: string;
  credentialId: string;
  publicKey: string;
  rpId: string;
}) {
  const data = clientData(input.clientData, 'webauthn.create', input.challenge);
  const host = new URL(data.origin).hostname;
  if (input.rpId !== host && !host.endsWith('.' + input.rpId)) throw new Error('验证域名不符');
  const key = createPublicKey({ key: Buffer.from(fromBase64Url(input.publicKey)), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new Error('这台手机的通行密钥类型不受支持');
  if (!fromBase64Url(input.credentialId).length) throw new Error('通行密钥无效');
  return {
    credentialId: input.credentialId,
    publicKey: input.publicKey,
    rpId: input.rpId,
    origin: data.origin,
    counter: 0,
  };
}

/** Checks one assertion; returns the new signature counter to store. */
export function verifyAssertion(input: {
  authenticatorData: string;
  clientData: string;
  signature: string;
  challenge: string;
  stored: { publicKey: string; rpId: string; origin: string; counter: number };
}) {
  const data = clientData(input.clientData, 'webauthn.get', input.challenge);
  if (data.origin !== input.stored.origin) throw new Error('验证来源不符');
  const authData = Buffer.from(fromBase64Url(input.authenticatorData));
  if (authData.length < 37) throw new Error('验证数据无效');
  const rpIdHash = createHash('sha256').update(input.stored.rpId).digest();
  if (!authData.subarray(0, 32).equals(rpIdHash)) throw new Error('验证域名不符');
  const flags = authData[32];
  // User present (bit 0) and user verified (bit 2): the phone asked for Face ID, a fingerprint or its passcode.
  if (!(flags & 0x01) || !(flags & 0x04)) throw new Error('没有完成身份验证');
  const counter = authData.readUInt32BE(33);
  if (counter && input.stored.counter && counter <= input.stored.counter) throw new Error('通行密钥计数异常');
  const signed = Buffer.concat([
    authData,
    createHash('sha256')
      .update(Buffer.from(fromBase64Url(input.clientData)))
      .digest(),
  ]);
  const key = createPublicKey({ key: Buffer.from(fromBase64Url(input.stored.publicKey)), format: 'der', type: 'spki' });
  if (!verify('sha256', signed, key, Buffer.from(fromBase64Url(input.signature)))) throw new Error('身份验证失败');
  return counter;
}
