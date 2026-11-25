import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateModelImage } from '../electron/core/image/image-generation';
import { ImageGenerationError } from '../electron/core/image/image-errors';
import type { ModelClient } from '../electron/core/model/model';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XK3sAAAAASUVORK5CYII=',
  'base64',
);
const base = 'https://api.higgsfield.ai',
  key = 'credential-fixture';
const signal = () => AbortSignal.timeout(5000);
const config = {
  providerId: 'one',
  baseUrl: base,
  model: 'vendor/image/edit',
  contextTokens: 32000,
  hasKey: true,
  imageProtocol: 'higgsfield-images' as const,
};
test('Higgsfield image editing resolves and caches the reference field, uploads once, and downloads the true image without an API credential', async (t) => {
  const calls: string[] = [];
  let schema = 'image_url',
    model = 'vendor/image/edit-single';
  t.mock.method(globalThis, 'fetch', async (u: string, i: RequestInit) => {
    const url = new URL(u),
      h = new Headers(i.headers);
    calls.push(url.pathname);
    if (url.hostname === 'dash.higgsfield.ai') {
      assert.equal(h.get('authorization'), null);
      return Response.json({
        input_schema: { properties: { [schema]: { type: schema === 'image_url' ? 'string' : 'array' } } },
      });
    }
    assert.equal(url.origin, base);
    if (url.pathname === '/upload') {
      assert.equal(i.method, 'PUT');
      assert.equal(h.get('authorization'), null);
      assert.deepEqual(Buffer.from(i.body as Uint8Array), png);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/result') {
      assert.equal(h.get('authorization'), null);
      return new Response(new Uint8Array(png));
    }
    assert.equal(h.get('authorization'), 'Key ' + key);
    if (url.pathname === '/files/generate-upload-url')
      return Response.json({
        upload_url: base + '/upload',
        public_url: base + '/ref',
        upload_headers: { 'content-type': 'image/png' },
      });
    if (url.pathname === '/' + model) {
      const payload = JSON.parse(String(i.body));
      assert.deepEqual(payload, {
        prompt: 'test',
        aspect_ratio: '21:9',
        resolution: '3K',
        style_id: 'custom',
        [schema]: schema === 'image_url' ? base + '/ref' : [base + '/ref'],
      });
      return Response.json({ request_id: 'img-7' });
    }
    assert.equal(url.pathname, '/requests/img-7/status');
    return Response.json({ status: 'completed', images: [{ url: base + '/result' }] });
  });
  for (const [nextSchema, nextModel] of [
    ['image_url', 'vendor/image/edit-single'],
    ['image_url', 'vendor/image/edit-single'],
    ['image_urls', 'vendor/image/edit-multi'],
  ] as const) {
    schema = nextSchema;
    model = nextModel;
    const out = await generateModelImage({
      model: {} as ModelClient,
      key,
      config: { ...config, model },
      signal: signal(),
      job: {
        prompt: 'test',
        aspect: '21:9',
        resolution: '3K',
        input: { style_id: 'custom' },
        reference: [{ name: 'ref.png', bytes: png, mediaType: 'image/png' }],
      },
    });
    assert.equal(out.mediaType, 'image/png');
    assert.deepEqual(out.bytes, png);
  }
  assert.equal(calls.filter((path) => path === '/vendor/image/edit-single').length, 2);
  assert.equal(calls.filter((path) => path === '/api/v2/app-models/vendor/image/edit-single/').length, 1);
  assert.equal(calls.filter((path) => path === '/api/v2/app-models/vendor/image/edit-multi/').length, 1);
});
test('native text-to-image works through a custom prefix and returns bytes using the saved protocol', async (t) => {
  let origin = '';
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    const path = req.url!;
    calls.push(path);
    if (path === '/out') {
      assert.equal(req.headers.authorization, undefined);
      res.setHeader('content-type', 'image/png');
      res.end(png);
      return;
    }
    assert.equal(req.headers.authorization, 'Key ' + key);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      assert.deepEqual(JSON.parse(body), { prompt: 'paint', resolution: '2k' });
      res.end(JSON.stringify({ request_id: 'r1' }));
    } else res.end(JSON.stringify({ status: 'completed', images: [{ url: origin + '/out' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const result = await generateModelImage({
    model: {} as ModelClient,
    key,
    config: { ...config, baseUrl: origin + '/tenant/v1', model: 'vendor/text-to-image' },
    signal: signal(),
    job: { prompt: 'paint', resolution: '2k' },
  });
  assert.deepEqual(result.bytes, png);
  assert.equal(result.protocol, 'higgsfield-images');
  assert.deepEqual(calls, ['/tenant/v1/vendor/text-to-image', '/tenant/v1/requests/r1/status', '/out']);
});
test('Higgsfield text-to-image does not upload a reference and never submits another generation after a terminal failure', async (t) => {
  let posts = 0;
  t.mock.method(globalThis, 'fetch', async (u: string, i: RequestInit) => {
    if (i.method === 'POST') {
      posts++;
      return Response.json({ request_id: 'finished' });
    }
    assert.equal(new URL(u).pathname, '/requests/finished/status');
    return Response.json({ status: 'nsfw' });
  });
  await assert.rejects(
    generateModelImage({ model: {} as ModelClient, key, config, signal: signal(), job: { prompt: 'test' } }),
    (e: unknown) => e instanceof ImageGenerationError && e.nextStep === 'revise-request',
  );
  assert.equal(posts, 1);
});
test('Higgsfield image polling retries transient transport errors without resubmitting', async (t) => {
  let posts = 0,
    polls = 0;
  t.mock.method(globalThis, 'fetch', async (u: string, i: RequestInit) => {
    const url = new URL(u);
    if (i.method === 'POST') {
      posts++;
      return Response.json({ request_id: 'retry-1' });
    }
    if (url.pathname === '/out') return new Response(new Uint8Array(png));
    polls++;
    if (polls === 1) throw new TypeError('connection reset');
    return Response.json({ status: 'completed', images: [{ url: base + '/out' }] });
  });
  const result = await generateModelImage({
    model: {} as ModelClient,
    key,
    config,
    signal: signal(),
    job: { prompt: 'paint' },
  });
  assert.deepEqual(result.bytes, png);
  assert.equal(posts, 1);
  assert.equal(polls, 2);
});
