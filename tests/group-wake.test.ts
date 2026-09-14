import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldWakeGroupBot} from '../electron/core/group-wake';
import type {GroupMessage,GroupRoom,GroupRound} from '../src/group-types';
import type {WorkItem} from '../src/work-types';

const identity=(id:string)=>({id,name:id,color:'#2288ff'});
function room(ids:string[]):GroupRoom{
  return {id:'g',name:'群',members:ids.map(id=>({...identity(id),joinedAt:'t'})),createdBy:{kind:'user',id:'user',name:'你'},createdAt:'t',updatedAt:'t',messages:[],lastReadSeq:0};
}
function round(request='做任务'):GroupRound{
  return {id:'r',groupId:'g',request,status:'active',createdAt:'t',botMessages:0,botCounts:{},decisions:0,createdGroups:0};
}
function message(extra:Partial<GroupMessage>={}):GroupMessage{
  return {id:'m',seq:1,groupId:'g',sender:{kind:'user',id:'user',name:'你'},kind:'message',content:'hi',time:'t',...extra};
}
function decide(botId:string,messages:GroupMessage[],extra:{room?:GroupRoom;round?:GroupRound;workItems?:WorkItem[];retry?:boolean}={}){
  const current=extra.room||Object.assign(room(['a','b']),{messages});
  return shouldWakeGroupBot({botId,messages,room:current,round:extra.round||round(),workItems:extra.workItems,retry:extra.retry});
}

test('unaddressed human messages still wake every Bot',()=>{
  const item=message();
  assert.equal(decide('a',[item]),true);
  assert.equal(decide('b',[item]),true);
});
test('an explicit mention wakes only that Bot',()=>{
  const item=message({content:'@a 请处理',mentions:[{...identity('a'),start:0,end:2}]});
  assert.equal(decide('a',[item]),true);
  assert.equal(decide('b',[item]),false);
});
test('another Bot speaking without a mention does not wake bystanders',()=>{
  const item=message({id:'bot',sender:{kind:'bot',...identity('a')},content:'我先做完这部分'});
  assert.equal(decide('a',[item]),false);
  assert.equal(decide('b',[item]),false);
});
test('a reply wakes the Bot being answered',()=>{
  const original=message({id:'orig',sender:{kind:'bot',...identity('a')},content:'初稿'});
  const reply=message({id:'reply',sender:{kind:'bot',...identity('c')},replyTo:'orig',content:'请按这个改'});
  const current=room(['a','b','c']);current.messages=[original,reply];
  assert.equal(decide('a',[reply],{room:current}),true);
  assert.equal(decide('b',[reply],{room:current}),false);
});
test('group creation and scheduled runs still wake everyone',()=>{
  const created=message({kind:'system',sender:{kind:'system',id:'system',name:'系统'},event:{type:'created',actor:{kind:'user',id:'user',name:'你'},joined:[identity('a'),identity('b')],left:[],members:[identity('a'),identity('b')]}});
  assert.equal(decide('a',[created]),true);
  assert.equal(decide('b',[created]),true);
  const scheduled=message({scheduled:{taskId:'s',title:'日报',scheduledFor:'t',occurrenceId:'o'}});
  assert.equal(decide('a',[scheduled]),true);
  assert.equal(decide('b',[scheduled]),true);
});
test('a member-join event wakes the joining Bot only',()=>{
  const item=message({kind:'system',sender:{kind:'system',id:'system',name:'系统'},event:{type:'members_changed',actor:{kind:'user',id:'user',name:'你'},joined:[identity('c')],left:[],members:[identity('a'),identity('b'),identity('c')]}});
  assert.equal(decide('c',[item]),true);
  assert.equal(decide('a',[item]),false);
});
test('continue, retries, and requested individual replies still wake the room',()=>{
  assert.equal(decide('b',[message({kind:'continue',content:'继续本轮讨论'})]),true);
  assert.equal(decide('b',[message({content:'@a 请处理',mentions:[{...identity('a'),start:0,end:2}]})],{retry:true}),true);
  assert.equal(decide('b',[message({content:'请分别给出意见'})],{round:round('请分别给出意见')}),true);
});
test('unfinished group work wakes on a later human message, not on unrelated Bot chatter',()=>{
  const work:WorkItem={id:'w',botId:'b',scope:{kind:'group',id:'g'},kind:'goal',objective:'写报告',status:'running',createdBy:'user',createdAt:'t',updatedAt:'t',runIds:[]};
  assert.equal(decide('b',[message({content:'@a 先看材料',mentions:[{...identity('a'),start:0,end:2}]})],{workItems:[work]}),true);
  assert.equal(decide('b',[message({id:'bot',sender:{kind:'bot',...identity('a')},content:'材料看完了'})],{workItems:[work]}),false);
});
test('a work item on the trigger message wakes the assigned Bot',()=>{
  const work:WorkItem={id:'w',botId:'a',scope:{kind:'group',id:'g'},kind:'plan',objective:'规划',status:'ready',createdBy:'user',createdAt:'t',updatedAt:'t',runIds:[]};
  const item=message({workItemId:'w',content:'@a 开始执行已确认的计划：规划',mentions:[{...identity('a'),start:0,end:2}]});
  assert.equal(decide('a',[item],{workItems:[work]}),true);
  assert.equal(decide('b',[item],{workItems:[work]}),false);
});
