import test from 'node:test';
import assert from 'node:assert/strict';
import { lineDiff, toolDiff } from '../shared/chat/tool-diff';
import { sameMessage } from '../src/chat/render-equality';

const ops = (lines: Array<{ op: string; text: string }>) => lines.map((line) => line.op + line.text);

test('a file edit shows removed and added lines with a little context', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n'),
    after = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h'].join('\n');
  const diff = lineDiff(before, after);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.deepEqual(ops(diff.lines), [' b', ' c', ' d', '-e', '+E', ' f', ' g', ' h']);
});

test('distant changes are separated by a gap and unchanged runs are dropped', () => {
  const lines = Array.from({ length: 30 }, (_, i) => 'line ' + i);
  const after = [...lines];
  after[2] = 'changed 2';
  after[25] = 'changed 25';
  const diff = lineDiff(lines.join('\n'), after.join('\n'));
  assert.equal(diff.lines.filter((line) => line.op === '…').length, 1);
  assert.ok(diff.lines.length < 20);
  assert.equal(diff.added, 2);
});

test('host_file_patch and apply_patch produce diffs; other tools do not', () => {
  const patch = toolDiff('host_file_patch', { path: 'src/a.ts', oldText: 'x = 1', newText: 'x = 2\ny = 3' });
  assert.equal(patch?.files[0].path, 'src/a.ts');
  assert.equal(patch?.files[0].added, 2);
  assert.equal(patch?.files[0].removed, 1);
  const applied = toolDiff('apply_patch', {
    patch: [
      '*** Begin Patch',
      '*** Add File: docs/new.md',
      '+hello',
      '+world',
      '*** Update File: src/b.ts',
      '*** Move to: src/c.ts',
      '@@',
      ' keep',
      '-old',
      '+new',
      '@@ function x',
      '-gone',
      '*** Delete File: src/d.ts',
      '*** End Patch',
    ].join('\n'),
  });
  assert.deepEqual(
    applied?.files.map((file) => [file.path, file.kind, file.added, file.removed, file.moveTo]),
    [
      ['docs/new.md', 'add', 2, 0, undefined],
      ['src/b.ts', 'move', 1, 2, 'src/c.ts'],
      ['src/d.ts', 'delete', 0, 0, undefined],
    ],
  );
  assert.deepEqual(ops(applied!.files[1].lines), [' keep', '-old', '+new', '…', '-gone']);
  assert.equal(toolDiff('host_file_write', { path: 'a', content: 'b' }), undefined);
  assert.equal(toolDiff('host_file_patch', { path: 'a' }), undefined);
});

test('large diffs keep exact counts but a bounded number of lines, and pass text through redaction', () => {
  const before = Array.from({ length: 900 }, (_, i) => 'old ' + i).join('\n'),
    after = Array.from({ length: 900 }, (_, i) => 'new ' + i).join('\n');
  const diff = toolDiff('host_file_patch', { path: 'big.txt', oldText: before, newText: after })!;
  assert.equal(diff.files[0].added, 900);
  assert.equal(diff.files[0].removed, 900);
  assert.ok(diff.files[0].lines.length <= 400);
  assert.equal(diff.truncated, true);
  const redacted = toolDiff(
    'host_file_patch',
    { path: 'C:\\Users\\example\\a.env', oldText: 'KEY=sk-123', newText: 'KEY=sk-456' },
    (text) => text.replace(/sk-\d+/g, '[redacted]').replace('C:\\Users\\example', '~'),
  )!;
  assert.equal(redacted.files[0].path, '~\\a.env');
  assert.ok(redacted.files[0].lines.every((line) => !line.text.includes('sk-')));
});

test('render equality notices a diff appearing without serializing it', () => {
  const base = { id: 'm', botId: 'b', role: 'tool' as const, content: '{}', time: 't', status: 'done' as const };
  const diff = toolDiff('host_file_patch', { path: 'a', oldText: 'a', newText: 'b' })!;
  assert.equal(sameMessage(base, { ...base }), true);
  assert.equal(sameMessage(base, { ...base, diff }), false);
  assert.equal(sameMessage({ ...base, diff }, { ...base, diff: structuredClone(diff) }), true);
});
