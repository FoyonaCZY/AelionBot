import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codeLanguage,
  prettyJson,
  readableResult,
  relativePath,
  searchFiles,
  stepMeta,
} from '../src/chat/tool-details-model';

test('command output that is JSON, or one JSON value per line, is pretty-printed; anything else is left alone', () => {
  assert.equal(prettyJson('{"a":1,"b":[2]}'), '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
  assert.equal(prettyJson('{"a":1}\n{"b":2}\n'), '{\n  "a": 1\n}\n\n{\n  "b": 2\n}');
  assert.equal(prettyJson('exit=0\n{"a":1}'), undefined);
  assert.equal(prettyJson('{not json'), undefined);
  assert.equal(prettyJson(''), undefined);
});

test('file names map to highlighter languages', () => {
  assert.equal(codeLanguage('src/a/stream.rs'), 'rust');
  assert.equal(codeLanguage('C:\\x\\ToolDetails.tsx'), 'tsx');
  assert.equal(codeLanguage('Dockerfile'), 'dockerfile');
  assert.equal(codeLanguage('notes.txt'), '');
});

test('folded step rows show a failing exit code before duration, then hit counts', () => {
  assert.deepEqual(stepMeta({ exitCode: 1, durationMs: 45000 }), { text: 'exit 1', tone: 'bad' });
  assert.deepEqual(stepMeta({ exitCode: 0, durationMs: 3900 }), { text: '3.9s' });
  assert.deepEqual(stepMeta({ durationMs: 45100 }), { text: '45s' });
  assert.match(stepMeta({ matches: [{}, {}] })!.text, /2/);
  assert.equal(stepMeta({ replacements: 1 }), undefined);
  assert.equal(stepMeta('plain text'), undefined);
});

test('search results group matches per file, relative to the searched root, with context lines', () => {
  const files = searchFiles({
    path: 'C:\\repo\\src',
    matches: [
      {
        path: 'C:\\repo\\src\\a\\card.tsx',
        line: 112,
        text: 'const reset = () => {',
        before: ['', '  // reset'],
        after: ['  go();'],
      },
      { path: 'C:\\repo\\src\\a\\card.tsx', line: 113, text: '  // reset' },
      { path: 'C:\\repo\\src\\b.ts', line: 3, text: 'reset()' },
    ],
  });
  assert.deepEqual(
    files.map((file) => [file.path, file.dir, file.count]),
    [
      ['a/card.tsx', 'a', 2],
      ['b.ts', '', 1],
    ],
  );
  assert.deepEqual(
    files[0].lines.map((line) => [line.line, Boolean(line.context)]),
    [
      [110, true],
      [111, true],
      [112, false],
      [113, false],
    ],
  );
});

test('files and count modes still list files', () => {
  assert.deepEqual(
    searchFiles({ path: '/r', files: ['/r/x.ts', '/other/y.ts'] }).map((file) => file.path),
    ['x.ts', '/other/y.ts'],
  );
  assert.equal(searchFiles({ path: '/r', counts: [{ path: '/r/x.ts', count: 4 }] })[0].count, 4);
  assert.equal(relativePath('/r', '/r'), 'r');
});

test('readable results drop paging and checksum bookkeeping at every depth', () => {
  assert.deepEqual(
    readableResult({ path: 'p', sha256: 'x', eof: true, items: [{ name: 'n', textStartColumn: 1 }], location: 'host' }),
    { path: 'p', items: [{ name: 'n' }] },
  );
});
