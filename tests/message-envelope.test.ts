import test from 'node:test';
import assert from 'node:assert/strict';
import {groupReplyContent} from '../src/message-envelope';
const envelope=(content:string)=>JSON.stringify({messageId:'message-1',seq:11,sender:{kind:'bot',bot:{id:'a',name:'伙伴'}},kind:'message',content,mentions:[],mentioned:false});
test('an echoed own group history item becomes its body with real newlines',()=>{
  const text='收到需求。\n\n| 项目 | 内容 |\n| --- | --- |\n| 结果 | 已核对 |';assert.equal(groupReplyContent(envelope(text),'a'),text);assert.equal(groupReplyContent(envelope(envelope(text)),'a'),text);
});
test('ordinary JSON, code examples, incomplete envelopes and other speakers are preserved',()=>{
  for(const text of ['{"content":"JSON 文档","messageId":"example"}',envelope('来自其他成员'),'```json\n'+envelope('代码示例')+'\n```',envelope('incomplete').slice(0,-1)])assert.equal(groupReplyContent(text,'b'),text);
  assert.equal(groupReplyContent('```json\n'+envelope('代码示例')+'\n```','a'),'```json\n'+envelope('代码示例')+'\n```');
});
