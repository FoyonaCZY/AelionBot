import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editText, FileToolError } from '../electron/core/file-text';
import { applyHunks, parsePatch, VM_PATCH_SCRIPT } from '../electron/core/multi-patch';

const sha = (text: string) => createHash('sha256').update(Buffer.from(text)).digest('hex');
const edit = (text: string, oldText: string, newText: string, replaceAll?: boolean) =>
  editText(Buffer.from(text), { oldText, newText, expectedSha256: sha(text), replaceAll });
const hunks = (patch: string) => parsePatch(`*** Begin Patch\n*** Update File: a\n${patch}\n*** End Patch`)[0].hunks;
const patched = (text: string, patch: string) => applyHunks(Buffer.from(text), hunks(patch)).toString('utf8');

test('exact edits are unchanged and report no fuzzy strategy', () => {
  const result = edit('a\nb\nc\n', 'b\n', 'B\n');
  assert.equal(result.content, 'a\nB\nc\n');
  assert.equal((result as any).matchStrategy, undefined);
});

test('edits tolerate trailing spaces, indentation drift and typographic punctuation', () => {
  const trailing = edit('if (x) {  \n  run();\n}\n', 'if (x) {\n  run();', 'if (y) {\n  go();');
  assert.equal(trailing.content, 'if (y) {\n  go();\n}\n');
  assert.equal(trailing.matchStrategy, 'trim-end');
  // The model dropped one indentation level; the replacement is carried back to the file's indentation.
  const indented = edit(
    'class A {\n    method() {\n        return 1;\n    }\n}\n',
    'method() {\n    return 1;\n}',
    'method() {\n    return 2;\n}',
  );
  assert.equal(indented.content, 'class A {\n    method() {\n        return 2;\n    }\n}\n');
  assert.equal(indented.matchStrategy, 'trim');
  const quotes = edit('say(“hello” — world)\n', 'say("hello" - world)', 'say("bye")');
  assert.equal(quotes.content, 'say("bye")\n');
  assert.equal(quotes.matchStrategy, 'unicode');
});

test('fuzzy edits keep CRLF, stay unique and explain misses with nearby lines', () => {
  assert.equal(edit('one  \r\ntwo\r\n', 'one\ntwo\n', 'uno\ndos\n').content, 'uno\r\ndos\r\n');
  assert.throws(
    () => edit('  x\n  x\n', 'x', 'y'),
    (error: FileToolError) => error.code === 'EDIT_AMBIGUOUS',
  );
  assert.equal(edit('  x\n  x\n', 'x\n', 'y\n', true).content, '  y\n  y\n');
  assert.throws(
    () => edit('function alpha() {\n  return 1;\n}\n', 'function alpha() {\n  return 9;\n}', 'x'),
    (error: FileToolError) =>
      error.code === 'EDIT_NOT_FOUND' && (error.details?.similarLines as any[] | undefined)?.[0].line === 1,
  );
});

test('patches keep each line ending and accept bare blank context lines', () => {
  // A mostly-LF file with one CRLF line keeps both; only the changed line is rewritten.
  assert.equal(patched('a\nb\r\nc\nd\n', '@@\n b\n-c\n+C'), 'a\nb\r\nC\nd\n');
  assert.equal(patched('x\r\ny\r\n', '@@\n x\n-y\n+Y\n+Z'), 'x\r\nY\r\nZ\r\n');
  assert.equal(patched('no newline', '@@\n-no newline\n+still none'), 'still none');
  // Generators often omit the space before an empty context line.
  assert.equal(patched('one\n\ntwo\n', '@@\n one\n\n-two\n+TWO'), 'one\n\nTWO\n');
  // A trailing blank separator line is not required to be context.
  assert.equal(patched('first\nsecond\n', '@@\n-second\n+SECOND\n'), 'first\nSECOND\n');
});

test('patch context is fuzzy but keeps the file text of context lines, and @@ anchors disambiguate', () => {
  assert.equal(
    patched('def f():\n    x = 1   \n    return x\n', '@@\n x = 1\n-return x\n+return x + 1'),
    'def f():\n    x = 1   \n    return x + 1\n',
  );
  const twice = 'def a():\n    return 0\ndef b():\n    return 0\n';
  assert.throws(() => patched(twice, '@@\n-    return 0\n+    return 1'), /多处/);
  assert.equal(
    patched(twice, '@@ def b():\n-    return 0\n+    return 1'),
    'def a():\n    return 0\ndef b():\n    return 1\n',
  );
});

test('the VM patch script matches the host patch behaviour', (t) => {
  const python = process.env.AELION_TEST_PYTHON || 'python';
  try {
    execFileSync(python, ['-c', 'print(1)'], { stdio: 'ignore' });
  } catch {
    t.skip('Python is not available');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'aelion-vm-patch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (name: string, text: string, patch: string) => {
    writeFileSync(join(dir, name), text);
    execFileSync(python, ['-c', 'import json,sys\na=json.load(sys.stdin)\n' + VM_PATCH_SCRIPT], {
      cwd: dir,
      input: JSON.stringify({
        files: parsePatch(`*** Begin Patch\n*** Update File: ${name}\n${patch}\n*** End Patch`),
      }),
      encoding: 'utf8',
    });
    return readFileSync(join(dir, name), 'utf8');
  };
  const cases: Array<[string, string]> = [
    ['a\nb\r\nc\nd\n', '@@\n b\n-c\n+C'],
    ['one\n\ntwo\n', '@@\n one\n\n-two\n+TWO'],
    ['first\nsecond\n', '@@\n-second\n+SECOND\n'],
    ['def f():\n    x = 1   \n    return x\n', '@@\n x = 1\n-return x\n+return x + 1'],
    ['def a():\n    return 0\ndef b():\n    return 0\n', '@@ def b():\n-    return 0\n+    return 1'],
    ['say(“hi”)\n', '@@\n-say("hi")\n+say("bye")'],
    ['no newline', '@@\n-no newline\n+still none'],
  ];
  cases.forEach(([text, patch], index) =>
    assert.equal(run('f' + index, text, patch), patched(text, patch), `case ${index}`),
  );
});
