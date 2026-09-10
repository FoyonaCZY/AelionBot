import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Store} from '../electron/core/store';
import {HostComputer} from '../electron/core/host';
import {Interactions} from '../electron/core/interactions';
import {Harness,TOOLS} from '../electron/core/harness';
import type {Completion,ModelClient} from '../electron/core/model';
import type {WireMessage} from '../src/shared';
const call=(name:string,args:unknown)=>({id:randomUUID(),type:'function' as const,function:{name,arguments:JSON.stringify(args)}});
function fixture(t:test.TestContext,complete:(messages:WireMessage[],index:number)=>Completion){
 const parent=realpathSync(tmpdir()),dir=mkdtempSync(join(parent,'aelion-tool-flow-')),store=new Store(join(dir,'data'));store.data.model.model='test';store.data.model.contextTokens=64000;let calls=0;
 const interactions=new Interactions(()=>{for(const request of interactions.snapshot())if(request.kind==='host_permission')queueMicrotask(()=>{try{interactions.approve(request.id,true);}catch{}});});
 const host=new HostComputer({dataDir:store.dir,homeDir:dir,projectDir:dir,env:{...process.env},imagePreview:(_bytes,id)=>({id,width:20,height:20})},interactions);
 const model={complete:async(messages:WireMessage[])=>complete(messages,++calls)} as unknown as ModelClient,harness=new Harness(store,{} as any,model,()=>{},undefined,undefined,undefined,host,interactions);
 t.after(()=>{harness.disposeTools();host.dispose();interactions.dispose();store.close();assert.equal(dirname(resolve(dir)),parent);rmSync(dir,{recursive:true,force:true});});return {dir,store,host,interactions,harness,bot:store.data.bots[0]};
}
test('small-window Bots discover omitted tools and invoke them through code with real execution evidence',async t=>{
 const f=fixture(t,(messages,index)=>{
  if(index===1)return {content:'',finishReason:'tool_calls',calls:[call('tool_search',{query:'apply_patch',includeMcp:false})]};
  if(index===2){assert.match(JSON.stringify(messages),/apply_patch/);return {content:'',finishReason:'tool_calls',calls:[call('code_exec',{code:`const result=await tools.apply_patch({location:'host',reason:'Apply requested change',patch:${JSON.stringify('*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** Add File: b.txt\n+created\n*** End Patch')}});emit(result.result);`})]};}
  assert.ok(messages.some(message=>message.role==='tool'&&JSON.parse(message.content||'{}').result?.output?.[0]?.applied===true));return {content:'已完成两个文件的修改。',finishReason:'stop',calls:[]};
 });f.store.data.model.contextTokens=8000;writeFileSync(join(f.dir,'a.txt'),'old\n');await f.harness.run(f.bot.id,'修改两个项目文件',{workspaceDir:f.dir});
 assert.equal(f.store.data.runs[0].status,'completed',f.store.data.runs[0].error||'');assert.equal(readFileSync(join(f.dir,'a.txt'),'utf8'),'new\n');assert.equal(readFileSync(join(f.dir,'b.txt'),'utf8'),'created\n');assert.ok(f.store.data.runs[0].executions?.some(entry=>entry.tool==='apply_patch'&&entry.status==='succeeded'));
});
test('nonblocking questions permit independent reading and their answers return to the same run',async t=>{
 const f=fixture(t,(messages,index)=>{
  if(index===1)return {content:'先确认范围，同时读取项目。',finishReason:'tool_calls',calls:[call('request_user_input',{questions:[{id:'scope',title:'选择范围',options:['修复','测试']}]}),call('host_file_read',{path:'a.txt',reason:'Read project'})]};
  if(!messages.some(message=>message.role==='user'&&message.content?.includes('用户对会话内问题的回答')))return {content:'文件已读取，等待你确认范围。',finishReason:'stop',calls:[]};
  assert.match(JSON.stringify(messages),/测试/);return {content:'已读取文件，接下来按测试范围处理。',finishReason:'stop',calls:[]};
 });writeFileSync(join(f.dir,'a.txt'),'project');const pending=f.harness.run(f.bot.id,'先确认范围',{workspaceDir:f.dir});
 for(let i=0;i<100&&!f.store.data.messages.some(message=>message.tool==='host_file_read'&&message.status==='done');i++)await new Promise(resolve=>setTimeout(resolve,10));
 const question=f.interactions.snapshot().find(request=>request.kind==='user_input');assert.ok(question);assert.ok(f.store.data.messages.some(message=>message.tool==='host_file_read'&&message.status==='done'));f.interactions.answer(question.id,{scope:'测试'});await pending;assert.equal(f.store.data.runs[0].status,'completed',f.store.data.runs[0].error||'');assert.equal(f.store.data.messages.filter(message=>message.role==='user').length,2);
});
test('view_image passes a real image reference into the model and stores its preview for the UI',async t=>{
 const f=fixture(t,(messages,index)=>{if(index===1)return {content:'',finishReason:'tool_calls',calls:[call('view_image',{path:'image.png',reason:'Check generated chart'})]};assert.ok(messages.some(message=>message.images?.length===1));return {content:'已查看图表。',finishReason:'stop',calls:[]};});writeFileSync(join(f.dir,'image.png'),Buffer.from('fixture-image'));await f.harness.run(f.bot.id,'看看图片',{workspaceDir:f.dir});assert.equal(f.store.data.runs[0].status,'completed');assert.ok(f.store.data.messages.find(message=>message.tool==='view_image')?.screenshotId);
});
test('all new tools have strict argument schemas and no subagent creation is introduced',()=>{
 for(const name of ['terminal_start','terminal_input','terminal_read','terminal_stop','apply_patch','code_exec','request_user_input','user_input_wait','view_image','tool_search','web_search','web_read','mcp_list_resource_templates'])assert.equal(TOOLS.find(tool=>tool.function.name===name)?.function.parameters.additionalProperties,false);
 assert.equal(TOOLS.some(tool=>tool.function.name==='spawn_agent'),false);
});
