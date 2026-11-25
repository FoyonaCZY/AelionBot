import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store } from '../electron/core/storage/store';
import { ModelProviders } from '../electron/core/model/model-providers';
import { generateVideo } from '../electron/core/video/video-generation';
import { videoPlan, type VideoAccess, type VideoJob } from '../electron/core/video/video-protocols';
import { VIDEO_PROTOCOLS, type VideoProtocol } from '../shared/types/media-types';
import { Harness } from '../electron/core/agent/harness';
import type { ModelClient } from '../electron/core/model/model';
import type { VmController } from '../electron/core/vm/vm';
import { tempDir, until, answer } from './helpers';

const clip = Buffer.from('000000186674797069736f6d0000000069736f6d', 'hex');
const asset = 'https://cdn.example/asset.mp4';
const access = (protocol: VideoProtocol, baseUrl = 'https://studio.example/v1'): VideoAccess => ({
  baseUrl,
  protocol,
  key: 'test-key',
  model: 'vendor/model',
  defaults: {},
});
const matrix: Record<VideoProtocol, [string, string, string | null]> = {
  dashscope: ['/api/v1/services/aigc/video-generation/video-synthesis', '/video-synthesis', '/video-synthesis'],
  seedance: ['/api/v3/contents/generations/tasks', '/tasks', '/tasks'],
  kling: ['/v1/videos/text2video', '/image2video', '/omni-video'],
  minimax: ['/v1/video_generation', '/video_generation', null],
  'minimax-v2': ['/v2/video_generation', '/video_generation', '/video_generation'],
  vidu: ['/ent/v2/text2video', '/img2video', '/reference2video'],
  runway: ['/v1/text_to_video', '/image_to_video', '/video_to_video'],
  luma: ['/dream-machine/v1/generations/video', '/video', '/video/modify'],
  openai: ['/v1/videos', '/videos', '/videos/edits'],
  xai: ['/v1/videos/generations', '/generations', '/edits'],
  vertex: [':predictLongRunning', ':predictLongRunning', ':predictLongRunning'],
  gemini: ['/v1beta/interactions', '/interactions', '/interactions'],
  replicate: ['/v1/predictions', '/predictions', '/predictions'],
  fal: ['/vendor/model', '/vendor/model', '/vendor/model'],
};
for (const protocol of Object.keys(VIDEO_PROTOCOLS) as VideoProtocol[])
  test(protocol + ' selects the text, image and video routes and sends the supplied media', () => {
    const [txt, img, vid] = matrix[protocol],
      service = access(protocol);
    assert.ok(videoPlan(service, { prompt: 'coast' }).submit.url.endsWith(txt));
    for (const [kind, path] of [
      ['image', img],
      ['video', vid],
    ] as const) {
      const source: VideoJob['source'] = {
        kind,
        mime: kind === 'video' ? 'video/mp4' : 'image/png',
        ...(['openai', 'vertex'].includes(protocol) ? { bytes: clip } : { url: asset }),
      };
      const job = { prompt: 'coast', source };
      if (!path) {
        assert.throws(() => videoPlan(service, job), { code: 'video.input_unsupported' });
        continue;
      }
      const plan = videoPlan(service, job);
      assert.ok(plan.submit.url.endsWith(path));
      if (plan.submit.body instanceof FormData)
        assert.ok(plan.submit.body.get(kind === 'image' ? 'input_reference' : 'video') instanceof Blob);
      else assert.ok(JSON.stringify(plan.submit.body).includes(source.bytes ? clip.toString('base64') : asset));
    }
  });

const completedFixtures: Record<VideoProtocol, [object, object, string]> = {
  dashscope: [{ output: { task_id: 'job' } }, { output: { task_status: 'SUCCEEDED', video_url: asset } }, asset],
  seedance: [{ id: 'job' }, { status: 'succeeded', content: { video_url: asset } }, asset],
  kling: [
    { data: { task_id: 'job' } },
    { data: { task_status: 'succeed', task_result: { videos: [{ url: asset }] } } },
    asset,
  ],
  minimax: [{ task_id: 'job' }, { status: 'Success', file_id: 'file-id' }, 'file-id'],
  'minimax-v2': [{ task_id: 'job' }, { task: { status: 'succeeded', content: { url: asset } } }, asset],
  vidu: [{ task_id: 'job' }, { state: 'success', creations: [{ url: asset }] }, asset],
  runway: [{ id: 'job' }, { status: 'SUCCEEDED', output: [asset] }, asset],
  luma: [{ id: 'job' }, { state: 'completed', assets: { video: asset } }, asset],
  openai: [{ id: 'job' }, { status: 'completed' }, 'https://studio.example/v1/videos/job/content'],
  gemini: [
    { id: 'job' },
    { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', uri: 'files/result' }] }] },
    'files/result',
  ],
  vertex: [{ name: 'job' }, { done: true, response: { videos: [{ bytesBase64Encoded: 'mp4' }] } }, 'mp4'],
  xai: [{ request_id: 'job' }, { status: 'done', video: { url: asset } }, asset],
  fal: [{ request_id: 'job' }, { status: 'COMPLETED' }, 'https://studio.example/vendor/model/requests/job'],
  replicate: [{ id: 'job' }, { status: 'succeeded', output: asset }, asset],
};
test('each protocol extracts its own task ID, terminal state and result location', () => {
  for (const protocol of Object.keys(completedFixtures) as VideoProtocol[]) {
    const [submitted, done, location] = completedFixtures[protocol],
      plan = videoPlan(access(protocol), { prompt: 'coast' });
    assert.equal(plan.id(submitted), 'job', protocol);
    const result = plan.result(done, 'job');
    assert.equal(
      result.contentPath || result.resultPath || result.fileId || result.base64 || result.url,
      location,
      protocol,
    );
    assert.ok(['succeeded', 'succeed', 'success', 'done', 'completed'].includes(result.status!.toLowerCase()));
  }
});
test('all video protocols retrieve playable bytes from local protocol fixtures', async (t) => {
  let protocol: VideoProtocol = 'dashscope',
    base = '';
  const server = createServer(async (req, res) => {
    req.resume();
    const path = req.url || '';
    if (path === '/result' || path.endsWith('/content') || path.endsWith(':download?alt=media')) {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end(clip);
      return;
    }
    res.setHeader('content-type', 'application/json');
    const [submitted, done] = completedFixtures[protocol];
    if (path.includes('/files/retrieve?')) res.end(JSON.stringify({ file: { download_url: base + '/result' } }));
    else if (path.endsWith('/files/result')) res.end(JSON.stringify({ state: 'ACTIVE' }));
    else if (protocol === 'fal' && path.endsWith('/requests/job'))
      res.end(JSON.stringify({ video: { url: base + '/result' } }));
    else if (req.method === 'POST' && !path.endsWith(':fetchPredictOperation')) res.end(JSON.stringify(submitted));
    else if (protocol === 'vertex')
      res.end(JSON.stringify({ done: true, response: { videos: [{ bytesBase64Encoded: clip.toString('base64') }] } }));
    else res.end(JSON.stringify(done).replaceAll(asset, base + '/result'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  for (protocol of Object.keys(completedFixtures) as VideoProtocol[]) {
    const result = await generateVideo(access(protocol, base), { prompt: 'coast' }, AbortSignal.timeout(5000));
    assert.deepEqual(result.bytes, clip, protocol);
    assert.equal(result.taskId, 'job', protocol);
  }
});
test('custom video specs pass through and adapters convert only wire representations', () => {
  const job = { prompt: 'test', aspect: '47:13', resolution: 'cinema-8k', duration: '23.5s' };
  assert.deepEqual(videoPlan(access('seedance'), job).submit.body, {
    model: 'vendor/model',
    content: [{ type: 'text', text: 'test' }],
    ratio: '47:13',
    resolution: 'cinema-8k',
    duration: 23.5,
  });
  const form = videoPlan(access('openai'), { ...job, resolution: '4096×1536', duration: 'auto' }).submit
    .body as FormData;
  assert.equal(form.get('size'), '4096x1536');
  assert.equal(form.get('seconds'), 'auto');
  assert.equal(
    (
      videoPlan(access('replicate'), {
        ...job,
        source: { kind: 'image', url: asset },
        sourceField: 'start_frame',
        input: { fps: 48 },
      }).submit.body as any
    ).input.start_frame,
    asset,
  );
});
test('submitted video is polled, checked and attached with a per-call override, without changing the default', async (t) => {
  const calls: Array<{ method: string; path: string; key?: string; data: string }> = [];
  let base = '';
  const server = createServer(async (req, res) => {
    let data = '';
    for await (const chunk of req) data += chunk;
    calls.push({ method: req.method!, path: req.url!, key: req.headers.authorization, data });
    if (req.url === '/result') {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end(clip);
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') res.end(JSON.stringify({ id: 'job-7' }));
    else res.end(JSON.stringify({ status: 'succeeded', content: { video_url: base + '/result' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const store = new Store(tempDir(t, 'aelion-media-'));
  t.after(() => store.close());
  const providers = new ModelProviders(store, { encrypt: (v) => v, decrypt: (v) => v });
  t.after(() => providers.dispose());
  const a = providers.save({ name: 'A', baseUrl: base, uses: ['video'], videoProtocol: 'xai', apiKey: 'alpha' });
  const b = providers.save({ name: 'B', baseUrl: base, uses: ['video'], videoProtocol: 'seedance', apiKey: 'beta' });
  providers.setMediaDefault('video', { providerId: a.id, model: 'default', duration: '9' });
  assert.throws(() => providers.remove(a.id), { code: 'provider.in_use' });
  const bot = store.data.bots[0];
  let turn = 0;
  const model = {
    complete: async () =>
      turn++
        ? answer('视频已生成')
        : {
            content: '',
            finishReason: 'tool_calls',
            calls: [
              {
                id: 'make',
                type: 'function',
                function: {
                  name: 'generate_video',
                  arguments: JSON.stringify({
                    providerId: b.id,
                    model: 'override',
                    video: { url: asset },
                    duration: '19',
                    prompt: 'pan left',
                  }),
                },
              },
            ],
          },
  } as unknown as ModelClient;
  const harness = new Harness(store, {} as VmController, model, () => {});
  harness.setMediaProviders(providers);
  await harness.run(bot.id, '生成视频');
  await until(() => store.data.runs[0]?.status === 'completed');
  assert.equal(
    store.data.messages.find((m) => m.role === 'assistant' && m.attachments?.length)?.attachments?.[0]?.mime,
    'video/mp4',
  );
  const payload = JSON.parse(calls[0].data);
  assert.equal(payload.model, 'override');
  assert.equal(payload.duration, 19);
  assert.equal(payload.content[1].role, 'reference_video');
  assert.deepEqual(
    calls.map((c) => [c.method, c.path, c.key]),
    [
      ['POST', '/api/v3/contents/generations/tasks', 'Bearer beta'],
      ['GET', '/api/v3/contents/generations/tasks/job-7', 'Bearer beta'],
      ['GET', '/result', undefined],
    ],
  );
  assert.equal(providers.videoAccess()?.model, 'default');
  await generateVideo(
    { ...access('seedance', base), key: 'beta' },
    { prompt: 'resume' },
    new AbortController().signal,
    'job-7',
  );
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
});
test('legacy Bot image and voice migrate once and all Bots share the new workspace defaults', (t) => {
  const store = new Store(tempDir(t, 'aelion-media-upgrade-'));
  t.after(() => store.close());
  const codec = { encrypt: (v: string) => v, decrypt: (v: string) => v };
  const first = new ModelProviders(store, codec);
  const p = first.save({ name: 'shared', baseUrl: 'https://models.example/v1' });
  const [bot] = store.data.bots;
  bot.imageModel = { providerId: p.id, model: 'first-image', contextTokens: 32000 };
  bot.voice = 'old-voice';
  first.setSpeech({ output: { providerId: p.id, model: 'speech', voice: 'global-voice' } });
  const migrated = new ModelProviders(store, codec);
  t.after(() => migrated.dispose());
  migrated.save({
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    asrProtocol: 'deepseek-tools',
    ttsProtocol: 'openai-audio',
  });
  migrated.setSpeech({ input: { providerId: p.id, model: '' }, output: store.data.speech?.output });
  assert.equal(migrated.speechAccess('input')?.protocol, 'deepseek-tools');
  assert.equal(migrated.speechAccess('output')?.protocol, 'openai-audio');
  const other = store.createBot('other', 'test');
  assert.equal(migrated.imageAccess(other.id)?.config.model, 'first-image');
  assert.equal(migrated.speechAccess('output', bot.id)?.voice, 'global-voice');
  assert.equal(migrated.imageAccess(bot.id, { providerId: p.id, model: 'alternate' })?.config.model, 'alternate');
  assert.equal(migrated.imageAccess(bot.id)?.config.model, 'first-image');
  migrated.setMediaDefault('image', null);
  assert.equal(new ModelProviders(store, codec).imageAccess(bot.id), undefined);
});
