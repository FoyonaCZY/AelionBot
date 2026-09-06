import test from 'node:test';
import assert from 'node:assert/strict';
import {botMentions,mentionMarkdown,validMentions} from '../src/mentions';

const cat={id:'cat',name:'猫娘',color:'#268bfa'},coder={id:'coder',name:'代码高手',color:'#8b6bea'},newBot={id:'new',name:'New Bot',color:'#19a887'};
test('Bot replies address real members with names or exact IDs and retain UTF-16 offsets',()=>{
  const result=botMentions('🐱 @{coder} **请复核**。＠猫娘，帮忙看一下；@New Bot 请检查。',[cat,coder,newBot]);
  assert.equal(result.content,'🐱 @代码高手 **请复核**。@猫娘，帮忙看一下；@New Bot 请检查。');
  assert.deepEqual(result.mentions.map(m=>m.id),['coder','cat','new']);assert.equal(result.mentions[0].start,3);
  assert.equal(validMentions(result.content,result.mentions).length,3);
});
test('duplicate names require an ID; removed targets and self mentions cannot forge recipients',()=>{
  const duplicate={...cat,id:'cat-2',color:'#ed8c35'};
  assert.throws(()=>botMentions('@猫娘 请回复',[cat,duplicate]),/同名/);
  assert.equal(botMentions('@{cat-2} 请回复',[cat,duplicate]).mentions[0].id,'cat-2');
  assert.throws(()=>botMentions('@{missing}',[cat]),/不在当前群/);assert.throws(()=>botMentions('@{cat}',[cat],'cat'),/你自己/);
  assert.equal(botMentions('@猫娘 请回复',[cat,duplicate],undefined,false).mentions.length,0);
});
test('code, links, URLs, escaped text and email addresses never become Bot mentions',()=>{
  const member={id:'mail',name:'example',color:'#aaa'};
  const content='`@{cat}`\n\n```text\n@猫娘\n```\n[链接 @猫娘](https://example.com/@猫娘)\n<https://example.com/@猫娘>\nuser@example.com https://site.test/@猫娘 \\@猫娘\n\n**@猫娘** 请回复';
  const result=botMentions(content,[cat,member]);assert.deepEqual(result.mentions.map(m=>m.id),['cat']);assert.ok(result.content.includes('`@{cat}`'));assert.equal(result.mentions[0].start,content.lastIndexOf('@猫娘'));
});
test('prefix names are resolved exactly, without treating a longer name as a shorter member',()=>{
  const short={id:'short',name:'猫',color:'#aaa'};assert.deepEqual(botMentions('@猫娘 请回复',[short,cat]).mentions.map(m=>m.id),['cat']);assert.equal(botMentions('@猫娘的名字',[cat]).mentions.length,0);
});
test('markdown mentions retain surrounding formatting and cannot reuse user-supplied internal links',()=>{
  const result=botMentions('**@猫娘** 请看 [参考](https://example.com)。[假标签](aelion-mention:0)',[cat]);
  const rendered=mentionMarkdown(result.content,result.mentions);assert.equal(rendered.links.size,1);assert.ok(rendered.markdown.includes('**[@猫娘](aelion-mentionx:0)**'));assert.ok(rendered.markdown.includes('[参考](https://example.com)'));assert.ok(!rendered.links.has('aelion-mention:0'));
});
test('stale offsets never render an incorrect avatar or consume neighboring text',()=>{
  const text='@猫娘 请检查';const mention={...cat,start:0,end:3};assert.equal(validMentions(text,[{...mention,start:1}]).length,0);assert.equal(validMentions(text,[mention,mention]).length,1);
});
