import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { startRelay } from '../relay/src/relay';
import { exportPublicKey, generateSigningKey, roomId, sign, toBase64Url, utf8 } from '../shared/remote/crypto';
import { tempDir, until } from './helpers';

/** A socket that records text messages and binary frames as they arrive. */
function open(url: string) {
  const socket = new WebSocket(url);
  const texts: Array<Record<string, unknown>> = [],
    frames: Buffer[] = [];
  socket.on('message', (data, binary) => {
    if (binary) frames.push(Buffer.from(data as Buffer));
    else texts.push(JSON.parse(String(data)));
  });
  const closed = new Promise<number>((ok) => socket.on('close', (code) => ok(code)));
  return { socket, texts, frames, closed };
}

async function desktop(base: string, key: CryptoKeyPair) {
  const connection = open(base + '/v1/desktop');
  await until(() => connection.texts.some((message) => message.t === 'challenge'));
  const nonce = String(connection.texts.find((message) => message.t === 'challenge')!.nonce);
  connection.socket.send(
    JSON.stringify({
      t: 'auth',
      key: toBase64Url(await exportPublicKey(key.publicKey)),
      sig: toBase64Url(await sign(key.privateKey, utf8('aelion-relay-v1:' + nonce))),
    }),
  );
  await until(() => connection.texts.some((message) => message.t === 'ready'));
  return connection;
}
const frame = (conn: number, text: string) => {
  const payload = Buffer.from(text),
    out = Buffer.alloc(payload.length + 4);
  out.writeUInt32BE(conn, 0);
  payload.copy(out, 4);
  return out;
};

test('the relay pairs a phone with its desktop by room and forwards frames both ways', async (t) => {
  const relay = await startRelay({ port: 0 });
  t.after(() => relay.close());
  const base = `ws://127.0.0.1:${relay.port}`;
  const key = await generateSigningKey(true),
    room = await roomId(await exportPublicKey(key.publicKey));

  const pc = await desktop(base, key);
  assert.equal(pc.texts.find((message) => message.t === 'ready')!.room, room);

  const phone = open(`${base}/v1/client?room=${room}`);
  await until(() => phone.texts.some((message) => message.t === 'online'));
  await until(() => pc.texts.some((message) => message.t === 'open'));
  const conn = Number(pc.texts.find((message) => message.t === 'open')!.conn);

  phone.socket.send(Buffer.from('hello desktop'));
  await until(() => pc.frames.length === 1);
  assert.equal(pc.frames[0].readUInt32BE(0), conn);
  assert.equal(pc.frames[0].subarray(4).toString(), 'hello desktop');

  pc.socket.send(frame(conn, 'hello phone'));
  await until(() => phone.frames.length === 1);
  assert.equal(phone.frames[0].toString(), 'hello phone');

  // The desktop goes away: the phone hears it and stays connected; when it returns the phone hears that too.
  pc.socket.close();
  await until(() => phone.texts.some((message) => message.t === 'offline' && message.since));
  const back = await desktop(base, key);
  await until(() => phone.texts.filter((message) => message.t === 'online').length === 2);
  await until(() => back.texts.some((message) => message.t === 'open' && message.conn === conn));

  phone.socket.close();
  await until(() => back.texts.some((message) => message.t === 'close' && message.conn === conn));
  back.socket.close();
});

test('a desktop must sign the challenge with the key its room comes from', async (t) => {
  const relay = await startRelay({ port: 0 });
  t.after(() => relay.close());
  const connection = open(`ws://127.0.0.1:${relay.port}/v1/desktop`);
  await until(() => connection.texts.length > 0);
  const key = await generateSigningKey(true),
    other = await generateSigningKey(true);
  connection.socket.send(
    JSON.stringify({
      t: 'auth',
      key: toBase64Url(await exportPublicKey(key.publicKey)),
      sig: toBase64Url(await sign(other.privateKey, utf8('aelion-relay-v1:' + connection.texts[0].nonce))),
    }),
  );
  assert.equal(await connection.closed, 4401);
});

test('a phone waits while its desktop is away, and rooms have a device limit', async (t) => {
  const relay = await startRelay({ port: 0, maxClientsPerRoom: 1 });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}/v1/client?room=abcdefghijklmnopqrstuvwxyz`;
  const first = open(url);
  await until(() => first.texts.some((message) => message.t === 'offline'));
  const second = open(url);
  assert.equal(await second.closed, 4429);
  first.socket.close();
});

test('the relay serves the phone app and refuses paths outside it', async (t) => {
  const root = tempDir(t),
    dir = join(root, 'public');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(join(dir, 'assets', 'app-1234.js'), 'console.log(1)');
  writeFileSync(join(root, 'secret.txt'), 'nope');
  const relay = await startRelay({ port: 0, publicDir: dir });
  t.after(() => relay.close());
  const base = `http://127.0.0.1:${relay.port}`;

  const index = await fetch(base + '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy') || '', /connect-src 'self'/);
  assert.equal(index.headers.get('cache-control'), 'no-cache');
  // A route inside the app loads the page.
  assert.equal((await fetch(base + '/chat/research')).status, 200);
  const asset = await fetch(base + '/assets/app-1234.js');
  assert.match(asset.headers.get('cache-control') || '', /immutable/);
  assert.equal((await fetch(base + '/missing.js')).status, 404);
  assert.notEqual((await fetch(base + '/..%2fsecret.txt')).status, 200);
  assert.deepEqual(await (await fetch(base + '/healthz')).json(), { ok: true, desktops: 0, clients: 0 });
});
