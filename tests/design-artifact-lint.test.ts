import test from 'node:test';
import assert from 'node:assert/strict';
import {lintDesignHtml} from '../electron/core/design-artifact-lint';

test('remote fonts and filler copy block publish',()=>{
  const fonts=lintDesignHtml('<html><body><link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet"><p>Hello</p></body></html>');
  assert.ok(fonts.blocking.some(item=>/远程字体/.test(item)));
  const filler=lintDesignHtml('<html><body><p>Lorem ipsum dolor sit amet</p></body></html>');
  assert.ok(filler.blocking.some(item=>/套话/.test(item)));
});

test('token and selector issues are warnings, not blockers',()=>{
  const html=`<html><style>:root{--accent:#f00}</style><body><section><h1 style="font-family:Inter">Hi</h1></section></body></html>`;
  const lint=lintDesignHtml(html);
  assert.equal(lint.blocking.length,0);
  assert.ok(lint.warnings.some(item=>/data-design-id/.test(item)));
});
