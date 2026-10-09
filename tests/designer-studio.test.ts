import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './helpers';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../electron/core/storage/store';
import { DesignSystems } from '../electron/core/designer/design-systems';
import { DesignStore } from '../electron/core/designer/design-store';
import {
  parseDesignTokens,
  checkDesignBrand,
  repairDesignBrand,
  brandCheckLabel,
} from '../electron/core/designer/design-brand';
import { printReadyHtml, renderDesignPdf } from '../electron/core/designer/design-pdf';
import {
  emptyCanvasHtml,
  pickDesignPreviewFiles,
  commentsFromAnnotations,
  commentDesignId,
  deviceFrameKind,
  previewFeedbackAlwaysVisible,
  primaryDesignArtifact,
} from '../shared/preview/designer-canvas';
import { designerPlaybook, designerPlaybookName } from '../electron/core/designer/designer-playbooks';

function fixture(t: test.TestContext) {
  const root = tempDir(t, 'aelion-studio-');
  const store = new Store(join(root, 'data'));
  const bot = store.createBot('Designer', 'Design');
  store.data.model.model = 'fixture';
  return { root, store, bot };
}

function catalog(root: string, version = 'a'.repeat(40), color = '#cc3333') {
  const dir = join(root, version);
  mkdirSync(join(dir, 'sample'), { recursive: true });
  const texts = {
    'DESIGN.md': '# Sample\nUse a restrained type scale.',
    'tokens.css': `:root {--od-color-primary:${color};--font-display:Georgia,serif;--text-lg:32px;--space-m:16px;}`,
    'components.html': '<main>Reference</main>',
  };
  const files = Object.entries(texts).map(([path, body]) => {
    writeFileSync(join(dir, 'sample', path), body);
    return { path, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') };
  });
  writeFileSync(
    join(dir, 'catalog.json'),
    JSON.stringify({
      version: 1,
      sourceCommit: version,
      sourceUrl: 'https://example.test',
      systems: [
        {
          id: 'sample',
          name: 'Sample',
          category: 'Product',
          description: 'Test fixture',
          version,
          bytes: files.reduce((n, f) => n + f.bytes, 0),
          colors: ['#123456'],
          source: 'https://example.test',
          license: 'Apache-2.0',
          files,
        },
      ],
    }),
  );
  return dir;
}

test('empty canvas and preview helpers cover the five task kinds without writing files', () => {
  for (const kind of ['prototype', 'ppt', 'clone', 'mobile', 'document'] as const) {
    const html = emptyCanvasHtml(kind, 'A <Brand>');
    assert.match(html, /data-design-id="empty-canvas"/);
    assert.doesNotMatch(html, /网页画布|文件一写入|A &lt;Brand&gt;|empty-slide|device-frame/);
    assert.equal(
      deviceFrameKind(kind),
      kind === 'mobile' ? 'phone' : kind === 'ppt' ? 'slide' : kind === 'document' ? 'page' : undefined,
    );
    assert.equal(primaryDesignArtifact(kind, kind === 'ppt' ? 'deck.pptx' : 'index.html'), true);
  }
  assert.equal(previewFeedbackAlwaysVisible(false), true);
  const files = pickDesignPreviewFiles('prototype', [
    { name: 'about.html', path: 'designers/b/t/about.html', size: 12 },
    { name: 'index.html', path: 'designers/b/t/index.html', size: 40 },
  ]);
  assert.equal(files[0].name, 'index.html');
  const deck = pickDesignPreviewFiles('ppt', [
    { name: 'deck.html', path: 'designers/b/t/deck.html', size: 20 },
    { name: 'notes.html', path: 'designers/b/t/notes.html', size: 8 },
  ]);
  assert.equal(deck[0].name, 'deck.html');
});

test('element annotations become scoped canvas comments keyed by data-design-id', (t) => {
  assert.equal(commentDesignId({ selector: 'h1[data-design-id="hero"]', text: 'x' }), 'hero');
  const comments = commentsFromAnnotations(
    'designers/b/t/index.html',
    '改小字号',
    [
      {
        id: 'm1',
        type: 'element',
        x: 0.1,
        y: 0.1,
        color: '#3975c6',
        designId: 'hero',
        selector: 'h1',
        text: '改小字号',
      },
    ],
    [],
  );
  assert.equal(comments.length, 1);
  assert.equal(comments[0].designId, 'hero');
  assert.equal(comments[0].status, 'open');
  const { root, store, bot } = fixture(t),
    systems = new DesignSystems(catalog(root)),
    designs = new DesignStore(store, systems);
  const task = designs.create({ botId: bot.id, kind: 'prototype', brief: 'Page' });
  designs.addComments(task.id, comments);
  assert.equal(designs.get(task.id).comments?.length, 1);
  assert.match(designs.frame(designs.get(task.id)), /"designId":"hero"/);
});

test('custom DESIGN.md packages import, pin with a 40-hex version, and sit beside bundled systems', (t) => {
  const { root } = fixture(t),
    bundled = catalog(root),
    customRoot = join(root, 'custom'),
    archive = join(root, 'archive');
  const pack = join(root, 'My Brand Pack');
  mkdirSync(pack);
  writeFileSync(join(pack, 'DESIGN.md'), '# Local Brand\nUse ochre and ink.');
  writeFileSync(join(pack, 'tokens.css'), ':root{--od-color-primary:#b97559;}');
  const systems = new DesignSystems(bundled, archive, customRoot);
  const imported = systems.importFolder(pack);
  assert.equal(imported.origin, 'custom');
  assert.match(imported.id, /^custom-my-brand-pack$/);
  assert.match(imported.version, /^[a-f0-9]{40}$/);
  assert.equal(systems.list().filter((item) => item.origin === 'custom').length, 1);
  assert.equal(systems.list().filter((item) => item.origin === 'bundled').length, 1);
  assert.match(systems.read(imported.id, 'DESIGN.md').toString(), /ochre/);
  assert.ok(existsSync(join(archive, imported.version, imported.id, 'pinned-manifest.json')));
  const empty = join(root, 'empty');
  mkdirSync(empty);
  writeFileSync(join(empty, 'README.md'), 'nope');
  assert.throws(() => systems.importFolder(empty), /DESIGN\.md/);
});
test('design system specimens take only plain colors, font stacks and lengths from tokens', (t) => {
  const root = tempDir(t, 'aelion-specimen-'),
    customRoot = join(root, 'custom'),
    pack = join(root, 'Hostile Pack');
  mkdirSync(pack);
  writeFileSync(join(pack, 'DESIGN.md'), '# Hostile\nTry to load things.');
  writeFileSync(
    join(pack, 'tokens.css'),
    '/* :root { --bg: #000000; } */\n:root{--bg:url(https://evil.example/x.png);--fg:#112233;--accent:var(--fg);' +
      '--radius-md:expression(alert(1));--font-display:"Brand", serif;--font-body:x</style><script>;}\n' +
      ':root[data-theme=dark]{--fg:#eeeeee;}',
  );
  const systems = new DesignSystems(join('assets', 'design-systems'), join(root, 'archive'), customRoot);
  const stripe = systems.list().find((item) => item.id === 'stripe')!;
  assert.equal(stripe.preview?.bg, '#ffffff');
  assert.equal(stripe.preview?.accent, '#533afd');
  assert.equal(stripe.preview?.radius, '6px');
  assert.ok(stripe.preview?.display);
  const withTokens = systems.list().filter((item) => item.preview?.bg && item.preview.fg && item.preview.accent);
  assert.ok(withTokens.length > 140, String(withTokens.length));
  const hostile = systems.importFolder(pack);
  const preview = systems.list().find((item) => item.id === hostile.id)!.preview!;
  assert.equal(preview.bg, undefined);
  assert.equal(preview.fg, '#112233');
  assert.equal(preview.accent, '#112233');
  assert.equal(preview.radius, undefined);
  assert.equal(preview.display, '"Brand", serif');
  assert.equal(preview.body, '"Brand", serif');
});

test('brand checks repair nearby token colors and stay visible without blocking format', () => {
  const tokens = parseDesignTokens(
    ':root{--od-color-primary:#112233;--font-display:Georgia,serif;--text-lg:32px;--space-m:16px}',
  );
  const html =
    '<html><style>:root{--od-color-primary:#112233}h1{color:#122334;font-family:Inter,sans-serif}</style><body><h1>Hi</h1></body></html>';
  const repaired = repairDesignBrand(html, tokens);
  assert.equal(repaired.changed, true);
  assert.match(repaired.html, /var\(--od-color-primary\)/);
  assert.match(repaired.html, /var\(--font-display\)/);
  assert.equal(brandCheckLabel(true), '品牌对齐');
  assert.equal(brandCheckLabel(false, true), 'Not on brand');
  const off = checkDesignBrand('<html><style>h1{color:#ff00aa;font-family:Arial}</style><h1>x</h1></html>', tokens);
  assert.equal(off.aligned, false);
  assert.ok(off.issues.length);
});

test('sessions saved with the retired optional checks load without them', (t) => {
  const { root, store, bot } = fixture(t);
  const systems = new DesignSystems(catalog(root));
  const first = new DesignStore(
    store,
    systems,
    () => {},
    () => join(root, 'ws'),
  );
  const task = first.create({ botId: bot.id, kind: 'mobile', brief: 'App' });
  const saved = JSON.parse(readFileSync(first.file, 'utf8'));
  saved.sessions[0].plugins = ['spacing-audit'];
  writeFileSync(first.file, JSON.stringify(saved));
  const reloaded = new DesignStore(
    store,
    systems,
    () => {},
    () => join(root, 'ws'),
  );
  assert.equal('plugins' in reloaded.get(task.id), false);
  assert.doesNotMatch(JSON.stringify(reloaded.snapshot()), /plugins|spacing-audit/);
});

test('PDF export requires a %PDF- header and wraps fragment HTML', async () => {
  assert.match(printReadyHtml('<h1>Hi</h1>'), /<html/i);
  const pdf = await renderDesignPdf('<html><body>Hi</body></html>', async () => Buffer.from('%PDF-1.4\n%fixture\n'));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  await assert.rejects(
    renderDesignPdf('<html></html>', async () => Buffer.from('not-pdf')),
    { code: 'design.pdf_invalid' },
  );
});

test('mobile and document playbooks stay first-party and publish HTML as the primary artifact', () => {
  assert.equal(designerPlaybookName('mobile'), 'mobile');
  assert.equal(designerPlaybookName('document'), 'document');
  assert.match(designerPlaybook('mobile'), /data-design-id/);
  assert.match(designerPlaybook('document'), /design_export_pdf/);
});
