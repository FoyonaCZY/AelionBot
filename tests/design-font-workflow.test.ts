import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './helpers';
import { mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../electron/core/storage/store';
import { DesignStore } from '../electron/core/designer/design-store';
import { DesignerFiles } from '../electron/core/designer/designer-files';
import { DesignFonts } from '../electron/core/designer/design-fonts';
import { applyDesignFont } from '../electron/core/designer/design-font-application';

const fixture = (t: test.TestContext) => {
  const root = tempDir(t, 'aelion-font-flow-');
  const store = new Store(join(root, 'data'));
  t.after(() => store.close());
  const bot = store.createBot('Designer', '');
  store.data.model.model = 'test';
  const designs = new DesignStore(
      store,
      {} as any,
      () => {},
      () => join(root, 'workspace'),
    ),
    session = designs.create({ botId: bot.id, kind: 'prototype', brief: 'Font test' }),
    files = new DesignerFiles(store, designs),
    fonts = new DesignFonts({
      cacheDir: join(root, 'cache'),
      files,
      fetch: async () => {
        throw Error('offline test');
      },
    });
  const source = resolve('node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2');
  mkdirSync(join(session.workspaceDir!, 'assets'), { recursive: true });
  copyFileSync(source, join(session.workspaceDir!, 'assets/source.woff2'));
  return {
    root,
    store,
    bot,
    designs,
    session: designs.get(session.id),
    files,
    fonts,
    fontPath: join(session.workspaceDir!, 'assets/source.woff2'),
  };
};

test('font application preserves source and ignores managed markers and head strings inside scripts/templates', async (t) => {
  const f = fixture(t),
    [font] = await f.fonts.importFile(f.session, f.fontPath);
  const script =
      '<script>const sample="<!-- aelion:project-fonts --><!-- /aelion:project-fonts -->";const head="</head>";</script>',
    template = '<template><!-- aelion:project-fonts -->sample<!-- /aelion:project-fonts --></template>';
  const html =
    '<!doctype html>\r\n<html><head>' +
    script +
    '<style>.hero{font-family:serif}</style></head><body>' +
    template +
    '<h1 class="hero" style="font-family:Arial">Hello</h1><p>Content</p></body></html>';
  f.files.write(f.session, 'pages/index.html', Buffer.from(html));
  await applyDesignFont(f.files, f.session, f.fonts.list(f.session), {
    fontId: font.id,
    role: 'display',
    path: 'pages/index.html',
  });
  const first = readFileSync(f.files.absolute(f.session, 'pages/index.html'), 'utf8');
  assert.ok(first.includes(script));
  assert.ok(first.includes(template));
  assert.ok(first.startsWith('<!doctype html>\r\n'));
  assert.match(first, /href="\.\.\/assets\/fonts\/fonts.css"/);
  assert.match(first, /font-family:var\(--font-display\)!important/);
  await applyDesignFont(f.files, f.session, f.fonts.list(f.session), {
    fontId: font.id,
    role: 'body',
    path: 'pages/index.html',
  });
  const second = readFileSync(f.files.absolute(f.session, 'pages/index.html'), 'utf8');
  assert.equal((second.match(/data-font-roles=/g) || []).length, 1);
  assert.match(second, /--font-display/);
  assert.match(second, /--font-body/);
  assert.ok(second.includes(script));
  assert.ok(second.includes(template));
  await assert.rejects(
    applyDesignFont(
      f.files,
      f.session,
      f.fonts.list(f.session),
      { fontId: font.id, role: 'mono', path: 'pages/index.html' },
      () => {
        throw Error('cancelled');
      },
    ),
    /cancelled/,
  );
  assert.equal(readFileSync(f.files.absolute(f.session, 'pages/index.html'), 'utf8'), second);
  await assert.rejects(
    applyDesignFont(f.files, f.session, f.fonts.list(f.session), {
      fontId: font.id,
      role: 'body',
      path: '../outside.html',
    }),
  );
});
