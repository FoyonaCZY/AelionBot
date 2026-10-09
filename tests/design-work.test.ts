import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { call, designHarness } from './design-harness';
import { designerDeck } from '../electron/core/designer/designer-deck';
import { DesignFonts } from '../electron/core/designer/design-fonts';
import type { RunRecord } from '../shared/types/core';

const PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Plan</title></head>' +
  '<body><main><h1>Plan the week</h1><p>Three focused blocks a day.</p><button type="button">Start</button></main></body></html>';
const succeeded = (run: RunRecord, tool: string) =>
  Boolean(run.executions?.some((e) => e.tool === tool && e.status === 'succeeded'));

// ---------- Entering design work from an ordinary conversation ----------

test('a general Bot starts a design task from an ordinary request, writes on this computer and publishes', async (t) => {
  const f = designHarness(t);
  let taskId = '';
  const run = await f.run('Design a landing page for a weekly planner', (turn, requests) => {
    if (turn === 0) {
      // Unbound: only the entry tools are offered, next to the ordinary ones.
      assert.ok(requests[0].tools.includes('design_start'));
      assert.ok(requests[0].tools.includes('host_file_read'));
      assert.ok(!requests[0].tools.includes('design_file_create'));
      return { calls: [call('design_start', { kind: 'prototype', title: 'Planner', brief: 'Landing page' })] };
    }
    if (turn === 1) {
      assert.ok(requests[1].tools.includes('design_file_create'));
      taskId = f.store.data.runs.at(-1)!.designSessionId!;
      return { calls: [call('design_file_create', { path: 'index.html', content: PAGE, reason: 'first draft' })] };
    }
    if (turn === 2) return { calls: [call('design_publish', { paths: ['index.html'] })] };
    return { content: 'The landing page is on the canvas.' };
  });
  assert.equal(run.status, 'completed');
  assert.ok(taskId);
  const task = f.designs.get(taskId);
  assert.equal(task.botId, f.bot.id);
  assert.equal(task.origin.kind, 'bot');
  assert.equal(task.status, 'review');
  assert.equal(task.activeRunId, undefined);
  assert.equal(readFileSync(join(task.workspaceDir!, 'index.html'), 'utf8'), PAGE);
  assert.ok(task.artifacts.some((a) => a.path.endsWith('/index.html')));
  assert.equal(run.attachments?.length, 1);
  // The design-mode prompt joins once the task is bound.
  assert.ok(!f.requests[0].messages.some((m) => /Design task state/.test(String(m.content))));
  assert.ok(f.requests[1].messages.some((m) => /Design task state/.test(String(m.content))));
  assert.equal(f.vmCalls(), 0);
});

test('without a request for design work the run ends normally and only the entry tools are offered', async (t) => {
  const f = designHarness(t);
  const run = await f.run('What does this function do?', [{ content: 'It sorts the list.' }]);
  assert.equal(run.status, 'completed');
  assert.equal(run.designSessionId, undefined);
  const design = f.requests[0].tools.filter((name) => name.startsWith('design_'));
  assert.deepEqual(design.sort(), ['design_font_library', 'design_start', 'design_tasks', 'design_use']);
});

test('design_start without a system leaves the choice to the Bot', async (t) => {
  const f = designHarness(t, { catalog: {} });
  const run = await f.run('Make a deck', [
    { calls: [call('design_start', { kind: 'ppt', title: 'Review', brief: 'Quarterly review' })] },
    { content: 'Started.' },
  ]);
  assert.equal(f.designs.get(run.designSessionId!).systemId, null);
});

test('a write returns its design-check findings to the next turn instead of blocking it', async (t) => {
  const f = designHarness(t);
  const run = await f.runTask('Build the page', [
    {
      calls: [
        call('design_file_create', {
          path: 'index.html',
          content: '<!doctype html><html><body><main><h1>Plan</h1></main></body></html>',
          reason: 'draft',
        }),
      ],
    },
    { content: 'Draft written.' },
  ]);
  assert.equal(run.status, 'completed');
  assert.match(JSON.stringify(f.requests[1].messages), /missing-lang/);
  assert.ok(f.current().findings?.some((entry) => entry.findings.some((x) => x.id === 'missing-lang')));
  // Written but not published: the draft still shows on the delivery card.
  assert.equal(f.current().status, 'review');
  assert.ok(f.current().artifacts.some((a) => a.path.endsWith('/index.html')));
  assert.equal(f.previews.snapshot().length, 1);
});

test('a run stopped after writing keeps the draft on the task for a later look', async (t) => {
  const f = designHarness(t);
  const run = await f.runTask('Create the page', (turn) => {
    if (turn === 0)
      return { calls: [call('design_file_create', { path: 'index.html', content: PAGE, reason: 'draft' })] };
    f.harness.cancel(f.bot.id);
    throw new DOMException('Stopped', 'AbortError');
  });
  assert.notEqual(run.status, 'completed');
  assert.ok(existsSync(f.path('index.html')));
  const task = f.current();
  assert.equal(task.activeRunId, undefined);
  assert.ok(task.artifacts.some((a) => a.path.endsWith('/index.html')));
  assert.notEqual(task.checks.find((c) => c.id === 'format')?.status, 'passed');
});

// ---------- What publish still refuses, and what it only warns about ----------

test('a PPTX of images only is refused; the refusal holds the run open until an editable deck is published', async (t) => {
  const f = designHarness(t, { kind: 'ppt' });
  mkdirSync(f.task.workspaceDir!, { recursive: true });
  writeFileSync(
    f.path('deck.pptx'),
    zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'ppt/slides/slide1.xml': strToU8('<p:sld><p:pic/></p:sld>'),
    }),
  );
  // Giving up after the refusal does not count as a delivery.
  const refused = await f.runTask('Deliver slides', [
    { calls: [call('design_publish', { paths: ['deck.pptx'] })] },
    { content: 'Delivered.' },
  ]);
  assert.notEqual(refused.status, 'completed');
  assert.equal(f.current().artifacts.length, 0);
  assert.match(f.transcript(), /可编辑文字/);
  const fixed = await f.runTask('Deliver slides', [
    { calls: [call('design_publish', { paths: ['deck.pptx'] })] },
    { calls: [call('design_deck', { title: 'Review', path: 'deck', slides: [{ title: 'Editable text' }] })] },
    { calls: [call('design_publish', { paths: ['deck.pptx'] })] },
    { content: 'The editable deck is attached.' },
  ]);
  assert.equal(fixed.status, 'completed', fixed.error || 'run did not complete');
  assert.equal(f.current().artifacts[0]?.kind, 'pptx');
});

test('remote fonts and a clone without a source URL are warnings, not refusals', async (t) => {
  const f = designHarness(t, { kind: 'clone' });
  f.files.write(
    f.current(),
    'index.html',
    Buffer.from(
      '<html lang="en"><head><link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet"></head><body><main>Replica</main></body></html>',
    ),
  );
  f.files.write(f.current(), 'NOTES.md', Buffer.from('# Clone\nNo source URL yet.\n'));
  const run = await f.runTask('Deliver the replica', [
    { calls: [call('design_publish', { paths: ['index.html'] })] },
    { content: 'Delivered with notes.' },
  ]);
  assert.equal(run.status, 'completed', run.error || 'run did not complete');
  assert.match(JSON.stringify(f.requests[0].messages), /CLONE WORKFLOW/);
  assert.match(f.transcript(), /远程字体/);
  assert.match(f.transcript(), /来源网址/);
  assert.deepEqual(
    f.current().artifacts.map((a) => a.name),
    ['index.html'],
  );
  assert.equal(f.current().checks.find((c) => c.id === 'format')?.status, 'passed');
  // With the source written down, the notes travel with the delivery.
  f.files.write(f.current(), 'NOTES.md', Buffer.from('# Notes\nSource: https://example.test/observed\n'));
  await f.runTask('Deliver again', [
    { calls: [call('design_publish', { paths: ['index.html'] })] },
    { content: 'Done.' },
  ]);
  assert.ok(f.current().artifacts.some((a) => a.name === 'NOTES.md'));
});

test('an HTML file the user saved in the preview cannot be overwritten whole', async (t) => {
  const f = designHarness(t);
  const session = f.current();
  f.files.write(session, 'index.html', Buffer.from('<html><body>Saved by user</body></html>'));
  session.userEdits = [
    {
      id: 'edit-1',
      path: session.workspacePath + '/index.html',
      revision: 'abc',
      time: new Date().toISOString(),
      summary: 'user save',
    },
  ];
  f.designs.touch(session);
  f.designs.save();
  await f.runTask('Rewrite page', [
    {
      calls: [
        call('host_file_write', {
          path: f.path('index.html'),
          content: '<html><body>All new</body></html>',
          reason: 'replace',
          overwrite: true,
        }),
      ],
    },
    { content: 'I will patch it instead.' },
  ]);
  assert.match(readFileSync(f.path('index.html'), 'utf8'), /Saved by user/);
  assert.match(f.transcript(), /局部|整文件/);
  assert.equal(f.permissions.length, 0);
});

for (const kind of ['prototype', 'ppt', 'clone', 'mobile', 'document'] as const)
  test('publishing a ' + kind + ' attaches its files and shows its page on the canvas', async (t) => {
    const f = designHarness(t, { kind });
    const session = f.current();
    const paths = kind === 'ppt' ? ['deck.pptx', 'deck.html'] : ['index.html'];
    if (kind === 'ppt') {
      const deck = designerDeck('Local slides', [{ title: 'Editable content' }]);
      f.files.write(session, 'deck.pptx', deck.pptx);
      f.files.write(session, 'deck.html', deck.html);
    } else f.files.write(session, 'index.html', Buffer.from('<html lang="en"><body><main>Ready</main></body></html>'));
    if (kind === 'clone')
      f.files.write(session, 'NOTES.md', Buffer.from('# Clone notes\n- 原站 URL: https://example.test/site\n'));
    const run = await f.runTask('Deliver the design', [
      { calls: [call('design_publish', { paths })] },
      { content: 'Ready for review.' },
    ]);
    assert.equal(run.status, 'completed', run.error || 'run did not complete');
    assert.equal(f.current().status, 'review');
    assert.equal(run.attachments?.length, kind === 'clone' ? 2 : paths.length);
    assert.deepEqual(
      f.previews.snapshot().map((entry) => entry.target),
      [{ kind: 'workspace', path: session.workspacePath + '/' + (kind === 'ppt' ? 'deck.html' : 'index.html') }],
    );
    assert.equal(f.vmCalls(), 0);
  });

// ---------- Design systems ----------

test('the selected design system materializes into the task folder only', async (t) => {
  const f = designHarness(t, { catalog: {} });
  const run = await f.runTask('Prepare the reference', [
    { calls: [call('design_resource', { action: 'materialize' })] },
    { content: 'Reference prepared.' },
  ]);
  assert.equal(run.status, 'completed', run.error || 'run did not complete');
  assert.match(
    readFileSync(join(f.task.workspaceDir!, '.design-system', f.task.systemVersion!, 'sample', 'tokens.css'), 'utf8'),
    /red/,
  );
});

test('without a design system, misused resource and start calls do not fail the run; design_system attaches one', async (t) => {
  const f = designHarness(t, { catalog: {} });
  f.designs.setSystem(f.current(), null);
  const run = await f.runTask('Design a site', [
    {
      calls: [
        call('design_resource', { action: 'materialize' }),
        call('design_start', { kind: 'prototype', title: 'Retry', brief: 'Need a system', systemId: 'sample' }),
      ],
    },
    { content: 'Continuing with the attached system.' },
  ]);
  assert.equal(run.status, 'completed', run.error || 'run did not complete');
  assert.equal(f.current().systemId, 'sample');
  assert.match(f.transcript(), /selected\W+false/);
  assert.match(f.transcript(), /attached\W+true/);
  f.designs.setSystem(f.current(), null);
  await f.runTask('Use the system', [
    { calls: [call('design_system', { systemId: 'sample' })] },
    { content: 'Ready.' },
  ]);
  assert.equal(f.current().systemId, 'sample');
});

test('the design prefix stays the same across turns and the pinned reference is read once', async (t) => {
  const f = designHarness(t, { catalog: {} });
  let reads = 0;
  const context = f.systems.context.bind(f.systems);
  f.systems.context = (...args: Parameters<typeof context>) => {
    reads++;
    return context(...args);
  };
  const run = await f.runTask('Build a page', [
    { calls: [call('design_spec', { spec: 'New direction after first inference', constraints: [] })] },
    { calls: [call('design_file_create', { path: 'index.html', content: PAGE, reason: 'draft' })] },
    { calls: [call('design_publish', { paths: ['index.html'] })] },
    { content: 'Ready for review.' },
  ]);
  assert.equal(run.status, 'completed', run.error || 'run did not complete');
  assert.equal(reads, 1);
  // No polish round: four model calls for three tool turns and the answer.
  assert.equal(f.requests.length, 4);
  const designMessages = (index: number) =>
    f.requests[index].messages.filter(
      (m) =>
        m.role === 'system' &&
        /Selected visual reference package|A design system is already selected/.test(String(m.content)),
    );
  for (let i = 1; i < f.requests.length; i++) assert.deepEqual(designMessages(i), designMessages(0));
  assert.equal(designMessages(0).length, 2);
});

test('publish records a brand check and leaves a user-saved HTML file as it is', async (t) => {
  const f = designHarness(t, {
    catalog: {
      tokens: ':root {--od-color-primary:#cc3333;--font-display:Georgia,serif;--text-lg:32px;--space-m:16px;}',
    },
  });
  const html =
    '<!doctype html><html lang="en"><style>:root{--od-color-primary:#cc3333}h1{color:#cc3434}</style><body><h1 data-design-id="hero">Hello</h1></body></html>';
  f.files.write(f.current(), 'index.html', Buffer.from(html));
  await f.runTask('Deliver', [{ calls: [call('design_publish', { paths: ['index.html'] })] }, { content: 'Ready.' }]);
  assert.ok(f.current().checks.some((c) => c.id === 'brand'));
  assert.equal(f.current().checks.find((c) => c.id === 'format')?.status, 'passed');
  // The user saves a version with the off-brand colour; publishing again must not repair it behind their back.
  f.files.write(f.current(), 'index.html', Buffer.from(html));
  const locked = f.current();
  locked.userEdits = [
    {
      id: 'u1',
      path: locked.workspacePath + '/index.html',
      revision: 'abc',
      time: new Date().toISOString(),
      summary: 'user',
    },
  ];
  f.designs.save();
  await f.runTask('Deliver again', [
    { calls: [call('design_publish', { paths: ['index.html'] })] },
    { content: 'Ready.' },
  ]);
  assert.equal(readFileSync(f.path('index.html'), 'utf8'), html);
});

// ---------- Tools that write files ----------

test('native deck generation publishes an editable PPTX with its HTML companion', async (t) => {
  const f = designHarness(t, { kind: 'ppt' });
  const run = await f.runTask('Create slides', [
    {
      calls: [
        call('design_deck', {
          title: 'Local design',
          path: 'deck',
          slides: [{ title: 'A clear idea', body: 'A useful first draft', layout: 'statement' }],
        }),
      ],
    },
    { calls: [call('design_publish', { paths: ['deck.pptx', 'deck.html'] })] },
    { content: 'Editable deck ready.' },
  ]);
  assert.equal(run.status, 'completed', run.error || 'run did not complete');
  assert.ok(succeeded(run, 'design_deck'));
  assert.ok(succeeded(run, 'design_publish'));
  assert.equal(f.current().artifacts.length, 2);
  assert.ok(existsSync(f.path('deck.html')));
});

test('design_file_create goes through the real host write: one permission, no shell, no overwrite', async (t) => {
  const f = designHarness(t);
  const content = '<html lang="en"><body><main>' + 'Design content. '.repeat(700) + '</main></body></html>';
  const run = await f.runTask('Create page', [
    { calls: [call('design_file_create', { path: 'index.html', content, reason: 'Create requested prototype' })] },
    { calls: [call('design_publish', { paths: ['index.html'] })] },
    { content: 'File delivered.' },
  ]);
  assert.equal(run.status, 'completed', run.error || 'run did not complete');
  assert.equal(readFileSync(f.path('index.html'), 'utf8'), content);
  assert.equal(f.permissions.length, 1);
  assert.ok(!run.executions?.some((e) => e.tool === 'host_execute'));
  assert.equal(f.vmCalls(), 0);
  await assert.rejects(
    f.host.writeFile(
      f.bot.id,
      run.id,
      { path: 'index.html', content: 'overwrite', reason: 'test' },
      new AbortController().signal,
      f.task.workspaceDir,
    ),
    { code: 'file.exists' },
  );
  assert.equal(readFileSync(f.path('index.html'), 'utf8'), content);
});

test('design_image saves real image bytes into assets after permission, and fails without them', async (t) => {
  const f = designHarness(t);
  f.files.write(
    f.current(),
    'index.html',
    Buffer.from('<html lang="en"><body><h1 data-design-id="hero">Hero</h1></body></html>'),
  );
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  // Image requests come without tools; the tool turns are counted separately.
  const scripted = (image: boolean) => {
    let step = 0;
    return (_turn: number, requests: { tools: string[] }[]) => {
      if (!requests.at(-1)!.tools.length)
        return image
          ? {
              content: '',
              native: {
                protocol: 'responses',
                key: 'k',
                data: [{ type: 'image_generation_call', result: png.toString('base64') }],
              },
            }
          : { content: 'no image' };
      return step++ === 0
        ? { calls: [call('design_image', { prompt: 'A red mark', reason: 'Hero art', filename: 'hero.png' })] }
        : { content: 'Ready.' };
    };
  };
  const run = await f.runTask('Need a hero image', scripted(true));
  assert.equal(run.status, 'completed', run.error || 'run did not complete');
  assert.equal(f.permissions.length, 1);
  assert.ok(readFileSync(join(f.task.workspaceDir!, 'assets', 'hero.png')).equals(png));
  await f.runTask('Need another image', scripted(false));
  assert.match(f.transcript(), /生图未返回/);
});

test('design_export_pdf writes a real PDF beside the HTML page', async (t) => {
  const f = designHarness(t, { extras: () => ({ pdf: { render: async () => Buffer.from('%PDF-1.4\n%fixture\n') } }) });
  f.files.write(f.current(), 'index.html', Buffer.from('<html lang="en"><body><h1>Print me</h1></body></html>'));
  const run = await f.runTask('Export pdf', [
    { calls: [call('design_export_pdf', { path: 'index.html', reason: 'Share a PDF' })] },
    { calls: [call('design_publish', { paths: ['index.html', 'index.pdf'] })] },
    { content: 'Ready.' },
  ]);
  assert.equal(run.status, 'completed', run.error || 'run did not complete');
  assert.equal(f.permissions.length, 1);
  assert.equal(readFileSync(f.path('index.pdf')).subarray(0, 5).toString(), '%PDF-');
  assert.ok(f.current().artifacts.some((a) => a.kind === 'pdf'));
});

// ---------- Project fonts ----------

const INTER = resolve('node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2');
const offlineFonts = (root: string, files: any) =>
  new DesignFonts({
    cacheDir: join(root, 'cache'),
    files,
    fetch: async () => {
      throw Error('offline test');
    },
  });

test('font tools import, apply and export real font bytes after permission', async (t) => {
  let printed = '';
  const f = designHarness(t, {
    extras: ({ root, files }) => ({
      fonts: offlineFonts(root, files),
      pdf: {
        render: async (html) => {
          printed = html;
          return Buffer.from('%PDF-1.7\nfixture');
        },
      },
    }),
  });
  mkdirSync(join(f.task.workspaceDir!, 'assets'), { recursive: true });
  copyFileSync(INTER, f.path('assets/source.woff2'));
  f.files.write(
    f.current(),
    'index.html',
    Buffer.from(
      '<html lang="en"><head><style>body{margin:20px;color:#242424}h1{font-size:32px}</style></head><body><h1>Typography</h1><p>Local font delivery</p></body></html>',
    ),
  );
  const fontId = 'import-' + createHash('sha256').update(readFileSync(INTER)).digest('hex').slice(0, 16);
  const run = await f.runTask('Use this font and export the design', [
    { calls: [call('design_fonts', { action: 'import', path: 'assets/source.woff2', reason: 'Use provided font' })] },
    {
      calls: [call('design_font_apply', { fontId, role: 'display', path: 'index.html', reason: 'Apply heading font' })],
    },
    { calls: [call('design_export_pdf', { path: 'index.html', output: 'design.pdf', reason: 'Export PDF' })] },
    {
      calls: [
        call('design_export_project', { path: 'index.html', output: 'site.zip', reason: 'Export portable design' }),
      ],
    },
    { calls: [call('design_publish', { paths: ['index.html', 'design.pdf'] })] },
    { content: 'Font project ready.' },
  ]);
  assert.equal(run.status, 'completed', run.error || 'run did not complete');
  assert.ok(f.permissions.some((p) => p.operation === 'read_file' && p.path === f.path('assets/source.woff2')));
  assert.ok(f.permissions.some((p) => p.operation === 'write_file' && p.path.endsWith('fonts')));
  const encoded = printed.match(/href="data:text\/css;base64,([^"]+)"/)?.[1];
  assert.ok(encoded, 'PDF must include the font stylesheet');
  assert.ok(Buffer.from(encoded, 'base64').toString().includes('data:font/woff2;base64,'));
  assert.match(printed, /--font-display/);
  const zip = unzipSync(readFileSync(f.path('site.zip')));
  assert.ok(Object.keys(zip).some((path) => path.endsWith('.woff2')));
  assert.ok(Object.keys(zip).some((path) => path.endsWith('LICENSE.txt')));
  assert.ok(!zip['assets/source.woff2'], 'the unreferenced original font is not bundled');
});

test('a denied font import leaves no project font behind', async (t) => {
  let fonts!: DesignFonts;
  const f = designHarness(t, {
    extras: ({ root, files }) => ({ fonts: (fonts = offlineFonts(root, files)) }),
    permission: () => {
      throw Error('Denied');
    },
  });
  mkdirSync(join(f.task.workspaceDir!, 'assets'), { recursive: true });
  copyFileSync(INTER, f.path('assets/source.woff2'));
  const run = await f.runTask('Import font', [
    { calls: [call('design_fonts', { action: 'import', path: 'assets/source.woff2', reason: 'Import' })] },
    { content: 'Cannot import.' },
  ]);
  assert.deepEqual(fonts.list(f.current()), []);
  assert.ok(run.executions?.some((e) => e.tool === 'design_fonts' && e.status !== 'succeeded'));
});

test('without a task the Bot searches the font library and downloads into it after permission', async (t) => {
  const metadata = {
    id: 'inter',
    family: 'Inter',
    category: 'sans-serif',
    weights: [400],
    styles: ['normal'],
    subsets: ['latin'],
    defSubset: 'latin',
    license: { type: 'OFL-1.1' },
  };
  let online = true;
  let fonts!: DesignFonts;
  const f = designHarness(t, {
    extras: ({ root, files }) => ({
      fonts: (fonts = new DesignFonts({
        cacheDir: join(root, 'library-cache'),
        files,
        fetch: async (input) => {
          const url = String(input);
          if (!online) throw Error('offline');
          if (url.endsWith('/v1/fonts')) return Response.json([metadata]);
          if (url.endsWith('/v1/version/inter')) return Response.json({ latest: '5.3.0' });
          if (url.endsWith('/metadata.json')) return Response.json(metadata);
          if (url.endsWith('/LICENSE')) return new Response('SIL OPEN FONT LICENSE Version 1.1');
          if (url.endsWith('/400.css'))
            return new Response(
              "/* inter-latin-400-normal */\n@font-face{font-family:'Inter';font-weight:400;src:url(./files/inter-latin-400-normal.woff2) format('woff2');unicode-range:U+0000-00FF;}",
            );
          if (url.endsWith('/inter-latin-400-normal.woff2')) return new Response(new Uint8Array(readFileSync(INTER)));
          throw Error('Unexpected request ' + url);
        },
      })),
    }),
  });
  const run = await f.run('Stock a readable sans for my next designs', (turn, requests) => {
    assert.ok(requests.at(-1)!.tools.includes('design_font_library'));
    const steps = [
      call('design_font_library', { action: 'search', query: 'Inter' }),
      call('design_font_library', { action: 'download', fontId: 'inter', weights: [400], reason: 'Readable sans' }),
      call('design_font_library', { action: 'list' }),
    ];
    return turn < steps.length ? { calls: [steps[turn]] } : { content: 'Inter is in your font library.' };
  });
  assert.equal(run.status, 'completed', run.error || 'run did not complete');
  assert.equal(run.designSessionId, undefined);
  assert.deepEqual(
    fonts.libraryList().map((font) => font.family),
    ['Inter'],
  );
  assert.ok(f.permissions.some((p) => p.operation === 'write_file' && p.path === fonts.libraryRoot));
  assert.match(f.transcript(), /inLibrary/);
  // A later task gets the family from the library with the network gone.
  online = false;
  const [copied] = await fonts.acquire(f.current(), { fontId: 'inter', weights: [400] });
  assert.equal(copied.family, 'Inter');
});

test('the font library download stops when write permission is denied', async (t) => {
  let fonts!: DesignFonts;
  const f = designHarness(t, {
    permission: () => {
      throw Error('Denied');
    },
    extras: ({ root, files }) => ({ fonts: (fonts = offlineFonts(root, files)) }),
  });
  const run = await f.run('Download Inter', [
    { calls: [call('design_font_library', { action: 'download', fontId: 'inter', reason: 'Stock fonts' })] },
    { content: 'Could not download.' },
  ]);
  assert.deepEqual(fonts.libraryList(), []);
  assert.ok(run.executions?.some((e) => e.tool === 'design_font_library' && e.status !== 'succeeded'));
});

test('the Bot searches, downloads and applies an open-source font on its own', async (t) => {
  const downloads: string[] = [];
  let permissions = 0;
  const metadata = {
    id: 'inter',
    family: 'Inter',
    category: 'sans-serif',
    weights: [400],
    styles: ['normal'],
    subsets: ['latin'],
    defSubset: 'latin',
    license: { type: 'OFL-1.1' },
  };
  let fonts!: DesignFonts;
  const f = designHarness(t, {
    permission: () => {
      permissions++;
    },
    extras: ({ root, files }) => ({
      fonts: (fonts = new DesignFonts({
        cacheDir: join(root, 'remote-cache'),
        files,
        fetch: async (input, init) => {
          const url = String(input);
          downloads.push(url);
          assert.equal(init?.credentials, 'omit');
          if (url.endsWith('/v1/fonts')) return Response.json([metadata]);
          assert.ok(permissions > 0, 'downloading font files needs the task write permission first');
          if (url.endsWith('/v1/version/inter')) return Response.json({ latest: '5.3.0' });
          if (url.endsWith('/metadata.json')) return Response.json(metadata);
          if (url.endsWith('/LICENSE')) return new Response('SIL OPEN FONT LICENSE Version 1.1');
          if (url.endsWith('/400.css'))
            return new Response(
              "/* inter-latin-400-normal */\n@font-face{font-family:'Inter';font-weight:400;src:url(./files/inter-latin-400-normal.woff2) format('woff2');unicode-range:U+0000-00FF;}",
            );
          if (url.endsWith('/inter-latin-400-normal.woff2')) return new Response(new Uint8Array(readFileSync(INTER)));
          throw Error('Unexpected request ' + url);
        },
      })),
    }),
  });
  f.files.write(
    f.current(),
    'index.html',
    Buffer.from('<html lang="en"><head><title>Type</title></head><body><h1>Hello</h1></body></html>'),
  );
  const run = await f.runTask('Design a readable page and choose a suitable open-source font', (turn, requests) => {
    assert.ok(requests.at(-1)!.tools.includes('design_fonts'));
    const added = fonts.list(f.current())[0];
    const steps = [
      call('design_fonts', { action: 'search', query: 'Inter' }),
      call('design_fonts', {
        action: 'acquire',
        fontId: metadata.id,
        weights: [400],
        reason: 'A readable heading font',
      }),
      call('design_font_apply', { fontId: added?.id, role: 'display', path: 'index.html', reason: 'Apply the font' }),
      call('design_fonts', { action: 'check', family: 'Inter', text: 'Hello' }),
      call('design_publish', { paths: ['index.html'] }),
    ];
    return turn < steps.length ? { calls: [steps[turn]] } : { content: 'Typography ready.' };
  });
  assert.equal(run.status, 'completed', run.error || 'run did not complete');
  const [font] = fonts.list(f.current());
  assert.equal(font.source, 'fontsource');
  assert.equal(font.family, 'Inter');
  assert.ok(downloads.some((url) => url.endsWith('.woff2')));
  assert.match(readFileSync(f.path('index.html'), 'utf8'), /--font-display:"Inter"/);
  assert.ok(!run.executions?.some((e) => e.tool === 'request_user_input'));
});

// ---------- Conversations stay apart ----------

test('a private message after a group run does not continue the group design task', async (t) => {
  const f = designHarness(t);
  const time = new Date().toISOString(),
    other = f.store.createBot('Other', ''),
    gid = randomUUID();
  f.store.data.groups.push({
    id: gid,
    name: 'Group',
    members: [
      { ...f.bot, joinedAt: time },
      { ...other, joinedAt: time },
    ],
    createdBy: { kind: 'user', id: 'user', name: 'You' },
    createdAt: time,
    updatedAt: time,
    messages: [],
    lastReadSeq: 0,
  } as any);
  const groupTask = f.designs.create({
    botId: f.bot.id,
    kind: 'prototype',
    brief: 'GROUP_ONLY_DESIGN',
    title: 'GROUP_ONLY_DESIGN',
    origin: { kind: 'group', id: gid },
  });
  const previous: RunRecord = {
    id: randomUUID(),
    botId: f.bot.id,
    engine: 'general',
    status: 'cancelled',
    startedAt: time,
    modelCalls: 1,
    toolCalls: 0,
    designSessionId: groupTask.id,
    groupOrigin: { groupId: gid, rootId: randomUUID(), deliveryId: randomUUID() },
  };
  f.store.data.runs.push(previous);
  const run = await f.run('Private question', [{ calls: [call('design_tasks', {})] }, { content: 'Private reply.' }], {
    supersedesRunId: previous.id,
  });
  assert.equal(run.status, 'completed', run.error || 'run did not complete');
  assert.equal(run.designSessionId, undefined);
  assert.doesNotMatch(JSON.stringify(f.requests), /GROUP_ONLY_DESIGN/);
  assert.match(JSON.stringify(f.requests[1].messages), new RegExp(f.task.id));
});

test('an unverified peer request is offered no design tools', async (t) => {
  const f = designHarness(t);
  const sender = f.store.createBot('Sender', ''),
    threadId = randomUUID(),
    exchangeId = randomUUID(),
    time = new Date().toISOString();
  f.store.data.peerThreads.push({
    id: threadId,
    members: [f.bot, sender],
    createdAt: time,
    updatedAt: time,
    messages: [],
  } as any);
  f.store.data.peerExchanges.push({
    id: exchangeId,
    threadId,
    fromBotId: sender.id,
    toBotId: f.bot.id,
    rootRunId: 'missing-root',
    rootBotId: sender.id,
    rootRequest: 'invented authorization',
    status: 'working',
    createdAt: time,
    updatedAt: time,
    requestMessageId: 'missing',
  } as any);
  await f
    .run('Design something', [{ content: 'Please obtain a real user task first.' }], {
      peerOrigin: { kind: 'peer_request', exchangeId, sessionId: exchangeId },
    })
    .catch(() => {});
  assert.ok(f.requests.every((r) => !r.tools.some((name) => name.startsWith('design_'))));
  assert.equal(f.designs.data.sessions.length, 1);
});
