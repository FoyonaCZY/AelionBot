import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import Markdown from 'react-markdown';
import {MessageCodeBlock} from '../src/MessageCodeBlock';
import {highlightMessageCode} from '../src/code-highlight';

const render=(content:string)=>renderToStaticMarkup(createElement(Markdown,{components:{pre:MessageCodeBlock}},content));

test('code fences provide a copy action while inline code stays in the sentence',()=>{
  const html=render('运行 `hello()`：\n\n```python\ndef hello():\n    return "你好"\n```');
  assert.match(html,/<p>运行 <code>hello\(\)<\/code>：<\/p>/);
  assert.match(html,/aria-label="复制 Python 代码"/);
  assert.match(html,/hljs-keyword/);
  assert.equal((html.match(/<pre /g)||[]).length,1);
  assert.doesNotMatch(html,/<pre[^>]*>\s*<div/);
});

test('code highlighting preserves indentation, Unicode and trailing newlines',()=>{
  const code='def hello():\n\treturn "你好"  \n\n';
  const highlighted=highlightMessageCode(code,'PY');
  assert.equal(highlighted.label,'Python');
  assert.equal(highlighted.html?.replace(/<[^>]*>/g,'').replace(/&quot;/g,'"'),code);
});

test('HTML in highlighted and unknown-language blocks remains inert text',()=>{
  const code='<script>alert(1)</script><img src=x onerror="alert(1)">';
  for(const language of ['html','unknown','']){
    const html=render('```'+language+'\n'+code+'\n```');
    assert.doesNotMatch(html,/<script|<img /);
    assert.match(html,/&lt;/);
    assert.match(html,/aria-label="复制 /);
  }
});

test('unfinished streamed fences render immediately without losing the partial code',()=>{
  const html=render('```ts\nconst answer = {\n  text: "正在输出');
  assert.match(html,/aria-label="复制 TypeScript 代码"/);
  assert.match(html,/正在输出/);
  assert.match(html,/hljs-keyword/);
});

test('unknown languages and large blocks retain readable plain code',()=>{
  assert.deepEqual(highlightMessageCode('hello','new-language'),{label:'new-language'});
  assert.deepEqual(highlightMessageCode('hello'),{label:'纯文本'});
  const code='print("hello")\n'.repeat(2500);
  assert.equal(highlightMessageCode(code,'python').html,undefined);
  assert.match(render('```\nfirst\n  second\n```'),/first\n  second\n<\/code>/);
});
