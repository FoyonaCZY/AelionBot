import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tempDir } from './helpers';
import { Store } from '../electron/core/storage/store';
import { DesignSystems } from '../electron/core/designer/design-systems';
import { DesignStore } from '../electron/core/designer/design-store';
import { DesignerFiles } from '../electron/core/designer/designer-files';
import { lineChanges, recordDesignChange } from '../shared/designer/design-changes';
import { clampDesignerChatWidth, deliveryState, designRoundFiles } from '../src/designer/designer-round';

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
const bytes = (text: string) => Buffer.from(text);

test('line changes count edits, new files and ignore binary content', () => {
  assert.deepEqual(lineChanges(bytes('a\nb\nc'), bytes('a\nB\nc\nd')), { added: 2, removed: 1 });
  assert.deepEqual(lineChanges(undefined, bytes('one\ntwo')), { added: 2, removed: 0 });
  assert.deepEqual(lineChanges(bytes('x\r\ny'), bytes('x\ny')), { added: 0, removed: 0 });
  // A moved line is not a change.
  assert.deepEqual(lineChanges(bytes('a\nb'), bytes('b\na')), { added: 0, removed: 0 });
  assert.equal(lineChanges(bytes('text'), Buffer.from([0x89, 0x50, 0, 0x47])), undefined);
});

test('changes accumulate per run and file, and only recent runs are kept', () => {
  let all = recordDesignChange(undefined, 'r1', 'a/index.html', { added: 3, removed: 1 });
  all = recordDesignChange(all, 'r1', 'a/index.html', { added: 2, removed: 2 });
  all = recordDesignChange(all, 'r1', 'a/logo.png', undefined);
  assert.deepEqual(all.r1['a/index.html'], { writes: 2, added: 5, removed: 3 });
  assert.deepEqual(all.r1['a/logo.png'], { writes: 1 });
  for (let i = 2; i <= 32; i++) all = recordDesignChange(all, 'r' + i, 'a/index.html', { added: 1, removed: 0 });
  assert.equal(Object.keys(all).length, 30);
  assert.equal(all.r1, undefined);
});

test('designer writes during a run are recorded on the session; writes outside a run are not', (t) => {
  const root = tempDir(t, 'aelion-rounds-');
  const store = new Store(join(root, 'data'));
  const bot = store.createBot('Designer', 'Design', undefined, undefined, { type: 'designer' });
  const catalogDir = catalog(root);
  const designs = new DesignStore(store, new DesignSystems(catalogDir));
  const task = designs.create({ botId: bot.id, kind: 'prototype', brief: 'Page' });
  const files = new DesignerFiles(store, designs);
  const session = designs.get(task.id);
  files.write(session, 'index.html', bytes('<p>draft</p>'));
  assert.equal(session.changes, undefined);
  session.activeRunId = 'run-1';
  files.write(session, 'index.html', bytes('<p>one</p>\n<p>two</p>'));
  files.write(session, 'index.html', bytes('<p>one</p>\n<p>two</p>\n<p>three</p>'));
  // Rewriting identical bytes is not a change.
  files.write(session, 'index.html', bytes('<p>one</p>\n<p>two</p>\n<p>three</p>'));
  const recorded = Object.entries(session.changes!['run-1']);
  assert.equal(recorded.length, 1);
  assert.match(recorded[0][0], /index\.html$/);
  assert.deepEqual(recorded[0][1], { writes: 2, added: 3, removed: 1 });
});

test('the round card keeps the last copy of each delivered file and matches stats by name', () => {
  const file = (id: string, name: string) => ({ id, name, size: 10, mime: 'text/html' });
  const rows = designRoundFiles(
    [file('1', 'index.html'), file('2', 'app.js'), file('3', 'index.html'), file('4', 'index.html')],
    {
      'designers/b/t/index.html': { writes: 3, added: 42, removed: 18 },
      'designers/b/t/a/app.js': { writes: 1, added: 6, removed: 2 },
      'designers/b/t/b/app.js': { writes: 1, added: 1, removed: 0 },
    },
  );
  assert.deepEqual(
    rows.map((row) => row.attachment.id),
    ['2', '4'],
  );
  assert.deepEqual(rows[1].change, { writes: 3, added: 42, removed: 18 });
  // Two app.js files in different folders: which one was delivered is unknown, so no stats.
  assert.equal(rows[0].change, undefined);
});

test('delivery shows one of four states and blocking findings prevent confirming', () => {
  const base = { accepted: false, running: false, blocking: 0, canAccept: true };
  assert.equal(deliveryState(base), 'pending');
  assert.equal(deliveryState({ ...base, running: true }), 'running');
  assert.equal(deliveryState({ ...base, blocking: 1 }), 'blocked');
  assert.equal(deliveryState({ ...base, accepted: true, blocking: 1 }), 'accepted');
  assert.equal(deliveryState({ ...base, canAccept: false }), 'empty');
});

test('the split conversation column stays between 360 and 640px and leaves the canvas 360px', () => {
  assert.equal(clampDesignerChatWidth(200), 360);
  assert.equal(clampDesignerChatWidth(900), 640);
  assert.equal(clampDesignerChatWidth(500, 1000), 500);
  assert.equal(clampDesignerChatWidth(600, 900), 540);
});
