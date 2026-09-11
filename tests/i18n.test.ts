import test from 'node:test';
import assert from 'node:assert/strict';
import {translateFor,translationTables} from '../src/i18n';

test('supports all three interface languages and interpolation',()=>{
  assert.equal(translateFor('zh-CN','偏好设置'),'偏好设置');
  assert.equal(translateFor('zh-TW','偏好设置'),'偏好設定');
  assert.equal(translateFor('en','偏好设置'),'Preferences');
  assert.equal(translateFor('en','{count} 个模型',{count:3}),'3 models');
  assert.equal(translateFor('zh-TW','纯色'),'純色');
  assert.equal(translateFor('zh-TW','渐变'),'漸層');
  assert.equal(translateFor('en','纯色'),'Solid');
  assert.equal(translateFor('en','渐变'),'Gradient');
  assert.equal(translateFor('zh-TW','正在回应'),'正在回應');
  assert.equal(translateFor('en','正在回应'),'Responding');
  assert.equal(translateFor('en','正在审核本次操作的范围，审核结束后会更新状态。'),'Reviewing the scope of this action; the status will update when the review is complete.');
  assert.equal(translateFor('en','查看电脑画面'),'View computer screen');
  assert.equal(translateFor('en','演示'),'Presentation');
  assert.equal(translateFor('en','更新工作环境'),'Update the work environment');
  assert.equal(translateFor('zh-TW','更新工作环境'),'更新工作環境');
  assert.equal(translateFor('zh-TW','演示'),'簡報');
  assert.equal(translateFor('en','第 {line} 行起',{line:12}),'from line 12');
  assert.equal(Object.values(translationTables.en).filter(value=>[...value].some(char=>{const code=char.codePointAt(0)||0;return code>=0x4e00&&code<=0x9fff;})).length,0);
});
