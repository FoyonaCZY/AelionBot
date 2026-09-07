import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {externalWebUrl} from '../src/external-links';
import {MessageLink} from '../src/MessageLink';

test('web links preserve queries and fragments and normalize browser addresses',()=>{
  assert.equal(externalWebUrl('https://aelion.chat/blog?tag=agent&sort=new#article'),'https://aelion.chat/blog?tag=agent&sort=new#article');
  assert.equal(externalWebUrl(' HTTP://LOCALHOST:5191/docs '),'http://localhost:5191/docs');
  assert.equal(externalWebUrl('//aelion.chat/blog'),'https://aelion.chat/blog');
  assert.equal(externalWebUrl('https://例子.测试/文章'),'https://xn--fsqu00a.xn--0zwm56d/%E6%96%87%E7%AB%A0');
});

test('external browser entry rejects local files, executable protocols and relative paths',()=>{
  for(const value of ['javascript:alert(1)','data:text/html,<h1>hello</h1>','file:///C:/Windows/notepad.exe','C:\\Windows\\notepad.exe','\\\\server\\share','ms-settings:','vscode://file/C:/app','mailto:hi@example.com','ftp://example.com','aelion-mention:0','/docs','docs','#footnote','https://','https://[invalid]','https://example.com:99999',null,{},42]){
    assert.equal(externalWebUrl(value),undefined,String(value));
  }
});

test('external browser entry rejects credentials and control characters before URL parsing',()=>{
  for(const value of ['https://user:secret@example.com','https://trusted.example@other.example','https://example.com\n/path','https://exa\tmple.com','\u0000https://example.com','https://example.com\u007f']){
    assert.equal(externalWebUrl(value),undefined,JSON.stringify(value));
  }
});

const render=(content:string)=>renderToStaticMarkup(createElement(Markdown,{remarkPlugins:[remarkGfm],components:{a:MessageLink}},content));

test('Markdown, GFM bare addresses and table links use browser anchors',()=>{
  const html=render('[官网](https://aelion.chat) 和 www.example.com\n\n| 文档 |\n| --- |\n| [参考](https://example.com/docs?q=one&lang=zh#intro) |');
  assert.equal((html.match(/target="_blank"/g)||[]).length,3);
  assert.equal((html.match(/rel="noopener noreferrer"/g)||[]).length,3);
  assert.match(html,/<a href="https:\/\/aelion.chat\/"/);
  assert.match(html,/href="http:\/\/www.example.com\/"/);
  assert.match(html,/href="https:\/\/example.com\/docs\?q=one&amp;lang=zh#intro"/);
});

test('unsafe and unsupported Markdown destinations render as text',()=>{
  for(const destination of ['javascript:alert%281%29','file:///C:/test.txt','data:text/html,hello','aelion-mention:0','/docs']){
    const html=render(`[文字](${destination})`);
    assert.equal(html,'<p>文字</p>',destination);
  }
});

test('footnote links and backlinks stay in the document',()=>{
  const html=render('带脚注的消息[^1]\n\n[^1]: 内容');
  assert.match(html,/href="#user-content-fn-1"/);
  assert.match(html,/href="#user-content-fnref-1"/);
  assert.doesNotMatch(html,/target="_blank"/);
});
