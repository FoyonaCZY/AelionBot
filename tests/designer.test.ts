import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Store} from '../electron/core/store';
import {updateBotProfile} from '../electron/core/bot-profile';
import {DesignSystems} from '../electron/core/design-systems';
import {DesignStore} from '../electron/core/design-store';
import {DesignerFiles} from '../electron/core/designer-files';
import {DesignerLoop} from '../electron/core/designer-loop';
import {BotRuntime} from '../electron/core/bot-runtime';
import {zipSync,strToU8} from 'fflate';
import type {ToolDefinition} from '../electron/core/model';
import type {Bot,RunRecord} from '../src/shared';

function fixture(t:any){const root=mkdtempSync(join(tmpdir(),'aelion-design-'));t.after(()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('aelion-design-'));rmSync(root,{recursive:true,force:true});});const store=new Store(join(root,'data'));const bot=store.createBot('Designer','Design',undefined,undefined,{type:'designer'});store.data.model.model='fixture';return {root,store,bot};}
function catalog(root:string,version='a'.repeat(40),color='red'){
 const dir=join(root,version);mkdirSync(join(dir,'sample'),{recursive:true});const texts={'DESIGN.md':'# Sample\nUse a restrained type scale.','tokens.css':`:root {--accent:${color};}`,'components.html':'<main>Reference</main>'};const files=Object.entries(texts).map(([path,body])=>{writeFileSync(join(dir,'sample',path),body);return {path,bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')};});
 writeFileSync(join(dir,'catalog.json'),JSON.stringify({version:1,sourceCommit:version,sourceUrl:'https://example.test',systems:[{id:'sample',name:'Sample',category:'Product',description:'Test fixture',version,bytes:files.reduce((n,f)=>n+f.bytes,0),colors:['#123456'],source:'https://example.test',license:'Apache-2.0',files}]}));return dir;
}

test('legacy Bots stay general and unconfirmed deferred switches are discarded on restart',t=>{
 const {store,bot}=fixture(t);const legacy=store.data.bots[0];delete legacy.type;(bot as any).pendingType='general';store.save();
 const loaded=new Store(store.dir);assert.equal(loaded.bot(legacy.id).type,'general');assert.equal(loaded.bot(bot.id).type,'designer');assert.equal((loaded.bot(bot.id) as any).pendingType,undefined);
 store.data.runs.push({id:randomUUID(),botId:bot.id,status:'running',startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0,engine:'designer'});
 assert.throws(()=>updateBotProfile(store,{} as any,{id:bot.id,name:bot.name,role:bot.role,type:'general',expectedType:'designer',confirmContextReset:true}),/结束/);assert.equal(store.bot(bot.id).type,'designer');
});

test('design-system references validate bytes and pinned tasks retain old assets after an application update',t=>{
 const {root,store,bot}=fixture(t),v1=catalog(root),archive=join(root,'cache'),systems=new DesignSystems(v1,archive),designs=new DesignStore(store,systems);
 const task=designs.create({botId:bot.id,kind:'prototype',brief:'Build a landing page',systemId:'sample'});assert.equal(task.systemVersion,'a'.repeat(40));assert.throws(()=>systems.read('sample','../catalog.json'));
 const v2=catalog(root,'b'.repeat(40),'blue'),updated=new DesignSystems(v2,archive);assert.match(updated.read('sample','tokens.css',task.systemVersion!).toString(),/red/);assert.match(updated.read('sample','tokens.css').toString(),/blue/);
 writeFileSync(join(v2,'sample','tokens.css'),'tampered');assert.throws(()=>updated.read('sample','tokens.css'),/资源已变化/);
});

test('task histories and lookups are isolated by Bot and channel; manual edits invalidate prior checks',t=>{
 const {root,store,bot}=fixture(t),systems=new DesignSystems(catalog(root)),designs=new DesignStore(store,systems),other=store.createBot('Other','',undefined,undefined,{type:'designer'});
 const a=designs.create({botId:bot.id,kind:'prototype',brief:'Project A'}),b=designs.create({botId:bot.id,kind:'ppt',brief:'Project B'});
 designs.history(bot.id,a.origin,a.id).history.messages.push({role:'user',content:'Private A'});assert.equal(designs.history(bot.id,b.origin,b.id).history.messages.length,0);
 assert.throws(()=>designs.get(a.id,other.id));assert.throws(()=>designs.history(bot.id,{kind:'group',id:'missing'},a.id));
 const active=designs.get(a.id);active.checks=[{id:'visual',label:'Rendered',status:'passed'}];designs.userEdit(bot.id,a.workspacePath+'/index.html','revision');assert.equal(active.checks[0].status,'pending');assert.equal(active.userEdits.length,1);
 assert.throws(()=>designs.update({id:a.id,revision:1,title:'stale'}),/已更新/);
});

test('runtime dispatch follows user-selected types and rejects resumes from another type',async t=>{
 const {store,bot}=fixture(t);const called:string[]=[],engine=(kind:string)=>({busy:false,isRunning:()=>false,streams:{snapshot:()=>[]},run:async()=>{called.push(kind);},resume:async()=>{called.push('resume-'+kind);}});
 const runtime=new BotRuntime(store,engine('general') as any,engine('designer') as any,()=>{});await runtime.run(bot.id,'Design');store.bot(bot.id).type='general';await runtime.run(bot.id,'Hello');
 const previous:RunRecord={id:randomUUID(),botId:bot.id,engine:'designer',status:'paused' as any,startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0};store.data.runs.push(previous);await assert.rejects(runtime.resume(bot.id,previous.id),/类型已改变/);assert.deepEqual(called,['designer','general']);
});

const call=(name:string,args:any)=>({id:randomUUID(),type:'function' as const,function:{name,arguments:JSON.stringify(args)}});
function loopFixture(t:any,kind:'prototype'|'ppt'|'clone'|'mobile'|'document'='prototype'){
 const f=fixture(t),{root,store,bot}=f,systems=new DesignSystems(catalog(root)),designs=new DesignStore(store,systems);const task=designs.create({botId:bot.id,kind,brief:'Create a usable design',systemId:'sample'});
 const requests:any[]=[],invocations:string[]=[];const shared={openToolSession:(_bot:string,runId:string,_options:any,allow:(name:string)=>boolean)=>({definitions:[{type:'function',function:{name:'host_file_write',description:'Write',parameters:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content'],additionalProperties:false}}},{type:'function',function:{name:'skill_read',description:'Should not load',parameters:{}}}].filter(v=>allow(v.function.name)),invoke:async(name:string,args:any)=>{invocations.push(name);if(name==='host_file_write'){const p=args.path;mkdirSync(dirname(p),{recursive:true});writeFileSync(p,args.content);}return {executionId:randomUUID(),result:{written:true}};},close:()=>{}})};
 const files=new DesignerFiles(store,designs);const vm:any={},collectRuns:string[]=[];const artifacts={read:(botId:string,path:string)=>files.read(botId,path),collect:async(botId:string,runId:string)=>{collectRuns.push(runId);const run=store.data.runs.find(r=>r.id===runId&&r.botId===botId);for(const file of await files.list(botId,run?.designSessionId))if(!store.data.artifacts.some(a=>a.botId===botId&&a.path===file.path&&a.modifiedAt===file.modifiedAt))store.data.artifacts.push({id:randomUUID(),botId,runId,...file});}};
 const context={observe:()=>{},prepare:async(input:any)=>{requests.push(structuredClone({scopeKey:input.scopeKey,history:input.history,system:input.system,prefixContext:input.prefixContext,taskFrame:input.taskFrame,tools:input.tools}));return {messages:[input.system,...(input.prefixContext||[]),...input.history],maxOutputTokens:8192,stats:{calibration:1,estimatedTokens:2000},calibrationEstimate:2000,recordUsage:()=>{}};}};
 const attachments={wire:(_bot:string,content:string)=>({content})},interactions={pendingQuestions:()=>[],permission:async()=>{}};
 return {...f,systems,designs,task,files,requests,invocations,vm,collectRuns,make:(complete:any,contextOverride:any=context,extras:any={})=>new DesignerLoop(store,designs,systems,files,{complete} as any,contextOverride as any,shared as any,artifacts as any,attachments as any,interactions as any,()=>{},extras)};
}

test('independent designer loop writes and verifies a real prototype without default skills or general history',async t=>{
 const f=loopFixture(t);f.store.data.conversations[f.bot.id]=[{role:'user',content:'UNRELATED_PRIVATE_HISTORY'}];let step=0;const path=f.task.workspacePath+'/index.html';
 const loop=f.make(async()=>{const calls=step++===0?[call('design_spec',{spec:'Neutral typography',constraints:['Keep the title readable']}),call('host_file_write',{path,content:'<!doctype html><html><body><h1>Hello</h1></body></html>'})]:step===2?[call('design_publish',{paths:[path]})]:[];return {content:calls.length?'Working':'Created the prototype; visual verification is pending.',calls,finishReason:'stop'};});
 await loop.run(f.bot.id,'Create the page',{designSessionId:f.task.id});assert.equal(f.store.data.runs.at(-1)?.status,'completed');assert.equal(f.designs.get(f.task.id).status,'review');assert.equal(f.designs.get(f.task.id).artifacts[0].path,path);assert.ok(f.invocations.includes('message_attach'));assert.ok(f.requests.every(r=>!JSON.stringify(r).includes('UNRELATED_PRIVATE_HISTORY')));assert.ok(f.requests.every(r=>!r.tools.some((t:any)=>t.function.name.startsWith('skill'))));assert.ok(f.requests.every(r=>r.scopeKey.includes(f.task.id)));
});

test('stopped designer work preserves generated files for a later preview entry',async t=>{
 const f=loopFixture(t),path=f.task.workspacePath+'/index.html';let step=0;
 await f.make(async()=>{if(step++===0)return {content:'Writing the prototype',calls:[call('host_file_write',{path,content:'<!doctype html><html><body>Saved draft</body></html>'})],finishReason:'tool_calls'};throw Error('connection stopped before delivery');}).run(f.bot.id,'Create the page',{designSessionId:f.task.id});
 const run=f.store.data.runs.at(-1)!;assert.equal(run.status,'failed');assert.ok(existsSync(f.files.absolute(f.task,path)));assert.deepEqual(f.collectRuns,[run.id]);assert.equal(f.designs.get(f.task.id).artifacts[0]?.path,path);assert.notEqual(f.designs.get(f.task.id).checks.find(c=>c.id==='format')?.status,'passed');
});

test('PPT delivery checks editable text and refuses image-only slides',async t=>{
 const f=loopFixture(t,'ppt'),path=f.task.workspacePath+'/deck.pptx';mkdirSync(dirname(f.files.absolute(f.task,path)),{recursive:true});writeFileSync(f.files.absolute(f.task,path),zipSync({'[Content_Types].xml':strToU8('<Types/>'),'ppt/slides/slide1.xml':strToU8('<p:sld><p:pic/></p:sld>')}));let step=0;
 const loop=f.make(async()=>({content:step++?'Unable to publish an editable deck':'Checking',calls:step===1?[call('design_publish',{paths:[path]})]:[],finishReason:'stop'}));await loop.run(f.bot.id,'Deliver slides',{designSessionId:f.task.id});assert.equal(f.designs.get(f.task.id).artifacts.length,0);assert.match(JSON.stringify(f.designs.history(f.bot.id,f.task.origin,f.task.id).history.messages),/可编辑文字/);
});

test('the shipped design catalog contains all 152 packages and valid hashes',()=>{
 const systems=new DesignSystems(resolve('assets/design-systems'));assert.equal(systems.list().length,152);let total=0;for(const system of systems.catalog.systems)for(const file of system.files){total+=systems.read(system.id,file.path).length;}assert.ok(total>30_000_000&&total<40_000_000);assert.ok(existsSync(resolve('assets/design-systems/LICENSE')));assert.ok(existsSync(resolve('assets/design-systems/NOTICE')));
});
import {spawnSync} from 'node:child_process';

import {recordDelegationReceipt} from '../electron/core/delegation';

test('selected references materialize locally without a full-library copy',async t=>{
 const f=loopFixture(t);let step=0;await f.make(async()=>({content:'Reference prepared',calls:step++===0?[call('design_resource',{action:'materialize'})]:[],finishReason:'stop'})).run(f.bot.id,'Prepare the selected reference',{designSessionId:f.task.id});
 assert.equal(f.store.data.runs.at(-1)?.status,'completed');assert.match(readFileSync(join(f.task.workspaceDir!,'.design-system',f.task.systemVersion!,'sample','tokens.css'),'utf8'),/red/);
});

test('a bound task without a design system does not fail the run when resource or start is misused',async t=>{
 const f=loopFixture(t);f.designs.setSystem(f.designs.get(f.task.id),null);let step=0;
 await f.make(async()=>{
  if(step++===0)return {content:'Trying the package',calls:[call('design_resource',{action:'materialize'}),call('design_start',{kind:'prototype',title:'Retry',brief:'Need a system',systemId:'sample'})],finishReason:'tool_calls'};
  return {content:'Continuing with the attached system.',calls:[],finishReason:'stop'};
 }).run(f.bot.id,'Design a site',{designSessionId:f.task.id});
 assert.equal(f.store.data.runs.at(-1)?.status,'completed');assert.equal(f.designs.get(f.task.id).systemId,'sample');
 const history=JSON.stringify(f.designs.history(f.bot.id,f.task.origin,f.task.id).history.messages);
 assert.match(history,/selected\\":false/);assert.match(history,/attached\\":true/);
});

test('design_system can attach a package while the current run is bound',async t=>{
 const f=loopFixture(t);f.designs.setSystem(f.designs.get(f.task.id),null);let step=0;
 await f.make(async()=>({content:step++?'Ready':'Attach',calls:step===1?[call('design_system',{systemId:'sample'})]:[],finishReason:'stop'})).run(f.bot.id,'Use a system',{designSessionId:f.task.id});
 assert.equal(f.store.data.runs.at(-1)?.status,'completed');assert.equal(f.designs.get(f.task.id).systemId,'sample');
});

test('real editable PowerPoint output can be published and survives reopening',async t=>{
 const python=process.env.AELION_TEST_PYTHON;if(!python){t.skip('Set AELION_TEST_PYTHON to create and reopen a real PPTX');return;}
 const f=loopFixture(t,'ppt'),path=f.task.workspacePath+'/deck.pptx';mkdirSync(dirname(f.files.absolute(f.task,path)),{recursive:true});
 const generated=spawnSync(python,['-c',"from pptx import Presentation\nfrom pptx.util import Inches\nimport sys\np=Presentation();p.slide_width=Inches(13.333);p.slide_height=Inches(7.5)\ns=p.slides.add_slide(p.slide_layouts[6]);s.shapes.add_textbox(Inches(1),Inches(1),Inches(10),Inches(2)).text_frame.text='Editable designer output'\np.save(sys.argv[1])\nr=Presentation(sys.argv[1]);assert r.slides[0].shapes[0].text=='Editable designer output'",f.files.absolute(f.task,path)],{encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);
 let step=0;await f.make(async()=>({content:step++?'The editable deck is ready for review.':'Verifying',calls:step===1?[call('design_publish',{paths:[path]})]:[],finishReason:'stop'})).run(f.bot.id,'Deliver a deck',{designSessionId:f.task.id});assert.equal(f.designs.get(f.task.id).artifacts[0]?.kind,'pptx');assert.equal(f.designs.get(f.task.id).status,'review');
});

test('group design context includes only that group and task, never main-chat or another-group history',async t=>{
 const f=loopFixture(t),other=f.store.createBot('Other',''),gid=randomUUID(),rootId=randomUUID(),deliveryId=randomUUID(),time=new Date().toISOString();
 f.store.data.conversations[f.bot.id]=[{role:'user',content:'MAIN_CHAT_SECRET'}];
 f.store.data.groups.push({id:gid,name:'Design room',members:[{id:f.bot.id,name:f.bot.name,color:f.bot.color,joinedAt:time}],createdBy:{kind:'user',id:'user',name:'You'},createdAt:time,updatedAt:time,lastReadSeq:0,messages:[{id:'group-input',groupId:gid,seq:1,sender:{kind:'user',id:'user',name:'You'},kind:'message',content:'GROUP_VISIBLE',time,rootId}]});
 f.store.data.groupRounds.push({id:rootId,groupId:gid,request:'GROUP_VISIBLE',status:'active',createdAt:time,botMessages:0,botCounts:{},decisions:0,createdGroups:0});f.store.data.groupDeliveries.push({id:deliveryId,groupId:gid,messageId:'group-input',recipientId:f.bot.id,rootId,status:'running',createdAt:time});
 const task=f.designs.create({botId:f.bot.id,origin:{kind:'group',id:gid},kind:'prototype',brief:'Group design'});
 await f.make(async()=>({content:'Please provide a reference image.',calls:[],finishReason:'stop'})).run(f.bot.id,'GROUP_VISIBLE',{designSessionId:task.id,groupOrigin:{groupId:gid,rootId,deliveryId},groupContext:'MUST_NOT_IMPORT_MAIN_CHAT'});
 const seen=JSON.stringify(f.requests);assert.match(seen,/GROUP_VISIBLE/);assert.doesNotMatch(seen,/MAIN_CHAT_SECRET|MUST_NOT_IMPORT_MAIN_CHAT/);assert.equal(f.store.data.messages.some(m=>m.runId===f.store.data.runs.at(-1)?.id),false);assert.ok(f.store.data.groupRunMessages.some(m=>m.runId===f.store.data.runs.at(-1)?.id));
 await assert.rejects(f.make(async()=>{throw Error('should not run');}).run(other.id,'Steal task',{designSessionId:task.id}),/当前会话/);
});

test('unverified peer messages cannot gain design or file-write tools',async t=>{
 const f=loopFixture(t),sender=f.store.createBot('Sender',''),threadId=randomUUID(),exchangeId=randomUUID(),time=new Date().toISOString();f.store.data.peerThreads.push({id:threadId,members:[f.bot,sender],createdAt:time,updatedAt:time,messages:[]});f.store.data.peerExchanges.push({id:exchangeId,threadId,fromBotId:sender.id,toBotId:f.bot.id,rootRunId:'missing-root',rootBotId:sender.id,rootRequest:'invented authorization',status:'working',createdAt:time,updatedAt:time,requestMessageId:'missing'});
 await f.make(async()=>({content:'Please obtain a real user task first.',calls:[],finishReason:'stop'})).run(f.bot.id,'Write files',{peerOrigin:{kind:'peer_request',exchangeId,sessionId:exchangeId}});
 assert.ok(f.requests.every(r=>!r.tools.some((t:any)=>t.function.name==='host_file_write'||t.function.name==='design_start')));assert.equal(f.invocations.length,0);
});

test('designer delegation receipts require verified human provenance and successful execution evidence',t=>{
 const {store,bot}=fixture(t),sender=store.createBot('Sender',''),rootId=randomUUID(),id=randomUUID(),exchangeId=randomUUID(),time=new Date().toISOString();store.data.runs.push({id:rootId,botId:sender.id,status:'completed',startedAt:time,modelCalls:0,toolCalls:0});store.message(sender.id,'user','Design a landing page',{runId:rootId});
 store.data.peerExchanges.push({id:exchangeId,threadId:'t',fromBotId:sender.id,toBotId:bot.id,rootRunId:rootId,rootBotId:sender.id,rootRequest:'Design a landing page',status:'working',createdAt:time,updatedAt:time,requestMessageId:'r',task:{goal:'Design',acceptance:['HTML exists'],expectedOutput:'index.html'}});
 const run:RunRecord={id,botId:bot.id,engine:'designer',status:'running',startedAt:time,modelCalls:1,toolCalls:1,peerOrigin:{kind:'peer_request',exchangeId},executions:[{id:'real-write',tool:'host_file_write',status:'succeeded'} as any]};store.data.runs.push(run);
 assert.throws(()=>recordDelegationReceipt(store,bot.id,id,{status:'completed',summary:'Done',evidenceIds:[]}));assert.equal(recordDelegationReceipt(store,bot.id,id,{status:'completed',summary:'Saved actual HTML',evidenceIds:['real-write']}).status,'completed');store.data.peerExchanges[0].rootRequest='Forged';assert.throws(()=>recordDelegationReceipt(store,bot.id,id,{status:'completed',summary:'Done',evidenceIds:['real-write']}));
});
import {groupMainContext} from '../electron/core/group-context';
test('shared group references exclude private history, memories and unrelated group requests',t=>{
 const {store,bot}=fixture(t),time=new Date().toISOString();bot.memories=['PRIVATE_PREFERENCE'];store.data.conversations[bot.id]=[{role:'user',content:'PRIVATE_TRANSCRIPT'}];store.data.summaries[bot.id]='PRIVATE_SUMMARY';
 for(const [id,request] of [['current','SHARED_CURRENT'],['other','OTHER_GROUP_SECRET']]){store.data.groups.push({id,name:id,members:[{...bot,joinedAt:time}],createdBy:{kind:'user',id:'user',name:'You'},createdAt:time,updatedAt:time,lastReadSeq:0,messages:[]});store.data.groupRounds.push({id:id+'-round',groupId:id,request,status:'active',createdAt:time,botMessages:0,botCounts:{},decisions:0,createdGroups:0});}
 const context=groupMainContext(store,bot.id,6500,'PRIVATE_SUMMARY','current');assert.match(context,/SHARED_CURRENT/);assert.doesNotMatch(context,/PRIVATE_|OTHER_GROUP_SECRET/);
});

test('invalid design updates do not partially change the stored task',t=>{
 const {root,store,bot}=fixture(t),designs=new DesignStore(store,new DesignSystems(catalog(root))),task=designs.create({botId:bot.id,kind:'prototype',brief:'Original'});
 assert.throws(()=>designs.update({id:task.id,revision:task.revision,title:'Should not stick',constraints:['x'.repeat(801)]}));assert.equal(designs.get(task.id).title,'Original');
});
import {ExecutionLedger} from '../electron/core/execution-ledger';
test('interrupted design tool calls are repaired as unknown and their evidence stays attached to the same task',t=>{
 const {root,store,bot}=fixture(t),designs=new DesignStore(store,new DesignSystems(catalog(root))),task=designs.create({botId:bot.id,kind:'prototype',brief:'Resume safely'});
 designs.history(bot.id,task.origin,task.id).history.messages.push({role:'assistant',content:null,tool_calls:[call('host_file_write',{path:task.workspacePath+'/index.html',content:'partial'})]});
 const restored=designs.history(bot.id,task.origin,task.id).history.messages;assert.equal(restored.at(-1)?.role,'tool');assert.match(restored.at(-1)?.content||'',/unknown/);
 const prior:RunRecord={id:randomUUID(),botId:bot.id,designSessionId:task.id,engine:'designer',status:'interrupted',startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0};store.data.runs.push(prior);const ledger=new ExecutionLedger(store),entry=ledger.begin(bot.id,prior.id,call('host_file_write',{}),{path:task.workspacePath+'/index.html'});ledger.finish(entry,'unknown',{error:'connection interrupted'},'result');
 const next:RunRecord={...prior,id:randomUUID(),status:'running',executions:[]};store.data.runs.push(next);assert.ok(ledger.failureMap(bot.id,next.id).has(entry.id));const unrelated:RunRecord={...next,id:randomUUID(),designSessionId:randomUUID()};store.data.runs.push(unrelated);assert.equal(ledger.failureMap(bot.id,unrelated.id).size,0);
});


test('designer completes host files while the VM is stopped and exposes no computer tools',async t=>{
 const f=loopFixture(t);f.vm.state={status:'stopped'};let step=0;const path='index.html';
 await f.make(async()=>({content:'Ready',calls:step++===0?[call('host_file_write',{path,content:'<html><body>Local</body></html>'})]:step===2?[call('design_publish',{paths:[path]})]:[],finishReason:'stop'})).run(f.bot.id,'Build a page',{designSessionId:f.task.id});
 assert.equal(f.store.data.runs.at(-1)?.status,'completed');assert.equal(readFileSync(f.files.absolute(f.task,path),'utf8'),'<html><body>Local</body></html>');assert.equal(f.store.data.runs.at(-1)?.workspaceDir,f.task.workspaceDir);assert.ok(f.requests.every(r=>!r.tools.some((t:any)=>['computer','computer_execute','python_execute','file_write','terminal_start'].includes(t.function.name))));
});
test('designer supplies a stream reset for safe retry after partial model output',async t=>{
 const f=loopFixture(t);let loop:DesignerLoop;
 loop=f.make(async(_messages:any,_tools:any,_signal:any,onText:any,options:any)=>{onText('partial discarded text');assert.equal(loop.streams.snapshot()[0]?.content,'partial discarded text');assert.equal(typeof options.onReset,'function');options.onReset();assert.equal(loop.streams.snapshot().length,0);onText('Complete response');return {content:'Complete response',calls:[],finishReason:'stop'};});
 await loop.run(f.bot.id,'Discuss design',{designSessionId:f.task.id});assert.equal(f.store.data.runs.at(-1)?.status,'completed');assert.equal(f.store.data.messages.filter(m=>m.role==='assistant').at(-1)?.content,'Complete response');assert.equal(loop.streams.snapshot().length,0);
});
test('exhausted model timeout produces one failure message, not an additional event',async t=>{
 const f=loopFixture(t);await f.make(async()=>{throw new DOMException('The operation was aborted due to timeout','TimeoutError');}).run(f.bot.id,'Design',{designSessionId:f.task.id});
 assert.equal(f.store.data.runs.at(-1)?.status,'failed');assert.equal(f.store.data.messages.filter(m=>m.presentation==='error').length,1);assert.equal(f.store.data.messages.filter(m=>m.role==='event').length,0);
});

test('design-system selection is task scoped while another task of the same Bot runs',t=>{
 const {root,store,bot}=fixture(t),systems=new DesignSystems(catalog(root)),designs=new DesignStore(store,systems);
 const a=designs.create({botId:bot.id,kind:'prototype',brief:'Running task',systemId:'sample'}),b=designs.create({botId:bot.id,kind:'ppt',brief:'New task'});
 designs.get(a.id).activeRunId='active-a';designs.get(a.id).status='running';designs.save();
 assert.throws(()=>designs.update({id:a.id,revision:a.revision,systemId:null}),/停止/);
 assert.equal(designs.setSystem(designs.get(a.id),'sample').systemId,'sample');
 const updated=designs.update({id:b.id,revision:b.revision,systemId:'sample'});assert.equal(updated.systemId,'sample');
 const cleared=designs.update({id:b.id,revision:updated.revision,systemId:null});assert.equal(cleared.systemId,null);assert.equal(designs.get(a.id).systemId,'sample');assert.equal(designs.get(a.id).activeRunId,'active-a');
});

import {CognitiveStore} from '../electron/core/cognitive-store';
import {ContextEngine} from '../electron/core/context-engine';
test('designer task revisions preserve request prefixes and reuse pinned reference context',async t=>{
 const f=loopFixture(t),storage=new CognitiveStore(f.store),engine=new ContextEngine(storage,{complete:async()=>{throw Error('Unexpected compaction');}} as any,()=>{}),requests:any[]=[],prepare=engine.prepare.bind(engine);try{
 engine.prepare=async input=>{const result=await prepare(input);requests.push(structuredClone(result.messages));return result;};
 let reads=0;const context=f.systems.context.bind(f.systems);f.systems.context=(...args)=>{reads++;return context(...args);};let step=0;const path=f.task.workspacePath+'/index.html';
 await f.make(async(_messages:any,_tools:any,_signal:any,_text:any,options:any)=>{assert.ok(options.contextStats?.estimatedTokens>0);const calls=step++===0?[call('design_spec',{spec:'New direction after first inference',constraints:[]})]:step===2?[call('host_file_write',{path,content:'<html><body>Ready</body></html>'})]:step===3?[call('design_publish',{paths:[path]})]:[];return {content:calls.length?'Working':'Ready for review',calls,finishReason:calls.length?'tool_calls':'stop'};},engine).run(f.bot.id,'Build a page',{designSessionId:f.task.id});
 assert.equal(f.store.data.runs.at(-1)?.status,'completed');assert.equal(requests.length,4);assert.equal(reads,1);
 for(let i=1;i<requests.length;i++)assert.deepEqual(requests[i].slice(0,requests[i-1].length),requests[i-1],'progress changes must append context, not rewrite the request prefix');
 assert.doesNotMatch(requests[0][0].content,/activeRunId|updatedAt|New direction/);assert.match(JSON.stringify(requests.at(-1)),/New direction/);
}finally{storage.close();}
});
test('first designer text reaches the shared stream and updates request state before completion',async t=>{
 const f=loopFixture(t);let loop:DesignerLoop;
 loop=f.make(async(_messages:any,_tools:any,_signal:any,onText:any,options:any)=>{options.onStatus({phase:'waiting',startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),attempt:0,maxRetries:2});onText('Visible first words');assert.equal(f.store.data.runs.at(-1)?.modelRequest?.phase,'streaming');assert.equal(loop.streams.snapshot()[0]?.content,'Visible first words');assert.equal(f.store.data.runs.at(-1)?.status,'running');return {content:'Visible first words and final answer',calls:[],finishReason:'stop'};});
 await loop.run(f.bot.id,'Explain the visual direction',{designSessionId:f.task.id});assert.equal(f.store.data.runs.at(-1)?.status,'completed');assert.equal(loop.streams.snapshot().length,0);
});

 test('native deck generation publishes local files with execution-backed receipts',async t=>{
 const f=loopFixture(t,'ppt');let step=0;await f.make(async()=>({content:'Editable deck ready',calls:step++===0?[call('design_deck',{title:'Local design',path:'deck',slides:[{title:'A clear idea',body:'A useful first draft',layout:'statement'}]})]:step===2?[call('design_publish',{paths:['deck.pptx','deck.html']})]:[],finishReason:'stop'})).run(f.bot.id,'Create slides',{designSessionId:f.task.id});
 const run=f.store.data.runs.at(-1)!;assert.equal(run.status,'completed');assert.ok(run.executions?.some(e=>e.tool==='design_deck'&&e.status==='succeeded'));assert.ok(run.executions?.some(e=>e.tool==='design_publish'&&e.status==='succeeded'));assert.equal(f.designs.get(f.task.id).artifacts.length,2);assert.ok(existsSync(join(f.task.workspaceDir!,'deck.html')));
});
test('clone tasks inject the clone playbook and refuse publish without a source URL',async t=>{
 const f=loopFixture(t,'clone'),path=f.task.workspacePath+'/index.html';
 mkdirSync(dirname(f.files.absolute(f.task,path)),{recursive:true});
 writeFileSync(f.files.absolute(f.task,path),'<!doctype html><html><body><main>Replica</main></body></html>');
 let step=0;await f.make(async()=>({content:step++?'Cannot publish yet':'Checking',calls:step===1?[call('design_publish',{paths:[path]})]:[],finishReason:'stop'})).run(f.bot.id,'Clone the site',{designSessionId:f.task.id});
 assert.match(JSON.stringify(f.requests[0].prefixContext),/CLONE WORKFLOW/);
 assert.match(JSON.stringify(f.designs.history(f.bot.id,f.task.origin,f.task.id).history.messages),/NOTES\.md/);
 assert.notEqual(f.designs.get(f.task.id).checks.find(c=>c.id==='format')?.status,'passed');
 writeFileSync(f.files.absolute(f.task,'NOTES.md'),'# Notes\nSource: https://example.test/observed\nDo not clone login or payment.\n');
 step=0;await f.make(async()=>({content:step++?'Replica ready':'Publishing',calls:step===1?[call('design_publish',{paths:[path]})]:[],finishReason:'stop'})).run(f.bot.id,'Deliver the replica',{designSessionId:f.task.id});
 assert.equal(f.store.data.runs.at(-1)?.status,'completed');
 assert.equal(f.designs.get(f.task.id).artifacts[0]?.kind,'html');
 assert.ok(f.designs.get(f.task.id).artifacts.some(a=>a.name==='NOTES.md'));
 assert.equal(f.designs.get(f.task.id).checks.find(c=>c.id==='format')?.status,'passed');
});
