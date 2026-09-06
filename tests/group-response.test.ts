import test from 'node:test';
import assert from 'node:assert/strict';
import {repeatedGroupResponse,individualGroupResponses,groupAcknowledgment} from '../electron/core/group-response';
import type {GroupRoom} from '../src/group-types';
import {groupParaphrases} from './fixtures/group-paraphrases';

function room(content=groupParaphrases[0]):GroupRoom{return {id:'group',name:'test',members:[],createdBy:{kind:'user',id:'user',name:'你'},createdAt:'',updatedAt:'',lastReadSeq:0,messages:[{id:'first',groupId:'group',seq:1,kind:'message',rootId:'round',sender:{kind:'bot',id:'first-bot',name:'甲',color:'#888'},content,time:''}]};}

test('five reworded or shorter explanations of the reported attachment add no information to the first answer',()=>{
  for(const response of groupParaphrases.slice(1))assert.equal(repeatedGroupResponse(room(),'round',response,[]),true,response);
});

test('new facts, corrections, questions, numbers and evidence survive even when most of the explanation overlaps',()=>{
  const source=room();
  for(const addition of ['另外，动画提供键盘快捷键和屏幕阅读器支持。','但暂停按钮没有停止车轮动画，需要修复。','这个页面是否支持键盘操作？','浏览器每秒运行 60 帧。','另一个实现见 https://example.test/alternate.html','导出的文件是 `pelican-updated.html`。','动画增加了暗色主题切换。'])assert.equal(repeatedGroupResponse(source,'round',groupParaphrases[3]+addition,[]),false,addition);
  const numbered=room(groupParaphrases[3]+'动画速度是 1 倍。');assert.equal(repeatedGroupResponse(numbered,'round',groupParaphrases[3]+'动画速度是 2 倍。',[]),false);
  assert.equal(repeatedGroupResponse(source,'another-round',groupParaphrases[1],[]),false);
});

test('explicit individual responses retain each author but suppress that author repeating themselves',()=>{
  const source=room('同意');assert.ok(individualGroupResponses('请每个人分别说一下意见'));assert.ok(individualGroupResponses('大家投票'));assert.equal(individualGroupResponses('不用每个人都分别回答'),false);
  assert.equal(repeatedGroupResponse(source,'round','同意',[],'second-bot',true),false);assert.equal(repeatedGroupResponse(source,'round','同意',[],'first-bot',true),true);
  assert.equal(groupAcknowledgment('我也同意你的看法，喵～'),true);assert.equal(groupAcknowledgment('目前没有新的补充。'),true);assert.equal(groupAcknowledgment('同意，但需要增加重试上限。'),false);
});

test('a different addressee is not erased as a repeated answer',()=>{
  const source=room(groupParaphrases[1]);source.messages[0].mentions=[{id:'a',name:'甲',color:'#888',start:0,end:2}];
  assert.equal(repeatedGroupResponse(source,'round',groupParaphrases[1],[{id:'b',name:'乙',color:'#888',start:0,end:2}]),false);
});
