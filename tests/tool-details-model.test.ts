import test from 'node:test';
import assert from 'node:assert/strict';
import { readableResult, relativePath, searchFiles } from '../src/chat/tool-details-model';

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
