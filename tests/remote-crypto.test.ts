import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptHandshake,
  exportPublicKey,
  fromBase64Url,
  generateAgreementKey,
  randomBytes,
  startHandshake,
  toBase64Url,
  type Bytes,
} from '../shared/remote/crypto';
import { Wire, decodeJson, encodeJson } from '../shared/remote/wire';
import { pairingUrl, readPairingUrl, normalizeRelayUrl } from '../shared/remote/protocol';
import { until } from './helpers';

async function pair(options: { pairing?: boolean; wrongSecret?: boolean } = {}) {
  const desktop = await generateAgreementKey(true),
    desktopPublic = await exportPublicKey(desktop.publicKey),
    device = await generateAgreementKey(),
    secret = randomBytes(32);
  const phone = await startHandshake({
    device,
    desktopKey: desktopPublic,
    pairing: options.pairing ? { id: 'p1', secret: options.wrongSecret ? randomBytes(32) : secret } : undefined,
  });
  const accepted = await acceptHandshake({
    desktop,
    desktopPublic,
    hello: phone.hello,
    pairingSecret: (id) => (id === 'p1' ? secret : undefined),
  });
  return { phone: await phone.finish(accepted.reply), desktop: accepted.channel, accepted, device, desktopPublic };
}

test('the handshake gives both sides the same keys, in both directions', async () => {
  const { phone, desktop, accepted, device } = await pair();
  const one = await phone.seal(new TextEncoder().encode('from phone'));
  assert.equal(new TextDecoder().decode(await desktop.open(one)), 'from phone');
  const two = await desktop.seal(new TextEncoder().encode('from desktop'));
  assert.equal(new TextDecoder().decode(await phone.open(two)), 'from desktop');
  assert.equal(accepted.phoneKey, toBase64Url(await exportPublicKey(device.publicKey)));
  assert.equal(accepted.paired, false);
});

test('a pairing proof holds only with the pairing secret', async () => {
  assert.equal((await pair({ pairing: true })).accepted.paired, true);
  assert.equal((await pair({ pairing: true, wrongSecret: true })).accepted.paired, false);
});

test('a phone that does not hold its private key cannot derive the keys', async () => {
  const desktop = await generateAgreementKey(true),
    desktopPublic = await exportPublicKey(desktop.publicKey);
  const victim = await generateAgreementKey(),
    attacker = await generateAgreementKey();
  // The attacker claims the victim's public key but only holds its own private key.
  const forged = await startHandshake({
    device: { publicKey: victim.publicKey, privateKey: attacker.privateKey },
    desktopKey: desktopPublic,
  });
  const accepted = await acceptHandshake({ desktop, desktopPublic, hello: forged.hello });
  const channel = await forged.finish(accepted.reply);
  await assert.rejects(accepted.channel.open(await channel.seal(new Uint8Array([1, 2, 3]))));
});

test('a desktop impersonator cannot answer a phone', async () => {
  const real = await generateAgreementKey(true),
    impostor = await generateAgreementKey(true);
  const phone = await startHandshake({
    device: await generateAgreementKey(),
    desktopKey: await exportPublicKey(real.publicKey),
  });
  const accepted = await acceptHandshake({
    desktop: impostor,
    desktopPublic: await exportPublicKey(impostor.publicKey),
    hello: phone.hello,
  });
  const channel = await phone.finish(accepted.reply);
  await assert.rejects(channel.open(await accepted.channel.seal(new Uint8Array([1]))));
});

test('tampered, replayed and reordered frames do not open', async () => {
  const tampered = await pair();
  const frame = await tampered.phone.seal(new Uint8Array([1, 2, 3]));
  frame[0] ^= 1;
  await assert.rejects(tampered.desktop.open(frame));

  const replayed = await pair();
  const first = await replayed.phone.seal(new Uint8Array([1]));
  await replayed.desktop.open(first);
  await assert.rejects(replayed.desktop.open(first));

  const reordered = await pair();
  const a = await reordered.phone.seal(new Uint8Array([1])),
    b = await reordered.phone.seal(new Uint8Array([2]));
  await assert.rejects(reordered.desktop.open(b));
  // Once a frame failed, the channel stays closed.
  await assert.rejects(reordered.desktop.open(a));
});

test('wire messages carry bytes, split large values and keep streams apart', async () => {
  const { phone, desktop } = await pair();
  const received: unknown[] = [],
    streams: Array<[number, number]> = [];
  const toDesktop: Wire = new Wire(phone, (frame) => desktopWire.receive(frame), {
    json: () => {},
    stream: () => {},
    fail: (error) => assert.fail(error),
  });
  const desktopWire = new Wire(desktop, () => {}, {
    json: (value) => received.push(value),
    stream: (id, data) => streams.push([id, data.length]),
    fail: (error) => assert.fail(error),
  });
  const big = randomBytes(700_000);
  toDesktop.sendJson({ t: 'call', id: 1, params: { bytes: big } });
  toDesktop.sendStream(7, randomBytes(300_000));
  toDesktop.sendJson({ small: true });
  await until(() => received.length === 2);
  const first = received[0] as { params: { bytes: Bytes } };
  assert.deepEqual(first.params.bytes, big);
  assert.deepEqual(received[1], { small: true });
  assert.deepEqual(streams, [
    [7, 196608],
    [7, 300_000 - 196608],
  ]);
});

test('JSON bytes round-trip and pairing links read back', () => {
  const value = { a: new Uint8Array([0, 255, 7]), b: 'text' };
  assert.deepEqual(decodeJson(encodeJson(value)), value);
  const link = {
    v: 1 as const,
    u: 'https://relay.example.com',
    r: 'room1234567890abcdef',
    k: 'key',
    i: 'id',
    s: 'secret',
    n: '家里的电脑',
  };
  const url = pairingUrl('https://app.example.com/', link);
  assert.ok(url.startsWith('https://app.example.com/#pair='));
  assert.deepEqual(readPairingUrl(new URL(url).hash), link);
  assert.equal(readPairingUrl('#pair=bm90LWpzb24'), undefined);
  assert.deepEqual(fromBase64Url(toBase64Url(new Uint8Array([251, 255]))), new Uint8Array([251, 255]));
});

test('relay addresses are https origins', () => {
  assert.equal(normalizeRelayUrl('app.example.com/'), 'https://app.example.com');
  assert.equal(normalizeRelayUrl('http://localhost:8790'), 'http://localhost:8790');
  assert.equal(normalizeRelayUrl(''), '');
  assert.throws(() => normalizeRelayUrl('http://app.example.com'));
  assert.throws(() => normalizeRelayUrl('https://app.example.com/path'));
});
