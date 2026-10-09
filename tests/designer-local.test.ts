import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './helpers';
import { mkdirSync, symlinkSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { unzipSync } from 'fflate';
import { Store } from '../electron/core/storage/store';
import { DesignStore } from '../electron/core/designer/design-store';
import { DesignerFiles } from '../electron/core/designer/designer-files';
import { designerDeck } from '../electron/core/designer/designer-deck';
import { ArtifactService } from '../electron/core/attachments/artifacts';
import { Attachments } from '../electron/core/attachments/attachments';
import { AgentPreviews } from '../electron/core/preview/agent-previews';

function setup(t: any) {
  const root = tempDir(t, 'aelion-local-design-');
  const store = new Store(join(root, 'data')),
    bot = store.createBot('Designer', ''),
    base = join(root, 'default');
  const designs = new DesignStore(
      store,
      {} as any,
      () => {},
      () => base,
    ),
    task = designs.create({ botId: bot.id, kind: 'prototype', brief: 'A local page' }),
    files = new DesignerFiles(store, designs);
  let vmCalls = 0;
  // A stopped work computer: its state can be read; anything else counts as using it.
  const vm = new Proxy({ state: { status: 'stopped' } } as any, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'then') return undefined;
      vmCalls++;
      throw Error('Designer must not access VM');
    },
  });
  const artifacts = new ArtifactService(store, vm as any);
  artifacts.designerFiles = files;
  return { root, store, bot, designs, task, files, artifacts, vm, vmCalls: () => vmCalls };
}

test('local design files stay below default/designers and reject cross-task paths and directory links', async (t) => {
  const f = setup(t),
    b = f.designs.create({ botId: f.bot.id, kind: 'prototype', brief: 'B' }),
    workspace = f.task.workspaceDir!;
  assert.ok(statSync(workspace).isDirectory());
  assert.ok(workspace.replace(/\\/g, '/').endsWith('/default/designers/' + f.bot.id + '/' + f.task.id));
  f.files.write(f.task, 'index.html', Buffer.from('<main>Draft</main>'));
  assert.throws(() => f.files.absolute(f.task, '../outside.txt'));
  assert.throws(() => f.files.absolute(f.task, join(b.workspaceDir!, 'index.html')));
  await assert.rejects(f.artifacts.read(f.bot.id, 'designers/another/secret.html'));
  const outside = join(f.root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(f.task.workspaceDir!, 'linked'), 'junction');
  assert.throws(() => f.files.write(f.task, 'linked/escape.txt', Buffer.from('x')));
  assert.equal(existsSync(join(outside, 'escape.txt')), false);
  assert.equal(f.vmCalls(), 0);
});

test('local previews, nested assets, attachment delivery and source save use the same bytes without VM', async (t) => {
  const f = setup(t),
    startedAt = new Date().toISOString(),
    path = f.task.workspacePath + '/index.html';
  f.files.write(f.task, 'index.html', Buffer.from('<html><body>Draft</body></html>'));
  f.files.write(f.task, 'assets/style.css', Buffer.from('body{color:red}'));
  assert.equal((await f.artifacts.preview(f.bot.id, path)).kind, 'html');
  assert.equal(
    (await f.artifacts.read(f.bot.id, f.task.workspacePath + '/assets/style.css')).toString(),
    'body{color:red}',
  );
  const before = await f.artifacts.readEditable(f.bot.id, path);
  await f.artifacts.saveEditable(f.bot.id, path, {
    revision: before.revision,
    content: '<html><body>Changed</body></html>',
  });
  await assert.rejects(f.artifacts.saveEditable(f.bot.id, path, { revision: before.revision, content: 'stale' }), {
    code: 'preview.edit_conflict',
  });
  const attachments = new Attachments(f.store, f.vm as any, f.artifacts),
    sent = await attachments.prepare(f.bot.id, [{ path }], new AbortController().signal);
  assert.match(attachments.bytes(sent[0].id).toString(), /Changed/);
  f.store.data.runs.push({
    id: 'local-run',
    botId: f.bot.id,
    engine: 'designer',
    designSessionId: f.task.id,
    workspaceDir: f.task.workspaceDir,
    status: 'running',
    startedAt,
    modelCalls: 0,
    toolCalls: 0,
  });
  const previews = new AgentPreviews(f.store, f.artifacts, attachments, () => {});
  await previews.open(f.bot.id, 'local-run', { path, location: 'host' }, new AbortController().signal);
  assert.deepEqual(previews.snapshot()[0].target, { kind: 'workspace', path });
  await f.artifacts.collect(f.bot.id, 'local-run');
  assert.equal(f.store.data.artifacts.length, 2);
  // The Bot's root is the work computer; its design tasks are listed from this computer, and their folders open here.
  assert.equal((await f.files.directory(f.bot.id)).entries[0].path, f.task.workspacePath);
  assert.ok((await f.artifacts.directory(f.bot.id, f.task.workspacePath)).entries.some((e) => e.name === 'index.html'));
  assert.equal(f.vmCalls(), 0);
});

test('local deck has editable OOXML text, multiple layouts, escaped content and an HTML companion', async (t) => {
  const f = setup(t),
    deck = designerDeck('A < B', [
      { title: '标题 & 原文', body: '一条明确的信息', layout: 'split' },
      { title: '第二页', body: '仍可编辑', layout: 'statement' },
      { title: '目录', layout: 'agenda', items: ['背景', '方案'] },
      { title: '下一步', body: '开始评审', layout: 'cta' },
    ]);
  f.files.write(f.task, 'deck.pptx', deck.pptx);
  f.files.write(f.task, 'deck.html', deck.html);
  const zip = unzipSync(deck.pptx);
  assert.match(Buffer.from(zip['ppt/slides/slide1.xml']).toString(), /标题 &amp; 原文/);
  assert.match(Buffer.from(zip['ppt/slides/slide3.xml']).toString(), /1\. 背景/);
  assert.match(deck.html.toString(), /data-slide-id="slide-4"/);
  assert.match(deck.html.toString(), /class="agenda"/);
  assert.equal((await f.artifacts.preview(f.bot.id, f.task.workspacePath + '/deck.pptx')).kind, 'web');
  assert.equal(f.vmCalls(), 0);
  const python = process.env.AELION_TEST_PYTHON;
  if (python) {
    const result = spawnSync(
      python,
      [
        '-c',
        "from pptx import Presentation\nimport sys\np=Presentation(sys.argv[1]);assert len(p.slides)==4\nassert any('标题 & 原文' in s.text for s in p.slides[0].shapes if s.has_text_frame)\np.slides[0].shapes[1].text='Edited locally'\np.save(sys.argv[1]);assert Presentation(sys.argv[1]).slides[0].shapes[1].text=='Edited locally'",
        join(f.task.workspaceDir!, 'deck.pptx'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
  } else t.diagnostic('PowerPoint reopen check requires AELION_TEST_PYTHON; OOXML and local preview assertions ran.');
});

test('designer PowerPoint attachments preview the HTML companion without a VM', async (t) => {
  const f = setup(t),
    deck = designerDeck('Local slides', [{ title: '封面', layout: 'title' }]);
  f.files.write(f.task, 'deck.pptx', deck.pptx);
  f.files.write(f.task, 'deck.html', deck.html);
  const attachments = new Attachments(f.store, f.vm as any, f.artifacts);
  const [pptx] = await attachments.prepare(
    f.bot.id,
    [{ path: f.task.workspacePath + '/deck.pptx' }],
    new AbortController().signal,
  );
  const preview = await attachments.previewRich(pptx.id);
  assert.equal(preview.kind, 'web');
  assert.equal(preview.web?.kind, 'document');
  const html = preview.web?.kind === 'document' ? preview.web.content || '' : '';
  assert.match(html, /封面/);
  assert.equal(f.vmCalls(), 0);
  // A deck with no companion page takes the ordinary office preview, which needs the work computer.
  const orphan = attachments.importForBot(f.bot.id, 'alone.pptx', Buffer.from('not-a-deck'));
  await assert.rejects(attachments.previewRich(orphan.id), { code: 'preview.computer_required' });
  assert.equal(f.vmCalls(), 0);
});

test('legacy VM design tasks are kept intact and cannot silently execute on the host', (t) => {
  const f = setup(t),
    legacy = { ...f.task, location: undefined, workspaceDir: undefined, workspacePath: 'design-projects/' + f.task.id };
  assert.throws(() => f.files.absolute(legacy, 'index.html'), { code: 'design.legacy_vm_session' });
  assert.equal(f.task.location, 'host');
  assert.equal(f.vmCalls(), 0);
});
