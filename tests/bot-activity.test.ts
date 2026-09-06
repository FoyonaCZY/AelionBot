import test from 'node:test';
import assert from 'node:assert/strict';
import {botActivities} from '../src/bot-activity';
import type {RunRecord} from '../src/shared';
import {GROUP_LIMITS} from '../src/group-types';

const run=(id:string,botId:string):RunRecord=>({id,botId,status:'running',startedAt:'2026-01-01T00:00:00Z',modelCalls:0,toolCalls:0});
const fixture=():Parameters<typeof botActivities>[0]=>({runs:[],messages:[],interactions:[]});
test('avatar follows inference, active tool execution, and completion without retaining stale tool animation',()=>{
  const state=fixture();state.runs.push(run('run-a','a'));
  assert.equal(botActivities(state).a,'thinking');
  state.messages.push({id:'tool-a',botId:'a',runId:'run-a',role:'tool',status:'running',tool:'computer',content:'',time:''});
  assert.equal(botActivities(state).a,'working');
  state.messages[0].status='done';assert.equal(botActivities(state).a,'thinking');
  state.messages[0].status='running';state.runs[0].status='completed';assert.equal(botActivities(state).a,undefined);
});
test('human permission pauses only the waiting Bot while other Bots continue their own work',()=>{
  const state=fixture();state.runs.push(run('run-a','a'),run('run-b','b'));
  for(const id of ['a','b'])state.messages.push({id:'tool-'+id,botId:id,runId:'run-'+id,role:'tool',status:'running',content:'',time:''});
  state.interactions=[{id:'permission',botId:'a',runId:'run-a',createdAt:'',kind:'host_permission',details:{operation:'command',reason:'fixture'}}];
  assert.deepEqual(botActivities(state),{a:'waiting',b:'working'});
  state.interactions=[];assert.deepEqual(botActivities(state),{a:'working',b:'working'});
  state.runs[0].status='cancelled';assert.deepEqual(botActivities(state),{b:'working'});
});
test('greetings and group decisions animate without inventing work for inactive members',()=>{
  const state=fixture();state.greetingBotIds=['a'];
  state.groups={revision:1,limits:GROUP_LIMITS,rooms:[{id:'group',name:'Team',members:[],createdBy:{kind:'user',id:'user',name:'User'},updatedAt:'',preview:'',unread:0,lastSeq:0,pending:1,activities:[{botId:'b',phase:'deciding'}]}]};
  assert.deepEqual(botActivities(state),{a:'thinking',b:'thinking'});
  state.greetingBotIds=[];state.groups.rooms[0].activities=[];assert.deepEqual(botActivities(state),{});
});
test('late streams and mismatched tool records cannot animate a completed or different Bot',()=>{
  const state=fixture();state.runs.push({...run('old','a'),status:'completed'},run('current','b'));
  state.streamingReplies=[{id:'stale',botId:'a',runId:'old',content:'late',time:'',main:true}];
  state.messages=[{id:'mismatch',botId:'a',runId:'current',role:'tool',status:'running',content:'',time:''}];
  assert.deepEqual(botActivities(state),{b:'thinking'});
});
