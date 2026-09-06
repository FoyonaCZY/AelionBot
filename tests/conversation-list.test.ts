import test from 'node:test';
import assert from 'node:assert/strict';
import type {Bot,ChatMessage,RunRecord} from '../src/shared';
import type {GroupSummary} from '../src/group-types';
import {botConversationRows,conversationRows} from '../src/conversation-list';

const bot=(id:string,createdAt='2026-09-01T00:00:00Z'):Bot=>({id,name:id,createdAt,color:'#888',role:'',memories:[]});
const message=(botId:string,time:string,extra:Partial<ChatMessage>={}):ChatMessage=>({id:`${botId}:${time}`,botId,time,role:'assistant',content:'一条消息',...extra});
const group=(id:string,updatedAt:string):GroupSummary=>({id,name:id,updatedAt,members:[],createdBy:{kind:'user',id:'user',name:'你'},preview:'群消息',unread:0,lastSeq:1,pending:0});
const keys=(rows:ReturnType<typeof conversationRows>)=>rows.map(row=>row.kind==='bot'?`bot:${row.bot.id}`:`group:${row.group.id}`);
test('latest message sorts conversations, even when history arrives out of order',()=>{
  const bots=[bot('a'),bot('b'),bot('c')],messages=[message('a','2026-09-05T10:00:00Z'),message('b','2026-09-05T11:00:00Z'),message('a','2026-09-04T23:00:00Z')];
  assert.deepEqual(botConversationRows(bots,messages).map(row=>row.bot.id),['b','a','c']);assert.equal(botConversationRows(bots,messages)[1].last?.time,'2026-09-05T10:00:00Z');
  messages.push(message('a','2026-09-05T12:00:00Z',{role:'user'}));assert.deepEqual(botConversationRows(bots,messages).map(row=>row.bot.id),['a','b','c']);assert.deepEqual(bots.map(bot=>bot.id),['a','b','c']);
});
test('tool results, empty generation placeholders and private Bot dialogue do not reorder the list',()=>{
  const run:RunRecord={id:'private',botId:'a',status:'completed',startedAt:'2026-09-05T10:00:00Z',toolCalls:0,modelCalls:1,peerOrigin:{kind:'peer_request',exchangeId:'peer'}};
  const messages=[message('a','2026-09-05T10:00:00Z'),message('b','2026-09-05T11:00:00Z'),message('a','2026-09-05T12:00:00Z',{role:'tool'}),message('a','2026-09-05T13:00:00Z',{content:''}),message('a','2026-09-05T14:00:00Z',{runId:run.id})];
  assert.equal(botConversationRows([bot('a'),bot('b')],messages,[run])[0].bot.id,'b');messages.push(message('a','2026-09-05T15:00:00Z',{runId:run.id,audience:'user'}));assert.equal(botConversationRows([bot('a'),bot('b')],messages,[run])[0].bot.id,'a');
});
test('new empty conversations use creation time; equal times keep a stable order',()=>{
  assert.deepEqual(botConversationRows([bot('a'),bot('b'),bot('new','2026-09-06T00:00:00Z')],[]).map(row=>row.bot.id),['new','a','b']);
  const messages=[message('b','2026-09-06T12:00:00Z'),message('a','2026-09-06T12:00:00Z')];assert.deepEqual(botConversationRows([bot('a'),bot('b')],messages).map(row=>row.bot.id),['a','b']);
});
test('group ordering compares actual timestamps across time zones without mutating state',()=>{
  const groups=[{id:'a',updatedAt:'2026-09-06T10:00:00Z'},{id:'b',updatedAt:'2026-09-06T18:01:00+08:00'},{id:'c',updatedAt:'2026-09-06T09:00:00Z'}] as GroupSummary[];
  assert.deepEqual(keys(conversationRows([],[],groups)),['group:b','group:a','group:c']);assert.deepEqual(groups.map(group=>group.id),['a','b','c']);
});

test('groups and direct chats share one latest-message order and move across each other on updates',()=>{
  const bots=[bot('a'),bot('b'),bot('empty')],messages=[message('a','2026-09-06T10:00:00Z'),message('b','2026-09-06T12:00:00Z')];
  const groups=[group('a','2026-09-06T11:00:00Z'),group('b','2026-09-06T09:00:00Z')];
  assert.deepEqual(keys(conversationRows(bots,messages,groups)),['bot:b','group:a','bot:a','group:b','bot:empty']);
  messages.push(message('a','2026-09-06T13:00:00Z',{role:'user'}));
  assert.deepEqual(keys(conversationRows(bots,messages,groups)),['bot:a','bot:b','group:a','group:b','bot:empty']);
  groups[1].updatedAt='2026-09-06T14:00:00Z';
  assert.deepEqual(keys(conversationRows(bots,messages,groups)),['group:b','bot:a','bot:b','group:a','bot:empty']);
  assert.deepEqual(bots.map(bot=>bot.id),['a','b','empty']);assert.deepEqual(groups.map(group=>group.id),['a','b']);
});

test('mixed ordering preserves private-message filtering and ignores reaction-only activity',()=>{
  const run:RunRecord={id:'private',botId:'a',status:'completed',startedAt:'2026-09-06T12:00:00Z',toolCalls:0,modelCalls:1,peerOrigin:{kind:'peer_request',exchangeId:'peer'}};
  const messages=[message('a','2026-09-06T10:00:00Z'),message('a','2026-09-06T12:00:00Z',{runId:run.id}),message('a','2026-09-06T13:00:00Z',{role:'tool'}),message('a','2026-09-06T14:00:00Z',{content:''})];
  messages.push(message('a','2026-09-06T15:00:00Z',{reaction:{messageId:messages[0].id,emoji:'👍',removed:false}}));
  assert.deepEqual(keys(conversationRows([bot('a')],messages,[group('g','2026-09-06T11:00:00Z')],[run])),['group:g','bot:a']);
});

test('mixed rows use creation time for empty chats and stable ordering for equal instants',()=>{
  const bots=[bot('a'),bot('b'),bot('new','2026-09-06T13:00:00Z')];
  const messages=[message('b','2026-09-06T12:00:00Z'),message('a','2026-09-06T12:00:00Z')];
  const groups=[group('g1','2026-09-06T20:00:00+08:00'),group('g2','2026-09-06T12:00:00Z')];
  assert.deepEqual(keys(conversationRows(bots,messages,groups)),['bot:new','bot:a','bot:b','group:g1','group:g2']);
});
