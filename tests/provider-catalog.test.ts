import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../electron/core/storage/store';
import { ModelProviders } from '../electron/core/model/model-providers';
import { loadProviderCatalog } from '../electron/core/model/provider-catalog';
import { catalogSources, type CatalogSource } from '../shared/model-catalog';
import { nativeEndpoint } from '../electron/core/model/native-endpoint';
import { tempDir } from './helpers';

test('Higgsfield media-only connections retain the root, use the public paginated catalog, and keep manual models', async (t) => {
  const store = new Store(tempDir(t));
  t.after(() => store.close());
  const codec = { encrypt: (s: string) => s, decrypt: (s: string) => s };
  const service = new ModelProviders(store, codec);
  const p = service.save({
    name: 'HF',
    baseUrl: 'https://api.higgsfield.ai',
    apiKey: 'test-private-credential',
    uses: ['image', 'video'],
    imageProtocol: 'higgsfield-images',
    videoProtocol: 'higgsfield',
  });
  assert.equal(p.baseUrl, 'https://api.higgsfield.ai');
  const urls: string[] = [];
  let badNext = false;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    urls.push(url);
    assert.equal(new URL(url).origin, 'https://dash.higgsfield.ai');
    assert.equal(new Headers(init.headers).has('authorization'), false);
    assert.equal(init.redirect, 'error');
    const next = badNext ? 'https://other.example/steal' : 'https://dash.higgsfield.ai/api/v2/app-models/?page=2';
    return Response.json(
      url.includes('page=2')
        ? { next: null, results: [{ slug: 'studio/movie', output_type: 'video', availability_state: 'available' }] }
        : { next, results: [{ slug: 'studio/still', output_type: 'image', availability_state: 'available' }] },
    );
  });
  service.updateModel(p.id, { id: 'my/manual' });
  const [a, b] = await Promise.all([service.refresh(p.id), service.refresh(p.id)]);
  assert.equal(a.modelsError, undefined);
  assert.deepEqual(a.models, b.models);
  assert.equal(urls.length, 2);
  assert.deepEqual(service.mediaCatalog('image')[0].models, ['studio/still', 'my/manual']);
  assert.deepEqual(service.mediaCatalog('video')[0].models, ['studio/movie', 'my/manual']);
  badNext = true;
  const failed = await service.refresh(p.id);
  assert.ok(failed.modelsError);
  assert.deepEqual(failed.models, a.models);
  assert.equal(urls.length, 3);
  // Simulate a database written by v0.57.1. Do not touch an unrelated gateway's explicit mount.
  service.save({
    name: 'proxy',
    baseUrl: 'https://proxy.example/customer/v1',
    uses: ['video'],
    videoProtocol: 'higgsfield',
  });
  const old = store.data.providers!.find((p0) => p0.id === p.id)!;
  old.baseUrl += '/v1';
  old.imageProtocol = 'openai-images';
  delete store.data.providerBaseUrlVersion;
  store.save();
  const migrated = new ModelProviders(store, codec);
  assert.equal(migrated.list()[0].baseUrl, 'https://api.higgsfield.ai');
  assert.equal(migrated.list()[0].imageProtocol, 'higgsfield-images');
  assert.equal(
    migrated.key(undefined, { providerId: p.id, model: 'studio/still', contextTokens: 32000 }),
    'test-private-credential',
  );
  assert.equal(migrated.list()[1].baseUrl, 'https://proxy.example/customer/v1');
  assert.equal(migrated.list()[0].models.length, 3);
  migrated.save({ id: p.id, name: p.name, baseUrl: 'https://api.higgsfield.ai/v1' });
  assert.equal(new ModelProviders(store, codec).list()[0].baseUrl, 'https://api.higgsfield.ai/v1');
});

test('native discovery uses the platform route, response shape and enabled modality', async (t) => {
  type Fixture = [CatalogSource, string, object, string];
  const cases: Fixture[] = [
    ['xai-image', '/team/v1/image-generation-models', { models: [{ id: 'still' }] }, 'still'],
    ['xai', '/team/v1/video-generation-models', { models: [{ id: 'clip' }] }, 'clip'],
    [
      'seedance',
      '/team/api/v3/models',
      {
        data: [
          { id: 'clip', domain: 'VideoGeneration' },
          { id: 'chat', domain: 'LLM' },
        ],
      },
      'clip',
    ],
    [
      'dashscope',
      '/team/api/v1/models',
      {
        output: {
          page_no: 1,
          page_size: 100,
          total: 1,
          models: [{ model: 'wan', inference_metadata: { response_modality: ['Video'] } }],
        },
      },
      'wan',
    ],
    ['sd-webui', '/team/sdapi/v1/sd-models', [{ title: 'local [hash]' }], 'local [hash]'],
    [
      'replicate',
      '/team/v1/collections/text-to-video',
      { models: [{ owner: 'one', name: 'clip', latest_version: { id: 'rev' } }] },
      'one/clip:rev',
    ],
    [
      'vertex',
      '/team/v1beta1/publishers/google/models',
      { publisherModels: [{ name: 'publishers/google/models/veo-3.1-generate-001' }] },
      'veo-3.1-generate-001',
    ],
    ['minimax', '/team/v1/models', { data: [{ id: 'MiniMax-H3' }] }, 'MiniMax-H3'],
    ['openai', '/team/models', { data: [{ id: 'm' }] }, 'm'],
    ['anthropic', '/team/models', { data: [{ id: 'claude' }] }, 'claude'],
    [
      'gemini',
      '/team/models',
      { models: [{ name: 'models/gemini-omni', supportedGenerationMethods: ['interactions'] }] },
      'gemini-omni',
    ],
  ];
  let wanted: Fixture;
  t.mock.method(globalThis, 'fetch', async (u: string, init: RequestInit) => {
    const url = new URL(u);
    assert.equal(url.origin, 'https://gateway.example');
    assert.equal(url.pathname, wanted[1]);
    const h = new Headers(init.headers);
    assert.equal(
      h.get(wanted[0] === 'anthropic' ? 'x-api-key' : wanted[0] === 'gemini' ? 'x-goog-api-key' : 'authorization'),
      ['anthropic', 'gemini'].includes(wanted[0]) ? 'catalog-key' : 'Bearer catalog-key',
    );
    return Response.json(wanted[2]);
  });
  for (wanted of cases) {
    const [s, , , id] = wanted;
    const baseUrl =
      'https://gateway.example/team' +
      (s === 'vertex' ? '/v1/projects/my-project/locations/us-central1/publishers/google' : '');
    const list = await loadProviderCatalog(
      s,
      { baseUrl, uses: ['image', 'video'] },
      'catalog-key',
      new AbortController().signal,
    );
    assert.deepEqual(
      list.map((m) => m.id),
      [id],
      s,
    );
  }
  assert.equal(nativeEndpoint('https://gateway.example/team/v1', ''), 'https://gateway.example/team/v1');
  assert.equal(
    nativeEndpoint('https://gateway.example/team/api/v3', '/api/v3/contents/generations/tasks'),
    'https://gateway.example/team/api/v3/contents/generations/tasks',
  );
  for (const videoProtocol of ['kling', 'runway', 'luma', 'vidu'] as const)
    assert.deepEqual(catalogSources({ baseUrl: 'https://gateway.example', uses: ['video'], videoProtocol }), []);
});

test('fal queries video categories without forwarding generation credentials', async (t) => {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async (u: string, init: RequestInit) => {
    const url = new URL(u);
    assert.equal(url.origin, 'https://api.fal.ai');
    assert.equal(new Headers(init.headers).get('authorization'), null);
    count++;
    const category = url.searchParams.get('category');
    return Response.json({
      models: [{ endpoint_id: 'demo/' + category, metadata: { status: 'active' } }],
      has_more: false,
    });
  });
  const rows = await loadProviderCatalog(
    'fal',
    { baseUrl: 'https://queue.fal.run', uses: ['video'] },
    'secret',
    new AbortController().signal,
  );
  assert.equal(count, 3);
  assert.equal(new Set(rows.map((m) => m.id)).size, 3);
});
