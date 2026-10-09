import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { version } from '../package.json';
import { modelFetch } from '../electron/core/model/model-http';
import { AELION_USER_AGENT, installAelionUserAgent } from '../electron/core/net/user-agent';

async function listen(t: test.TestContext) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers['user-agent'] || '');
    res.end('ok');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('test server did not bind');
  return { seen, origin: `http://127.0.0.1:${address.port}` };
}

test('Node fetch and model requests identify as AelionBot unless a caller set a User-Agent', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  assert.equal(AELION_USER_AGENT, `AelionBot/${version} (+https://aelion.chat)`);
  const { seen, origin } = await listen(t);
  installAelionUserAgent();
  installAelionUserAgent();
  await fetch(`${origin}/default`);
  await fetch(`${origin}/custom`, { headers: { 'User-Agent': 'CustomAgent/1' } });
  await fetch(new Request(`${origin}/request`));
  await fetch(new Request(`${origin}/request-custom`, { headers: { 'User-Agent': 'Kept/2' } }));
  await modelFetch(`${origin}/model`);
  await modelFetch(`${origin}/model-custom`, { headers: { 'User-Agent': 'Provider/3' } });
  assert.deepEqual(seen, [
    AELION_USER_AGENT,
    'CustomAgent/1',
    AELION_USER_AGENT,
    'Kept/2',
    AELION_USER_AGENT,
    'Provider/3',
  ]);
});
