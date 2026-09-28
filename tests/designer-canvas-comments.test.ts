import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './helpers';
import { join } from 'node:path';
import { Store } from '../electron/core/storage/store';
import { DesignStore } from '../electron/core/designer/design-store';
import type { DesignSystems } from '../electron/core/designer/design-systems';
import type { PreviewAnnotation } from '../shared/types/preview-editor-types';
import { commentsFromAnnotations, commentScope } from '../shared/preview/designer-canvas';

function fixture(t: test.TestContext) {
  const root = tempDir(t, 'aelion-canvas-comments-');
  const store = new Store(join(root, 'data')),
    bot = store.createBot('Designer', '', undefined, undefined, { type: 'designer' });
  const systems = { list: () => [] } as unknown as DesignSystems,
    designs = new DesignStore(store, systems);
  const task = designs.create({ botId: bot.id, kind: 'prototype', brief: 'Canvas feedback' });
  return { store, bot, systems, designs, task, path: task.workspacePath + '/index.html' };
}
const mark = (
  id: string,
  type: PreviewAnnotation['type'] = 'rect',
  overrides: Partial<PreviewAnnotation> = {},
): PreviewAnnotation => ({
  id,
  type,
  x: 0.1,
  y: 0.2,
  w: 0.3,
  h: 0.15,
  color: '#3975c6',
  sourceWidth: 1440,
  sourceHeight: 2400,
  ...overrides,
});

test('every annotation tool produces a persistent comment with its source geometry', (t) => {
  const f = fixture(t),
    marks: PreviewAnnotation[] = [
      mark('area'),
      mark('arrow', 'arrow', { end: { x: 0.7, y: 0.6 } }),
      mark('pen', 'pen', {
        points: [
          { x: 0.1, y: 0.2 },
          { x: 0.2, y: 0.3 },
          { x: 0.3, y: 0.4 },
        ],
      }),
      mark('note', 'text', { text: '移动文字' }),
      mark('element', 'element', {
        selector: 'main > button',
        designId: 'cta',
        elementLabel: 'button',
        elementText: 'Start',
      }),
    ];
  const comments = commentsFromAnnotations(f.path, '增加间距', marks);
  assert.equal(comments.length, 5);
  assert.equal(comments[0].text, '增加间距');
  assert.equal(comments[3].text, '移动文字');
  assert.deepEqual(
    comments.map((c) => c.annotation),
    marks,
  );
  assert.equal(new Set(comments.map((c) => c.id)).size, 5);
  f.designs.addComments(f.task.id, comments);
  const reopened = new DesignStore(f.store, f.systems),
    persisted = reopened.get(f.task.id).comments!;
  assert.deepEqual(
    persisted.map((c) => c.annotation),
    marks,
  );
  assert.deepEqual(
    commentScope(persisted).map((c) => c.annotation),
    marks,
  );
  assert.deepEqual(
    JSON.parse(reopened.frame(reopened.get(f.task.id))).comments.map((c: any) => c.annotation),
    marks,
  );
  marks[0].x = 0.9;
  comments[1].annotation!.end!.x = 0.99;
  assert.equal(persisted[0].annotation!.x, 0.1);
  assert.equal(f.designs.get(f.task.id).comments![1].annotation!.end!.x, 0.7);
});

test('equal feedback for different areas and elements is retained while a repeated submission is deduplicated', (t) => {
  const f = fixture(t),
    marks = [
      mark('area-one'),
      mark('area-two', 'rect', { x: 0.6 }),
      mark('first-button', 'element', { selector: 'button:nth-of-type(1)' }),
      mark('second-button', 'element', { selector: 'button:nth-of-type(2)' }),
    ];
  const first = commentsFromAnnotations(f.path, '对齐', marks);
  assert.equal(first.length, 4);
  f.designs.addComments(f.task.id, first);
  f.designs.addComments(f.task.id, commentsFromAnnotations(f.path, '对齐', marks));
  assert.equal(f.designs.get(f.task.id).comments!.length, 4);
  assert.deepEqual(commentsFromAnnotations(f.path, '对齐', marks, first), []);
  const changed = commentsFromAnnotations(f.path, '增加留白', [marks[0]], first);
  assert.equal(changed.length, 1);
  assert.notEqual(changed[0].id, first[0].id);
  f.designs.addComments(f.task.id, changed);
  assert.equal(f.designs.get(f.task.id).comments!.length, 5);
  const otherFile = commentsFromAnnotations(f.task.workspacePath + '/other.html', '对齐', [marks[0]], first);
  assert.equal(otherFile.length, 1);
});

test('legacy annotations without IDs use their selector and geometry to identify the target', () => {
  const first = { ...mark(''), selector: 'main > button' },
    other = { ...first, x: 0.6 },
    otherSelector = { ...first, selector: 'aside > button' };
  const comments = commentsFromAnnotations('index.html', '修改', [first, other, otherSelector]);
  assert.equal(comments.length, 3);
  assert.equal(commentsFromAnnotations('index.html', '修改', [{ ...first }], comments).length, 0);
  assert.equal(commentsFromAnnotations('index.html', '修改', [{ ...other, y: 0.7 }], comments).length, 1);
  const resolved = comments.map((c) => ({ ...c, status: 'resolved' as const }));
  assert.equal(commentsFromAnnotations('index.html', '修改', [first], resolved).length, 1);
});

test('comments remain inside their chosen design task and its conversation origin', (t) => {
  const f = fixture(t),
    other = f.designs.create({ botId: f.bot.id, kind: 'prototype', brief: 'Other canvas' });
  f.designs.addComments(f.task.id, commentsFromAnnotations(f.path, '修改', [mark('one')]));
  assert.equal(f.designs.get(other.id).comments!.length, 0);
  assert.throws(() => f.designs.get(f.task.id, undefined, { kind: 'bot', id: 'another-bot' }), {
    code: 'design.session_not_found',
  });
});
