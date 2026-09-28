import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const KEY_LINE = /^\s*(?:'((?:\\.|[^'\\])*)'|([^\s'":][^:]*?))\s*:/;

function readTableSource(path: string) {
  const text = readFileSync(path, 'utf8');
  const start = text.indexOf('{', text.indexOf('='));
  const body = text.slice(start, text.lastIndexOf('}') + 1);
  return { text, table: new Function('return ' + body)() as Record<string, string> };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    if (name === 'node_modules' || name === '.git') continue;
    const path = join(root, dir, name);
    if (statSync(path).isDirectory()) walk(join(dir, name), out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(relative(root, path).replace(/\\/g, '/'));
  }
  return out;
}

/**
 * A duplicate key silently wins over the earlier entry, which makes a translation look present
 * while a different string ships. TypeScript reports it only for files that are type-checked,
 * and the parity test cannot see it because both tables can carry the same duplicate.
 */
test('locale tables contain no duplicate keys', () => {
  for (const file of ['shared/i18n/locales/en.ts', 'shared/i18n/locales/zh-TW.ts']) {
    const seen = new Map<string, number>();
    const duplicates: string[] = [];
    readTableSource(file)
      .text.split('\n')
      .forEach((line, index) => {
        const match = line.match(KEY_LINE);
        if (!match) return;
        const key = match[1] ?? (match[2] as string).trim();
        const first = seen.get(key);
        if (first === undefined) seen.set(key, index + 1);
        else duplicates.push(`${JSON.stringify(key)} at lines ${first} and ${index + 1}`);
      });
    assert.deepEqual(duplicates, [], `${file} has duplicate keys`);
  }
});

/**
 * Keys are the zh-CN source strings. A `t('...')` call whose key is missing from a table falls
 * back to the source string, so the English interface quietly shows Chinese. This is the check
 * that keeps new interface copy from shipping untranslated.
 */
test('every literal translation key used in the code exists in both tables', () => {
  const en = readTableSource('shared/i18n/locales/en.ts').table;
  const zhTW = readTableSource('shared/i18n/locales/zh-TW.ts').table;
  // Interface copy is often a chain of literals inside one call, e.g.
  // `t(phase === 'a' ? '甲' : '乙')` split across lines. Matching only a quote directly after
  // `t(` misses every branch but the first, which is how untranslated English copy survived.
  const literalKey = /\b(?:t|translate)\s*\(([^()]{0,600}?)'((?:\\.|[^'\\])*)'/g;
  const missing: string[] = [];
  for (const file of [...walk('src'), ...walk('electron')]) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const match of text.matchAll(literalKey)) {
      const key = match[2].replace(/\\'/g, "'");
      // Untranslated keys are always Chinese source strings; this skips CSS `translate(...)`.
      if (!/[\u4e00-\u9fff]/.test(key)) continue;
      if (!(key in en)) missing.push(`${file}: ${JSON.stringify(key)} missing from en.ts`);
      if (!(key in zhTW)) missing.push(`${file}: ${JSON.stringify(key)} missing from zh-TW.ts`);
    }
  }
  assert.deepEqual(missing, [], 'add the missing entries to both locale tables');
});
