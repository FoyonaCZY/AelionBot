import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {Store} from '../electron/core/store';
import {ModelProviders} from '../electron/core/model-providers';
import {HostApprovals,defaultApprovalModel} from '../electron/core/host-approvals';
import {CommandPermissions} from '../electron/core/command-permissions';
import {DEFAULT_RUNTIME} from '../src/runtime-types';
import type {HostPermissionRequest} from '../electron/core/host-approval-types';
function fixture(t:test.TestContext){
 const parent=realpathSync(tmpdir()),dir=mkdtempSync(join(parent,'aelion-review-model-')),store=new Store(dir);
 const codec={encrypt:(value:string)=>Buffer.from(value).toString('base64'),decrypt:(value:string)=>Buffer.from(value,'base64').toString()};
 const providers=new ModelProviders(store,codec);
 const a=providers.save({name:'Chat provider',baseUrl:'http://localhost:1/v1',apiKey:'chat-fixture-key'});
 const b=providers.save({name:'Review provider',baseUrl:'http://localhost:2/v1',apiKey:'review-fixture-key'});
 providers.setDefault({providerId:a.id,model:'chat-model',contextTokens:128000,reasoningEffort:'high'});
 t.after(()=>{providers.dispose();store.close();assert.equal(dirname(dir),parent);rmSync(dir,{recursive:true,force:true});});
 return {store,providers,a,b,dir,codec};
}
test('approval selection inherits by default, persists independently, and can reset to inheritance',t=>{
 const f=fixture(t),bot=f.store.data.bots[0];
 assert.equal(f.providers.approvalConfig().model,'chat-model');assert.equal(f.providers.approvalKey(),'chat-fixture-key');
 f.providers.setApproval({providerId:f.b.id,model:'custom-review-model',contextTokens:32000,reasoningEffort:'custom-low'});
 assert.equal(f.providers.approvalConfig().model,'custom-review-model');assert.equal(f.providers.approvalConfig().reasoningEffort,'custom-low');assert.equal(f.providers.approvalKey(),'review-fixture-key');
 assert.equal(f.providers.config(bot.id).model,'chat-model');assert.equal(f.providers.config().model,'chat-model');assert.equal(f.providers.key(bot.id),'chat-fixture-key');
 f.providers.setDefault({providerId:f.a.id,model:'new-chat',contextTokens:64000});assert.equal(f.providers.approvalConfig().model,'custom-review-model');
 const reopened=new Store(f.dir),restored=new ModelProviders(reopened,f.codec);
 try{assert.equal(restored.approvalConfig().model,'custom-review-model');assert.equal(restored.approvalKey(),'review-fixture-key');}finally{restored.dispose();reopened.close();}
 assert.throws(()=>f.providers.remove(f.b.id),/自动审核模型/);
 f.providers.setApproval(null);assert.equal(f.providers.approvalConfig().model,'new-chat');assert.equal(f.providers.approvalKey(),'chat-fixture-key');
 f.providers.remove(f.b.id);
});
test('approval models do not require a chat default and invalid settings cannot silently select another provider',t=>{
 const f=fixture(t);f.providers.setDefault(null);
 f.providers.setApproval({providerId:f.b.id,model:'review-only',contextTokens:16000});assert.equal(f.providers.config().model,'');assert.equal(f.providers.approvalConfig().model,'review-only');
 const before=JSON.stringify(f.store.data.approvalModel);
 for(const bad of [{providerId:'missing',model:'x',contextTokens:16000},{providerId:f.b.id,model:'',contextTokens:16000},{providerId:f.b.id,model:'x',contextTokens:5}])assert.throws(()=>f.providers.setApproval(bad));
 assert.equal(JSON.stringify(f.store.data.approvalModel),before);
 f.store.data.providers=f.store.data.providers!.filter(p=>p.id!==f.b.id);
 assert.ok(f.providers.approvalConfig().issue);assert.equal(f.providers.approvalKey(),'');
});
test('review requests use the selected model and credential while retaining Bot usage attribution',async t=>{
 const f=fixture(t);let actualModel='',authorization='';let attribution:string|undefined;
 const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;actualModel=JSON.parse(text).model;authorization=req.headers.authorization||'';res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'{"decision":"ask","reason":"fixture"}'},finish_reason:'stop'}]}));});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>{server.closeAllConnections();server.close();});
 const provider=f.providers.save({id:f.b.id,name:f.b.name,baseUrl:`http://127.0.0.1:${(server.address() as any).port}/v1`,apiKey:'review-fixture-key'});
 f.providers.setApproval({providerId:provider.id,model:'review-selected',contextTokens:32000});
 const client=defaultApprovalModel({config:()=>f.providers.approvalConfig(),key:()=>f.providers.approvalKey()},()=>DEFAULT_RUNTIME,record=>{attribution=record.botId;});t.after(()=>client.dispose());
 await client.complete([{role:'user',content:'Review fixture'}],[],new AbortController().signal,undefined,{botId:f.store.data.bots[0].id,purpose:'permission_review'});
 assert.equal(actualModel,'review-selected');assert.equal(authorization,'Bearer review-fixture-key');assert.equal(attribution,f.store.data.bots[0].id);
});
test('a selection changed during review invalidates an in-flight allow',async t=>{
 const f=fixture(t);let finish!:(value:any)=>void;
 const policy=new HostApprovals(f.store,new CommandPermissions(join(f.dir,'permissions.json')),()=>new Promise(resolve=>{finish=resolve;}),{homeDir:f.dir,defaultModel:()=>f.providers.approvalConfig()});
 const result=policy.review({botId:f.store.data.bots[0].id,runId:'fixture',createdAt:new Date().toISOString(),details:{operation:'command',command:'echo fixture',reason:'fixture'}} as HostPermissionRequest,new AbortController().signal);
 f.providers.setApproval({providerId:f.b.id,model:'new-reviewer',contextTokens:32000});finish({decision:'allow',reason:'stale'});
 assert.equal((await result).decision,'ask');
});
