import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers';
import { Store } from '../electron/core/storage/store';
import { DesignStore } from '../electron/core/designer/design-store';
import { DesignerFiles } from '../electron/core/designer/designer-files';
import { DesignThumbnails, type DesignThumbnailJob } from '../electron/core/designer/design-thumbnails';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function fixture(t: test.TestContext, render: (job: DesignThumbnailJob) => Promise<Buffer> = async () => JPEG) {
  const root = tempDir(t, 'aelion-thumb-');
  const store = new Store(join(root, 'data'));
  t.after(() => store.close());
  const bot = store.createBot('Bot', '');
  store.data.model.model = 'test';
  const designs = new DesignStore(
    store,
    {} as any,
    () => {},
    () => join(root, 'workspace'),
  );
  const files = new DesignerFiles(store, designs);
  const jobs: DesignThumbnailJob[] = [];
  const thumbnails = new DesignThumbnails(files, async (job) => {
    jobs.push(job);
    return render(job);
  });
  const task = designs.create({ botId: bot.id, kind: 'prototype', brief: 'Page' });
  const write = (path: string, content: string) => {
    const file = join(task.workspaceDir!, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
  };
  return { store, bot, designs, files, thumbnails, jobs, task: designs.get(task.id), write };
}

test('a page renders once per revision and its assets are read from the task folder only', async (t) => {
  const f = fixture(t);
  f.write('pages/index.html', '<html><body>One</body></html>');
  f.write('assets/site.css', 'body{color:red}');
  const first = await f.thumbnails.get(f.task, f.task.workspacePath + '/pages/index.html');
  assert.equal(first?.path, f.task.workspacePath + '/pages/index.html');
  assert.match(first!.dataUrl, /^data:image\/jpeg;base64,/);
  assert.equal(f.jobs.length, 1);
  assert.equal(f.jobs[0].page, 'pages/index.html');
  assert.equal(f.jobs[0].kind, 'prototype');
  // Relative paths resolve inside the task; another task's folder and the outside are refused.
  assert.equal((await f.jobs[0].read('assets/site.css', 1024)).toString(), 'body{color:red}');
  await assert.rejects(f.jobs[0].read('../outside.css', 1024));
  await assert.rejects(f.jobs[0].read('assets/site.css', 4));
  // Unchanged: served from the cache. Relative input finds the same page.
  assert.deepEqual(await f.thumbnails.get(f.task, 'pages/index.html'), first);
  assert.equal(f.jobs.length, 1);
  // Rewritten: rendered again.
  f.write('pages/index.html', '<html><body>Two, longer</body></html>');
  await f.thumbnails.get(f.task, 'pages/index.html');
  assert.equal(f.jobs.length, 2);
});

test('concurrent requests for one page share a render; renders run one at a time', async (t) => {
  let running = 0,
    peak = 0;
  const f = fixture(t, async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((done) => setTimeout(done, 20));
    running--;
    return JPEG;
  });
  f.write('index.html', '<html>A</html>');
  f.write('about.html', '<html>B</html>');
  const results = await Promise.all([
    f.thumbnails.get(f.task, 'index.html'),
    f.thumbnails.get(f.task, 'index.html'),
    f.thumbnails.get(f.task, 'about.html'),
  ]);
  assert.ok(results.every(Boolean));
  assert.equal(f.jobs.length, 2);
  assert.equal(peak, 1);
});

test('a failed or invalid render returns null and is not retried until the page changes', async (t) => {
  let fail = true;
  const f = fixture(t, async () => {
    if (fail) throw Error('render failed');
    return Buffer.from('not a jpeg');
  });
  f.write('index.html', '<html>A</html>');
  assert.equal(await f.thumbnails.get(f.task, 'index.html'), null);
  assert.equal(await f.thumbnails.get(f.task, 'index.html'), null);
  assert.equal(f.jobs.length, 1);
  fail = false;
  f.write('index.html', '<html>A changed</html>');
  // Not a JPEG: still no picture.
  assert.equal(await f.thumbnails.get(f.task, 'index.html'), null);
  assert.equal(f.jobs.length, 2);
});

test('only HTML pages of the task get a thumbnail; other tasks and VM tasks are refused or skipped', async (t) => {
  const f = fixture(t);
  f.write('deck.pptx', 'PK');
  assert.equal(await f.thumbnails.get(f.task, 'deck.pptx'), null);
  const other = f.designs.create({ botId: f.bot.id, kind: 'prototype', brief: 'Other' });
  await assert.rejects(f.thumbnails.get(f.task, other.workspacePath + '/index.html'));
  await assert.rejects(f.thumbnails.get(f.task, '../escape.html'));
  assert.equal(await f.thumbnails.get({ ...f.task, location: 'vm' } as any, 'index.html'), null);
  assert.equal(f.jobs.length, 0);
});
