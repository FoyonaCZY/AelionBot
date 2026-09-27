import test from 'node:test';
import assert from 'node:assert/strict';
import { en } from '../shared/i18n/locales/en';
import { zhTW } from '../shared/i18n/locales/zh-TW';
import { translateFor } from '../shared/i18n';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('every locale translates the same set of source strings', () => {
  assert.deepEqual(
    Object.keys(en).filter((key) => !(key in zhTW)),
    [],
  );
  assert.deepEqual(
    Object.keys(zhTW).filter((key) => !(key in en)),
    [],
  );
});

test('translations keep the placeholders of their source string', () => {
  for (const [name, table] of Object.entries({ en, zhTW }))
    for (const [source, translated] of Object.entries(table))
      assert.deepEqual(placeholders(translated), placeholders(source), `${name}: ${source}`);
});

test('supports all three interface languages', () => {
  assert.equal(translateFor('zh-CN', '偏好设置'), '偏好设置');
  assert.equal(translateFor('zh-TW', '偏好设置'), '偏好設定');
  assert.equal(translateFor('en', '偏好设置'), 'Preferences');
  assert.equal(translateFor('zh-TW', '渐变'), '漸層');
  assert.equal(translateFor('en', '渐变'), 'Gradient');
  assert.equal(translateFor('zh-TW', '演示'), '簡報');
  assert.equal(translateFor('en', '{reviewer} 正在审核本次操作', { reviewer: 'A' }), 'A is reviewing this action');
  assert.equal(translateFor('en', '第 {line} 行起', { line: 12 }), 'from line 12');
});

test('English translations contain no Chinese text', () => {
  assert.deepEqual(
    Object.entries(en).filter(([, value]) => /[一-鿿]/.test(value)),
    [],
  );
});

test('translation interpolates values and falls back to the source string', () => {
  assert.equal(translateFor('en', '退出码 {code}', { code: 2 }), 'Exit code 2');
  assert.equal(translateFor('zh-CN', '退出码 {code}', { code: 2 }), '退出码 2');
  assert.equal(translateFor('en', '没有这条文案 {x}'), '没有这条文案 {x}');
});
