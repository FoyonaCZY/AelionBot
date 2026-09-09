import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../electron/core/store';
import {SkillLibrary} from '../electron/core/skill-library';
import {StateDatabase} from '../electron/core/state-database';
import {readPipeline} from '../electron/core/tool-pipeline';
import {FileCheckpoints} from '../electron/core/file-checkpoints';
import {Interactions} from '../electron/core/interactions';
import {DEFAULT_RUNTIME} from '../src/runtime-types';
import {RunPolicy} from '../electron/core/runtime-policy';
import {Harness} from '../electron/core/harness';
import type {ModelClient} from '../electron/core/model';
import {ExecutionLedger} from '../electron/core/execution-ledger';
import {recordDelegationReceipt,delegationStatus} from '../electron/core/delegation';
import type {VmController} from '../electron/core/vm';
const fixture=(t:test.TestContext)=>{const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'aelion-upgrade-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
test('unchanged skills do not produce versions; patch and resource overwrites require current content',t=>{
 const dir=fixture(t),store=new Store(dir),bot=store.data.bots[0],paths={dataDir:dir,projectDir:dir,homeDir:join(dir,'home'),configDir:join(dir,'config'),env:{}};const library=new SkillLibrary(store,paths);
 const first=library.save(bot.id,'分析数据','复用流程','第一步读取，第二步验证。'),revision=library.revisions(bot.id,first.id).length;
 assert.equal(library.save(bot.id,'分析数据','复用流程','第一步读取，第二步验证。').unchanged,true);assert.equal(library.revisions(bot.id,first.id).length,revision);
 assert.throws(()=>library.patch(bot.id,first.id,'读取','加载','wrong','r'),/变化/);library.patch(bot.id,first.id,'读取','加载',first.hash,'r');
 library.manage(bot.id,first.id,'archive');assert.ok(!new SkillLibrary(store,paths).list(bot.id).some(s=>s.id===first.id));library.manage(bot.id,first.id,'restore');assert.ok(library.list(bot.id).some(s=>s.id===first.id));
 library.manage(bot.id,first.id,'restore_revision',first.revision);assert.equal(library.read(bot.id,first.id).body,'第一步读取，第二步验证。');
 const file=library.writeResource(bot.id,first.id,'references/check.txt','original');assert.throws(()=>library.writeResource(bot.id,first.id,'references/check.txt','changed'),/hash/);assert.equal(library.writeResource(bot.id,first.id,'references/check.txt','changed',file.hash).saved,true);assert.throws(()=>library.writeResource(bot.id,first.id,'references/../../escape','x'),/相对路径/);
});
test('read pipelines respect concurrency, dependencies and reject mutations before dispatch',async()=>{
 let active=0,peak=0;const result=await readPipeline([{id:'a',tool:'file_read',args:{path:'a'}},{id:'b',tool:'file_read',args:{path:'b'}},{id:'c',tool:'file_read',dependsOn:['a'],args:{path:{$from:'a',path:'next'}}}],2,new AbortController().signal,async(_name,args)=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;return {next:args.path+'-next'};});
 assert.equal(peak,2);assert.equal((result.results.c?.result as any).next,'a-next-next');assert.equal(result.isError,false);
 let called=false;await assert.rejects(readPipeline([{id:'x',tool:'host_execute',args:{command:'write'}}],2,new AbortController().signal,async()=>{called=true;}),/读取工具/);assert.equal(called,false);
});
test('incremental state persists only changed records and resumes without replay',t=>{
 const dir=fixture(t),db=new StateDatabase(dir),state={version:1,messages:Array.from({length:100},(_,id)=>({id,text:'old'})),conversations:{a:[{role:'user',content:'test'}]}};
 db.write(state);assert.equal(db.write(state),0);state.messages[10].text='new';assert.equal(db.write(state),1);db.close();const reopened=new StateDatabase(dir);assert.deepEqual(reopened.read(),state);reopened.close();
 const appDir=join(dir,'app'),store=new Store(appDir,{incremental:true}),id=store.data.bots[0].id;store.message(id,'user','persisted');store.close();const restored=new Store(appDir,{incremental:true});assert.equal(restored.data.messages.at(-1)?.content,'persisted');restored.close();
});
test('file rollback preserves later user edits and still requires host approval',async t=>{
 const dir=fixture(t),store=new Store(dir);store.data.runtime={...DEFAULT_RUNTIME,fileCheckpoints:true};const bot=store.data.bots[0],interactions=new Interactions(()=>{}),checkpoints=new FileCheckpoints(store,{} as VmController,interactions),path=join(dir,'proof.txt');
 writeFileSync(path,'before');const record=checkpoints.hostBefore(bot.id,'r',path)!;writeFileSync(path,'after');checkpoints.hostAfter(record,path);writeFileSync(path,'user edit');await assert.rejects(checkpoints.restore(bot.id,record.id,new AbortController().signal,'r2'),/被修改/);assert.equal(readFileSync(path,'utf8'),'user edit');
 writeFileSync(path,'after');const restoring=checkpoints.restore(bot.id,record.id,new AbortController().signal,'r2');assert.equal(readFileSync(path,'utf8'),'after');interactions.approve(interactions.snapshot()[0].id,true);await restoring;assert.equal(readFileSync(path,'utf8'),'before');interactions.dispose();
});
test('a long task can finish beyond the old 30-round limit',async t=>{
 const store=new Store(fixture(t));let steps=0;
 const model={complete:async()=>steps<32?{content:'',finishReason:'tool_calls',calls:[{id:String(++steps),type:'function',function:{name:'computer_execute',arguments:'{"command":"verify"}'}}]}:{content:'已验证全部步骤',finishReason:'stop',calls:[]}} as unknown as ModelClient;
 await new Harness(store,{execute:async()=>({exitCode:0,stdout:'verified'})} as unknown as VmController,model,()=>{}).run(store.data.bots[0].id,'执行并检查完整任务');
 assert.equal(steps,32);assert.equal(store.data.runs[0].status,'completed');assert.equal(store.data.runs[0].modelCalls,33);
});
test('delegation completion belongs to its recipient and requires real evidence',t=>{
 const store=new Store(fixture(t)),sender=store.data.bots[0],recipient=store.createBot('接收方','验证任务'),third=store.createBot('无关','隔离');
 store.data.peerExchanges.push({id:'e',threadId:'t',fromBotId:sender.id,toBotId:recipient.id,rootRunId:'source',rootBotId:sender.id,rootRequest:'验证文件',status:'working',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),requestMessageId:'q',task:{goal:'验证文件',acceptance:['实际读取结果'],expectedOutput:'结论'}});
 store.data.runs.push({id:'r',botId:recipient.id,status:'running',startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0,peerOrigin:{kind:'peer_task',exchangeId:'e'}});
 assert.throws(()=>recordDelegationReceipt(store,sender.id,'r',{status:'completed',summary:'完成',evidenceIds:[]}),/接收方/);
 assert.throws(()=>recordDelegationReceipt(store,recipient.id,'r',{status:'completed',summary:'完成',evidenceIds:[]}),/真实执行证据/);
 const ledger=new ExecutionLedger(store),entry=ledger.begin(recipient.id,'r',{id:'call',type:'function',function:{name:'file_read',arguments:'{}'}},{path:'proof'});ledger.finish(entry,'succeeded',{stdout:'verified'},'result');
 recordDelegationReceipt(store,recipient.id,'r',{status:'completed',summary:'已实际读取并核对',evidenceIds:[entry.id]});assert.equal(delegationStatus(store,sender.id,'e').receipt?.status,'completed');assert.throws(()=>delegationStatus(store,third.id,'e'),/无权/);
});
