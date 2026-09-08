import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationTimeline,describeTool,friendlyError,readableContent,runPresentation,technicalOutput,liveBotStep} from '../src/activity';
import type {ChatMessage,RunRecord} from '../src/shared';
const message=(id:string,role:ChatMessage['role'],content='',extra:Partial<ChatMessage>={}):ChatMessage=>({id,botId:'bot',role,content,time:'2026-09-05T10:00:00Z',runId:'run',status:'done',...extra});
const run=(status:RunRecord['status']):RunRecord=>({id:'run',botId:'bot',status,startedAt:'2026-09-05T10:00:00Z',modelCalls:2,toolCalls:2});

test('live status follows the current step and vanishes for every terminal state',()=>{
  const read=message('read','tool','private command',{tool:'file_read',status:'running',activity:{label:'读取文件',detail:'提纲.md'}});
  assert.deepEqual(liveBotStep([read],run('running')),{phase:'working',label:'正在读取文件',detail:'提纲.md'});
  const write=message('write','tool','private payload',{tool:'file_write',status:'running',activity:{label:'保存文件',detail:'报告.md'}});
  assert.equal(liveBotStep([{...read,status:'done'},write],run('running'))?.label,'正在保存文件');
  for(const status of ['completed','failed','cancelled','interrupted'] as const)assert.equal(liveBotStep([read],run(status)),undefined);
  assert.doesNotMatch(JSON.stringify(liveBotStep([read],run('running'))),/private command/);
});
test('permission waiting takes precedence and another run cannot supply a stale step',()=>{
  const tool=message('read','tool','{}',{tool:'file_read',status:'running',runId:'older-run'});
  assert.equal(liveBotStep([tool],run('running'))?.phase,'thinking');
  assert.deepEqual(liveBotStep([tool],run('running'),'host_permission'),{phase:'waiting',label:'等待你的操作许可'});
  assert.deepEqual(liveBotStep([tool],run('running'),'host_permission',true),{phase:'thinking',label:'正在确认操作权限'});
});

test('completed progress stays between chronological tool segments and the final answer',()=>{
  const messages=[message('user','user','生成报告'),message('plan','assistant','先读取资料'),message('read','tool','{}',{tool:'file_read'}),message('empty','assistant',''),message('write','tool','{}',{tool:'file_write'}),message('final','assistant','报告已完成')];
  const timeline=conversationTimeline(messages);assert.equal(timeline.length,3);assert.equal(timeline[0].kind,'message');assert.equal(timeline[1].kind,'message');assert.equal(timeline[1].id,'plan');assert.equal(timeline[2].kind,'run');
  const view=runPresentation(messages.slice(1),run('completed'));assert.equal(view.final?.id,'final');assert.deepEqual(view.tools.map(item=>item.id),['read','write']);assert.deepEqual(view.notes.map(item=>item.id),['plan']);
});

test('private-chat notices stay clickable between stable run segments without duplicating content',()=>{
  const messages=[message('user','user','请联络'),message('send','tool','{}',{tool:'bot_send_message'}),message('notice','event','已发送给 B',{runId:undefined,peer:{exchangeId:'exchange',direction:'sent'}}),message('final','assistant','等对方回复。',{presentation:'answer'})];
  const timeline=conversationTimeline(messages),runs=timeline.filter(item=>item.kind==='run');assert.equal(runs.length,2);assert.equal(runs[1].messages.at(-1)?.id,'final');assert.deepEqual(runs.map(item=>[item.segmentId,item.isLast]),[['send',false],['final',true]]);assert.ok(timeline.some(item=>item.kind==='message'&&item.message.peer?.exchangeId==='exchange'));assert.deepEqual(timeline.flatMap(item=>item.kind==='message'?[item.message.id]:item.messages.map(message=>message.id)),messages.map(message=>message.id));
});

test('every committed progress message survives new steps, completion and serialization in its original position',()=>{
  const messages=[message('user','user','处理资料'),message('plan','assistant','先核对资料',{presentation:'progress'}),message('read','tool','{}',{tool:'file_read'}),message('update','assistant','资料已核对，开始生成报告',{presentation:'progress',audience:'user'}),message('write','tool','{}',{tool:'file_write'})];
  const first=conversationTimeline(messages);assert.deepEqual(first.map(item=>item.kind==='message'?item.id:item.segmentId),['user','plan','read','update','write']);
  messages.push(message('check','assistant','报告已生成，正在验证',{presentation:'progress'}),message('verify','tool','{}',{tool:'python_execute'}),message('final','assistant','完成',{presentation:'answer'}));
  const serialized=JSON.parse(JSON.stringify(messages)),timeline=conversationTimeline(serialized);assert.deepEqual(timeline.map(item=>item.kind==='message'?item.id:item.segmentId),['user','plan','read','update','write','check','verify']);
  assert.equal(timeline.filter(item=>item.kind==='run'&&item.isLast).length,1);assert.equal(timeline.flatMap(item=>item.kind==='message'?[item.message]:item.messages).filter(message=>message.id==='final').length,1);assert.deepEqual(messages,serialized);
});

test('cancelled and unfinished drafts never become permanent progress',()=>{
  const timeline=conversationTimeline([message('partial','assistant','未完成的草稿',{status:'running',presentation:'progress'}),message('cancelled','assistant','过期草稿',{status:'cancelled',presentation:'progress'}),message('thinking','assistant','<think>隐藏思考</think>',{presentation:'progress'}),message('correction','assistant','发现问题，正在修正',{status:'failed',presentation:'progress'})]);
  assert.deepEqual(timeline.filter(item=>item.kind==='message').map(item=>item.id),['correction']);
});
test('failed and cancelled runs never present a partial reply as a completed answer',()=>{
  const partial=message('partial','assistant','已经完成一半',{status:'failed'});
  for(const status of ['failed','cancelled','interrupted','running'] as const)assert.equal(runPresentation([partial],run(status)).final,undefined);
  const recovered=runPresentation([message('failure','assistant','发现校验问题',{status:'failed',presentation:'progress'}),message('fixed','assistant','重新核对通过',{presentation:'answer'})],run('completed'));
  assert.equal(recovered.final?.id,'fixed');assert.equal(recovered.notes.length,1);
});
test('error notices classify failures without copying HTTP bodies, paths or secrets into the main chat',()=>{
  const notice=friendlyError('模型请求失败 HTTP 503: {"error":"private provider response token=secret"}');
  assert.equal(notice.title,'模型服务暂时不可用');assert.doesNotMatch(JSON.stringify(notice),/HTTP|private|secret/);
  assert.equal(friendlyError('HTTP 401').settings,'model');assert.equal(friendlyError('工作电脑未就绪').settings,'computer');assert.equal(friendlyError('此 MCP 尚未启用').settings,'mcp');
});
test('display metadata excludes commands and input values, and technical details remain available',()=>{
  assert.deepEqual(describeTool('python_execute',{code:'print("private-value")'}),{label:'运行代码'});
  assert.deepEqual(describeTool('file_write',{path:'/work/private-bot/reports/report.csv',content:'private-value'}),{label:'保存文件',detail:'report.csv'});
  assert.deepEqual(describeTool('computer',{action:'type',text:'private-value'}),{label:'输入文字'});
  const raw=message('tool','tool',JSON.stringify({resultId:'internal-id',result:{stdout:'3 tests passed',stderr:'',exitCode:0}}));
  assert.equal(technicalOutput(raw),'3 tests passed\n\n退出码 0');assert.doesNotMatch(technicalOutput(raw),/internal-id/);
});
test('tagged reasoning is omitted from answers without changing the stored message',()=>{
  const text='<think>internal reasoning</think>\n已完成';assert.equal(readableContent(text),'已完成');assert.equal(readableContent('<think>still thinking'),'');assert.equal(readableContent('</think>已完成'),'已完成');assert.match(text,/internal reasoning/);
});
