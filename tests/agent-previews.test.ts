import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../electron/core/store';
import {Attachments} from '../electron/core/attachments';
import {AgentPreviews} from '../electron/core/agent-previews';
import {HostComputer} from '../electron/core/host';
import {Harness,TOOLS} from '../electron/core/harness';
import type {ArtifactService} from '../electron/core/artifacts';
import type {Interactions} from '../electron/core/interactions';
import type {VmController} from '../electron/core/vm';
import type {ModelClient,Completion} from '../electron/core/model';
import type {RunRecord,WireMessage} from '../src/shared';
import {previewForConversation} from '../src/agent-preview';
import {validateToolArguments} from '../electron/core/tool-schema';
function fixture(t:test.TestContext){
 const dir=mkdtempSync(join(tmpdir(),'aelion-preview-')),store=new Store(dir),bot=store.data.bots[0],other=store.createBot('Other','Other'),attachments=new Attachments(store);
 const run:RunRecord={id:randomUUID(),botId:bot.id,status:'running',startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0};store.data.runs.push(run);
 const reads:Array<{botId:string;path:string;max:number}>=[];
 const artifacts={isLocal:()=>false,read:async(botId:string,path:string,max:number)=>{reads.push({botId,path,max});if(path==='missing.txt')throw Error('missing');return Buffer.from('Hello');}} as unknown as ArtifactService;
 let notify=0;const previews=new AgentPreviews(store,artifacts,attachments,()=>notify++);
 t.after(()=>{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
 return {dir,store,bot,other,run,attachments,artifacts,previews,reads,notifications:()=>notify};
}
const signal=()=>new AbortController().signal;
const args={location:'vm',path:'result.md',reason:'展示结果'};
test('preview tool accepts file or attachment targets, validates schema, and never joins read batches',()=>{
 const tool=TOOLS.find(tool=>tool.function.name==='open_preview')!;assert.ok(tool);
 validateToolArguments(tool,args);validateToolArguments(tool,{attachmentId:randomUUID(),reason:'Show attachment',placement:'full'});
 assert.throws(()=>validateToolArguments(tool,{...args,location:'other'}));assert.throws(()=>validateToolArguments(tool,{path:'a.md',location:'vm'}));
 const batch=TOOLS.find(tool=>tool.function.name==='tools_batch')!;assert.ok(!JSON.stringify(batch).includes('open_preview'));
});
test('VM previews normalize their own absolute paths and only queue the current conversation',async t=>{
 const f=fixture(t),result=await f.previews.open(f.bot.id,f.run.id,{...args,path:'/work/'+f.bot.id+'/result.md'},signal());
 assert.equal(result.queued,true);assert.equal((result as any).opened,undefined);assert.deepEqual(f.reads,[{botId:f.bot.id,path:'result.md',max:2*1024*1024}]);
 const requests=f.previews.snapshot();assert.equal(previewForConversation(requests,{kind:'bot',id:f.other.id}),undefined);assert.equal(previewForConversation(requests,{kind:'bot',id:f.bot.id})?.name,'result.md');
 await f.previews.open(f.bot.id,f.run.id,{...args,path:'new.md',placement:'full'},signal());assert.equal(f.previews.snapshot().length,1);
 f.previews.acknowledge(result.requestId);assert.equal(f.previews.snapshot().length,1);f.previews.acknowledge(f.previews.snapshot()[0].id);assert.equal(f.previews.snapshot().length,0);
});
test('bad paths, other workspaces, unsupported files, missing files and stopped runs cannot enqueue previews',async t=>{
 const f=fixture(t);
 for(const path of ['../secret.md','/etc/a.md','/work/'+f.other.id+'/x.md','C:\\secret.md','https://example.com/x.html','a.exe','missing.txt'])await assert.rejects(f.previews.open(f.bot.id,f.run.id,{...args,path},signal()));
 await assert.rejects(f.previews.open(f.bot.id,f.run.id,{...args,attachmentId:randomUUID()},signal()));
 f.run.status='completed';await assert.rejects(f.previews.open(f.bot.id,f.run.id,args,signal()));assert.equal(f.previews.snapshot().length,0);
});
test('an aborted read never opens a preview',async t=>{
 const f=fixture(t),controller=new AbortController();const previews=new AgentPreviews(f.store,{read:async()=>{controller.abort();return Buffer.from('text');}} as any,f.attachments,()=>{});
 await assert.rejects(previews.open(f.bot.id,f.run.id,args,controller.signal));assert.equal(previews.snapshot().length,0);
});
test('attachment ownership is checked and source formats share the code preview path',async t=>{
 const f=fixture(t),file=f.attachments.importForBot(f.other.id,'a.mjs',Buffer.from('export const answer=42;'));
 await assert.rejects(f.previews.open(f.bot.id,f.run.id,{attachmentId:file.id,reason:'show'},signal()));
 f.store.message(f.bot.id,'user','Please read',{attachments:[file]});await f.previews.open(f.bot.id,f.run.id,{attachmentId:file.id,reason:'show'},signal());
 assert.equal(f.attachments.preview(file.id).kind,'text');assert.equal(f.previews.snapshot()[0].target.kind,'attachment');
});
test('a group origin always keeps previews in the group, even for legacy promoted runs',async t=>{
 const f=fixture(t),groupId=randomUUID();f.store.data.groups.push({id:groupId,members:[{id:f.bot.id}],messages:[]} as any);
 f.run.groupOrigin={groupId} as any;await f.previews.open(f.bot.id,f.run.id,args,signal());assert.deepEqual(f.previews.snapshot()[0].scope,{kind:'group',id:groupId});
 assert.equal(previewForConversation(f.previews.snapshot(),{kind:'bot',id:f.bot.id}),undefined);
 f.run.groupTask=true;await f.previews.open(f.bot.id,f.run.id,args,signal());assert.deepEqual(f.previews.snapshot().at(-1)?.scope,{kind:'group',id:groupId});assert.equal(previewForConversation(f.previews.snapshot(),{kind:'bot',id:f.bot.id}),undefined);
 f.store.data.groups[0].members[0].leftAt=new Date().toISOString();assert.equal(f.previews.snapshot().length,0);
});
test('host previews honor permission, freeze a copy, and reject files changed during approval',async t=>{
 const f=fixture(t);let decision='allow',permissions=0;const file=join(f.dir,'result.ts');writeFileSync(file,'const answer=42;');
 const host=new HostComputer({dataDir:f.dir,projectDir:f.dir,homeDir:f.dir}, {permission:async(_b:string,_r:string,details:any)=>{permissions++;assert.equal(details.operation,'read_file');assert.equal(details.tool,'open_preview');if(decision==='deny')throw Error('denied');if(decision==='change')writeFileSync(file,'changed during approval');}} as unknown as Interactions);
 t.after(()=>host.dispose());f.run.workspaceDir=f.dir;
 const previews=new AgentPreviews(f.store,f.artifacts,f.attachments,()=>{},host);
 decision='deny';await assert.rejects(previews.open(f.bot.id,f.run.id,{location:'host',path:'result.ts',reason:'show'},signal()),/denied/);assert.equal(previews.snapshot().length,0);
 decision='change';await assert.rejects(previews.open(f.bot.id,f.run.id,{location:'host',path:'result.ts',reason:'show'},signal()),/变化/);assert.equal(previews.snapshot().length,0);
 decision='allow';await previews.open(f.bot.id,f.run.id,{location:'host',path:'result.ts',reason:'show'},signal());const target=previews.snapshot()[0].target;assert.equal(target.kind,'attachment');if(target.kind!=='attachment')throw Error('target');
 writeFileSync(file,'new local contents');assert.equal(f.attachments.preview(target.file.id).content,'changed during approval');assert.equal(readFileSync(file,'utf8'),'new local contents');assert.equal(permissions,3);
});
test('model tool dispatch reaches the preview queue and returns a real tool receipt',async t=>{
 const f=fixture(t);f.store.data.runs=[];f.store.data.model.model='fixture';f.store.data.model.contextTokens=64000;let calls=0,receipt=false;
 const model={complete:async(messages:WireMessage[]):Promise<Completion>=>{calls++;if(calls===1)return {content:'',calls:[{id:randomUUID(),type:'function',function:{name:'open_preview',arguments:JSON.stringify(args)}}],finishReason:'tool_calls'};receipt=messages.some(message=>message.role==='tool'&&message.content?.includes('requestId'));return {content:'The preview is ready to open.',calls:[],finishReason:'stop'};}} as unknown as ModelClient;
 const harness=new Harness(f.store,{state:{status:'stopped'}} as VmController,model,()=>{},undefined,undefined,undefined,undefined,undefined,undefined,f.attachments);harness.setPreviewGateway(f.previews);
 t.after(()=>harness.disposeTools());await harness.run(f.bot.id,'Show the result');assert.equal(receipt,true);assert.equal(f.previews.snapshot().length,1);assert.equal(f.store.data.runs.at(-1)?.status,'completed');
});

test('URL previews route VM services to their Bot and reject ambiguous or mixed targets',async t=>{
 const f=fixture(t);
 await f.previews.open(f.bot.id,f.run.id,{url:'http://localhost:5173/app?q=1',location:'vm',reason:'Show frontend'},signal());
 assert.deepEqual(f.previews.snapshot()[0].target,{kind:'url',url:'http://localhost:5173/app?q=1',location:'vm'});assert.equal(f.reads.length,0);
 for(const input of [{url:'http://localhost:5173'},{url:'http://localhost:22',location:'vm'},{url:'https://example.com',location:'vm'},{url:'file:///etc/passwd'},{url:'https://example.com',path:'a.html',location:'host'}])await assert.rejects(f.previews.open(f.bot.id,f.run.id,{reason:'Show',...input},signal()));
 await f.previews.open(f.bot.id,f.run.id,{url:'https://example.com/demo',reason:'Show website'},signal());assert.equal(f.previews.snapshot()[0].target.kind,'url');
});

test('acknowledged previews stay in per-conversation history so they can reopen',async t=>{
 const f=fixture(t);
 await f.previews.open(f.bot.id,f.run.id,{url:'http://localhost:5173/',location:'vm',reason:'Show site'},signal());
 const queued=f.previews.snapshot()[0];
 f.previews.acknowledge(queued.id);
 assert.equal(f.previews.snapshot().length,0);
 const history=f.previews.history();assert.equal(history.length,1);
 assert.equal(history[0].id,queued.id);assert.deepEqual(history[0].scope,{kind:'bot',id:f.bot.id});
 assert.deepEqual(history[0].target,{kind:'url',url:'http://localhost:5173/',location:'vm'});
 assert.ok(history[0].acknowledgedAt>=history[0].createdAt);
 const reopened=new Store(f.dir);assert.equal(reopened.data.previewHistory?.length,1,'历史写入磁盘');
});

test('preview history never persists URLs with query or fragment values',async t=>{
 const f=fixture(t),secret='review-secret-123';
 await f.previews.open(f.bot.id,f.run.id,{url:`https://example.com/demo?token=${secret}#access-token`,reason:'Show site'},signal());
 f.previews.acknowledge(f.previews.snapshot()[0].id);
 assert.equal(f.previews.history().length,0);
 assert.ok(!readFileSync(join(f.dir,'state.json'),'utf8').includes(secret));
});

test('history keeps only the newest previews per conversation',async t=>{
 const f=fixture(t);
 for(let i=0;i<23;i++){
  await f.previews.open(f.bot.id,f.run.id,{url:`http://localhost:30${String(i).padStart(3,'0')}/`,location:'vm',reason:'Show'},signal());
  f.previews.acknowledge(f.previews.snapshot()[0].id);
 }
 const history=f.previews.history();assert.equal(history.length,20);
 assert.equal((history.at(-1)!.target as any).url,'http://localhost:30022/');
 const other=new Store(f.dir);assert.equal(other.data.previewHistory?.length,20);
});
