import test from 'node:test';
import assert from 'node:assert/strict';
import {translateFor,translationTables} from '../src/i18n';

test('supports all three interface languages and interpolation',()=>{
  assert.equal(translateFor('zh-CN','偏好设置'),'偏好设置');
  assert.equal(translateFor('zh-TW','偏好设置'),'偏好設定');
  assert.equal(translateFor('en','偏好设置'),'Preferences');
  assert.equal(translateFor('en','{count} 个模型',{count:3}),'3 models');
  assert.equal(Object.values(translationTables.en).filter(value=>[...value].some(char=>{const code=char.codePointAt(0)||0;return code>=0x4e00&&code<=0x9fff;})).length,0);
});
