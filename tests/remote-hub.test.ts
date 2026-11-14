import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startRelay } from '../relay/src/relay';
import { RemoteHub, type RemoteDeps } from '../electron/core/remote/remote-hub';
import type { DirectHandlers } from '../electron/core/remote/direct';
import { Store } from '../electron/core/storage/store';
import { RemoteClient, type ClientStatus, type SocketLike } from '../shared/remote/client';
import { fromBase64Url, generateAgreementKey } from '../shared/remote/crypto';
import { chatKey, readPairingUrl, type ChatDelta, type HomeView } from '../shared/remote/protocol';
import { applyEntityDelta } from '../shared/state-sync';
import type { ChatMessage, InteractionRequest } from '../shared/types/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { until } from './helpers';

const UA_PUBLIC = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';

async function setup(t: test.TestContext, direct?: RemoteDeps['direct']) {
  const relay = await startRelay({ port: 0 });
  const dir = mkdtempSync(join(tmpdir(), 'aelion-remote-')),
    store = new Store(dir);
  if (!store.data.bots.some((bot) => bot.id === 'b1'))
    store.data.bots.push({
      id: 'b1',
      name: '研究助手',
      soul: '',
      color: '#8b6bea',
      createdAt: new Date().toISOString(),
      memories: [],
    });
  store.message('b1', 'user', '核对一下三家的价格');
  store.message('b1', 'assistant', '三家都涨价了。');
  const calls: Array<{ method: string; args: unknown[] }> = [],
    pushes: Array<{ url: string; headers: Record<string, string> }> = [];
  const requests: InteractionRequest[] = [];
  const deps: RemoteDeps = {
    store,
    dataDir: store.dir,
    codec: { encrypt: (value) => 'x' + value, decrypt: (value) => value.slice(1) },
    version: '0.54.0',
    call: async (method, ...args) => {
      calls.push({ method, args });
      if (method === 'importAttachments') return [{ id: 'a1', name: 'photo.jpg', size: 3, mime: 'image/jpeg' }];
      return undefined;
    },
    streams: () => [],
    interactions: () => requests,
    computer: {
      state: { desktops: {} },
      stateFor: (botId) => ({ botId, status: 'idle', manualControl: false }),
    },
    vmStatus: () => 'stopped',
    groups: () => undefined,
    speech: () => ({ input: true, output: false }),
    attachments: {
      bytes: () => Buffer.from('abc'),
      metadata: () => ({ name: 'report.md', mime: 'text/markdown', size: 3 }),
    },
    permissionMode: () => 'auto',
    idleSeconds: () => 9999,
    keepAwake: () => {},
    changed: () => {},
    fetch: (async (url: URL, init: RequestInit) => {
      pushes.push({ url: String(url), headers: init.headers as Record<string, string> });
      return new Response(null, { status: 201 });
    }) as typeof fetch,
  };
  const hub = new RemoteHub({ ...deps, ...(direct ? { direct } : {}) });
  // Stop the hub before the relay and the folder go away: closing sessions writes remote.json.
  t.after(async () => {
    hub.stop();
    await relay.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await hub.update({ enabled: true, relayUrl: `http://localhost:${relay.port}` });
  await until(() => hub.view().status === 'online', { message: () => JSON.stringify(hub.view()) });
  return { relay, store, hub, calls, pushes, requests };
}

function phone(
  link: { u: string; r: string; k: string; n: string },
  device: CryptoKeyPair,
  pairing?: { id: string; secret: Uint8Array },
) {
  const statuses: ClientStatus[] = [],
    events: Array<{ name: string; data: unknown }> = [];
  const client = new RemoteClient({
    computer: { relay: link.u, room: link.r, key: link.k, name: link.n },
    device,
    pairing,
    socket: (url) => new WebSocket(url) as unknown as SocketLike,
    onStatus: (status) => statuses.push(status),
    onEvent: (name, data) => events.push({ name, data }),
  });
  client.connect();
  return { client, statuses, events };
}

test('a phone pairs by QR code, is allowed at the computer, then reads and acts within its limits', async (t) => {
  const { hub, store, calls, pushes, requests } = await setup(t);
  await hub.startPairing();
  const pairing = hub.view().pairing!;
  assert.match(pairing.qrSvg, /<svg/);
  const link = readPairingUrl(new URL(pairing.url).hash)!;
  assert.equal(link.u, hub.relayUrl);
  const device = await generateAgreementKey();
  const first = phone(link, device, { id: link.i, secret: fromBase64Url(link.s) });
  t.after(() => first.client.close());

  // Waiting for the user: the phone can only name itself.
  await until(() => first.client.status === 'pending');
  await first.client.call('device.update', { name: '测试手机' });
  await until(() => hub.view().pairing?.request?.name === '测试手机');
  await assert.rejects(first.client.call('home.subscribe'), { code: 'remote.pending' });
  hub.decidePairing(true);
  await until(() => first.client.status === 'ready');
  assert.equal(hub.view().pairing, undefined);
  assert.deepEqual(
    hub.view().devices.map(({ name, online }) => ({ name, online })),
    [{ name: '测试手机', online: true }],
  );

  const home = (await first.client.call('home.subscribe')) as HomeView;
  const bot = home.bots.find((item) => item.id === 'b1')!;
  assert.equal(bot.last?.text, '三家都涨价了。');
  assert.equal(home.speech.input, true);

  const chat = await first.client.call('chat.open', { botId: 'b1' });
  assert.equal(chat.key, chatKey('b1'));
  assert.deepEqual(
    chat.messages.map((message) => message.content),
    ['核对一下三家的价格', '三家都涨价了。'],
  );

  // A new message reaches the open chat as a delta.
  store.message('b1', 'user', '再看看年付');
  hub.changed();
  await until(() => first.events.some((event) => event.name === 'chat'));
  const delta = first.events.find((event) => event.name === 'chat')!.data as ChatDelta;
  const messages = applyEntityDelta<ChatMessage>(chat.messages, delta.messages!);
  assert.equal(messages.at(-1)!.content, '再看看年付');

  // Actions go through the app's handlers; the phone cannot turn every check off or call anything else.
  await first.client.call('chat.send', { botId: 'b1', message: '继续' });
  assert.deepEqual(calls.at(-1), { method: 'send', args: [{ botId: 'b1', message: '继续' }] });
  await assert.rejects(first.client.call('permission.set', { botId: 'b1', mode: 'full' } as never), {
    code: 'remote.forbidden',
  });
  const untyped = first.client.call.bind(first.client) as unknown as (
    method: string,
    params?: unknown,
  ) => Promise<unknown>;
  await assert.rejects(untyped('vmTerminal', 'rm -rf /'), { code: 'remote.forbidden' });
  const upload = await first.client.call('files.upload', {
    scope: { kind: 'bot', id: 'b1' },
    name: 'photo.jpg',
    bytes: new Uint8Array([1, 2, 3]),
  });
  assert.equal(upload.id, 'a1');
  const file = await first.client.call('files.read', { id: 'a1' });
  assert.deepEqual([...file.bytes], [97, 98, 99]);

  // A Bot asks for permission while the app is in the background: the phone gets a push.
  await first.client.call('push.subscribe', {
    endpoint: 'https://push.example.net/sub',
    keys: { p256dh: UA_PUBLIC, auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
  });
  requests.push({
    id: 'r1',
    botId: 'b1',
    runId: 'run1',
    createdAt: new Date().toISOString(),
    kind: 'host_permission',
    details: { operation: 'command', reason: '运行测试', command: 'pnpm test' },
  });
  hub.changed();
  await until(() => pushes.length === 1);
  assert.equal(pushes[0].url, 'https://push.example.net/sub');
  assert.equal(pushes[0].headers.urgency, 'high');

  // The phone comes back later with its key alone.
  first.client.close();
  const again = phone(link, device);
  t.after(() => again.client.close());
  await until(() => again.client.status === 'ready');

  // A phone the computer does not know is refused.
  const stranger = phone(link, await generateAgreementKey());
  t.after(() => stranger.client.close());
  await until(() => stranger.client.status === 'rejected');

  // Removing the phone at the computer disconnects it for good.
  hub.removeDevice(hub.view().devices[0].id);
  await until(() => again.client.status === 'rejected');
});

test('a pairing the user declines leaves the phone rejected', async (t) => {
  const { hub } = await setup(t);
  await hub.startPairing();
  const link = readPairingUrl(new URL(hub.view().pairing!.url).hash)!;
  const candidate = phone(link, await generateAgreementKey(), { id: link.i, secret: fromBase64Url(link.s) });
  t.after(() => candidate.client.close());
  await until(() => candidate.client.status === 'pending');
  hub.decidePairing(false);
  await until(() => candidate.client.status === 'rejected');
  assert.equal(hub.view().devices.length, 0);
});

test('a phone hears when its computer goes away and comes back', async (t) => {
  const { hub } = await setup(t);
  await hub.startPairing();
  const link = readPairingUrl(new URL(hub.view().pairing!.url).hash)!;
  const device = await generateAgreementKey();
  const client = phone(link, device, { id: link.i, secret: fromBase64Url(link.s) });
  t.after(() => client.client.close());
  await until(() => client.client.status === 'pending');
  hub.decidePairing(true);
  await until(() => client.client.status === 'ready');
  await hub.update({ enabled: false });
  await until(() => client.client.status === 'offline');
  await hub.update({ enabled: true });
  await until(() => client.client.status === 'ready');
});

test('a phone moves to a direct connection without losing order, and back to the relay when it breaks', async (t) => {
  const answered = new Map<string, DirectHandlers>();
  let desktopSent = 0,
    toPhone: ((frame: Uint8Array) => void) | undefined;
  const { hub } = await setup(t, {
    answer: async (id, _sdp, iceServers, handlers) => {
      assert.match(iceServers[0].urls, /^stun:localhost:3478$/);
      answered.set(id, handlers);
      return 'answer-sdp';
    },
    candidate: () => {},
    send: (_id, data) => {
      desktopSent++;
      const copy = data.slice();
      setTimeout(() => toPhone?.(copy));
    },
    close: (id) => answered.delete(id),
  });
  await hub.startPairing();
  const link = readPairingUrl(new URL(hub.view().pairing!.url).hash)!;
  const device = await generateAgreementKey();
  const { client, statuses } = phone(link, device, { id: link.i, secret: fromBase64Url(link.s) });
  t.after(() => client.close());
  await until(() => client.status === 'pending');
  hub.decidePairing(true);
  await until(() => client.status === 'ready');
  assert.ok(client.welcome?.capabilities.includes('direct'));

  assert.deepEqual(await client.call('direct.offer', { sdp: 'offer-sdp' }), { sdp: 'answer-sdp' });
  const desktopSide = [...answered.values()][0];
  let phoneSent = 0;
  toPhone = (frame) => client.receiveDirect(frame);
  // Both ends open at once; calls are already in flight through the relay while they switch.
  const during = client.call('home.subscribe');
  client.attachDirect({
    send: (frame) => {
      phoneSent++;
      const copy = frame.slice();
      setTimeout(() => desktopSide.frame(copy));
    },
    close: () => {},
  });
  desktopSide.open();
  assert.ok((await during).bots.length > 0);
  for (let index = 0; index < 5; index++) await client.call('chat.open', { botId: 'b1' });
  assert.ok(client.direct);
  assert.ok(phoneSent >= 5 && desktopSent >= 5, `direct frames: phone ${phoneSent}, desktop ${desktopSent}`);

  // The direct connection breaks: the phone connects again through the relay.
  const readyBefore = statuses.filter((status) => status === 'ready').length;
  desktopSide.close();
  await until(() => statuses.filter((status) => status === 'ready').length > readyBefore);
  assert.equal(client.direct, false);
  assert.ok((await client.call('home.subscribe')).bots.length > 0);
});
