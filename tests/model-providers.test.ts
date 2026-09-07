import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {Store} from '../electron/core/store';
import {ModelProviders,type CredentialCodec} from '../electron/core/model-providers';
import {updateBotProfile} from '../electron/core/bot-profile';
import {ModelClient,type Completion} from '../electron/core/model';
import {Harness} from '../electron/core/harness';
import {BotGreetings} from '../electron/core/bot-greetings';
import {ChatPinQueue} from '../electron/core/chat-pins';
import {Cognition} from '../electron/core/cognition';
import {CognitiveStore} from '../electron/core/cognitive-store';
import {ContextEngine} from '../electron/core/context-engine';
import {contextBudget} from '../electron/core/context-budget';
import {prepareGroupContext} from '../electron/core/group-history';
import {SkillLibrary} from '../electron/core/skill-library';
import {PeerChats} from '../electron/core/peer-chats';
import {GroupChats} from '../electron/core/group-chats';
import {groupPending} from '../src/group-types';
import type {VmController} from '../electron/core/vm';
import type {WireMessage} from '../src/shared';
import {protocolRequest} from '../electron/core/model-protocol';

test('provider reasoning migrates once to independent Bot settings and the default reviewer',t=>{
  const f=fixture(t),a=f.store.data.bots[0],b=f.store.createBot('Beta','test');
  f.store.data.providers=[{id:'a',name:'Alpha',baseUrl:'https://a.example/v1',models:[],reasoningEffort:'high'},{id:'b',name:'Beta',baseUrl:'https://b.example/v1',models:[],reasoningEffort:'custom-ultra'}];
  f.store.data.defaultModel={providerId:'a',model:'default-model',contextTokens:32000};b.model={providerId:'b',model:'beta-model',contextTokens:64000};f.store.save();
  const providers=f.router();assert.equal(providers.config(a.id).reasoningEffort,'high');assert.equal(providers.config(b.id).reasoningEffort,'custom-ultra');assert.equal(providers.config().reasoningEffort,'high');assert.ok(providers.list().every(provider=>provider.reasoningEffort===undefined));
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir,'reasoning-migration-backup.json'),'utf8')).providers,[{id:'a',reasoningEffort:'high'},{id:'b',reasoningEffort:'custom-ultra'}]);
  providers.setDefault({...f.store.data.defaultModel!,reasoningEffort:'minimal'});assert.equal(providers.config().reasoningEffort,'minimal');assert.equal(providers.config(a.id).reasoningEffort,'high');
  updateBotProfile(f.store,providers,{id:a.id,name:a.name,role:a.role,reasoningEffort:null});assert.equal(providers.config(a.id).reasoningEffort,undefined);
  const reopened=new ModelProviders(new Store(f.dir),f.secret);assert.equal(reopened.config(a.id).reasoningEffort,undefined);assert.equal(reopened.config(b.id).reasoningEffort,'custom-ultra');reopened.dispose();
});

test('custom model names and per-Bot reasoning reach the chosen protocol without affecting peers',t=>{
  const f=fixture(t),providers=f.router(),a=f.store.data.bots[0],b=f.store.createBot('Beta','test'),provider=providers.save({name:'Empty list',baseUrl:'https://a.example/v1',protocol:'responses'});
  providers.setDefault({providerId:provider.id,model:'not-in-catalog/v2',contextTokens:64000});
  updateBotProfile(f.store,providers,{id:a.id,name:a.name,role:a.role,model:null,reasoningEffort:' ultra-plus '});
  assert.equal(providers.config(a.id).reasoningEffort,'ultra-plus');assert.equal(providers.config(b.id).reasoningEffort,undefined);
  let body=protocolRequest(providers.config(a.id),[],[],1024,'',()=> '').body as any;assert.equal(body.model,'not-in-catalog/v2');assert.equal(body.reasoning.effort,'ultra-plus');
  body=protocolRequest({...providers.config(a.id),protocol:'chat'},[],[],1024,'',()=> '').body as any;assert.equal(body.reasoning_effort,'ultra-plus');
  const before=JSON.stringify(f.store.data);assert.throws(()=>updateBotProfile(f.store,providers,{id:a.id,name:'changed',role:a.role,reasoningEffort:'bad\nvalue'}),/推理强度/);assert.equal(JSON.stringify(f.store.data),before);
  assert.throws(()=>updateBotProfile(f.store,providers,{id:a.id,name:'changed',role:a.role,reasoningEffort:'low'},()=>{throw Error('busy');}),/busy/);assert.equal(JSON.stringify(f.store.data),before);
});

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate:()=>boolean){for(let n=0;n<400;n++){if(predicate())return;await pause(10);}throw Error('Provider test did not settle');}
const answer=(content:string):Completion=>({content,calls:[],finishReason:'stop'});
function codec():CredentialCodec{const key=randomBytes(32);return {encrypt:value=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),bytes=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64');},decrypt:value=>{const bytes=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8');}};}
function fixture(t:test.TestContext){
  const dir=mkdtempSync(join(tmpdir(),'aelion-providers-')),store=new Store(dir),secret=codec(),servers:Server[]=[],cleanup:Array<()=>void|Promise<void>>=[];
  t.after(async()=>{for(const close of cleanup)await close();for(const server of servers){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
  async function endpoint(label:string){
    const requests:Array<{url:string;key:string;body?:any}>=[];
    const config={models:[{id:label+'-model'}] as unknown,listStatus:200,listBody:undefined as string|undefined,hold:undefined as Promise<void>|undefined,rejectUsage:false,respond:async(_body:any):Promise<Completion>=>answer(label+' reply')};
    const server=createServer(async(req,res)=>{try{
      let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):undefined;requests.push({url:req.url||'',key:req.headers.authorization||'',body});
      if(req.url==='/v1/models'){await config.hold;if(res.destroyed)return;res.writeHead(config.listStatus,{'Content-Type':'application/json'});res.end(config.listBody??JSON.stringify({data:config.models}));return;}
      if(req.url!=='/v1/chat/completions'){res.writeHead(404).end();return;}
      if(config.rejectUsage&&body.stream_options){res.writeHead(400).end('stream_options is unsupported');return;}
      const result=await config.respond(body);if(res.destroyed)return;
      res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:result.content,...(result.calls.length?{tool_calls:result.calls.map((call,index)=>({...call,index}))}:{})},finish_reason:result.finishReason}]})+'\n\ndata: [DONE]\n\n');
    }catch(error){if(!res.destroyed)res.writeHead(500).end(String(error));}});servers.push(server);
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as any).port;
    return {url:`http://127.0.0.1:${port}/v1`,config,requests};
  }
  function router(){const value=new ModelProviders(store,secret);cleanup.push(()=>value.dispose());return value;}
  return {dir,store,secret,cleanup,endpoint,router};
}

test('legacy configuration migrates once, keeps the encrypted key and preserves existing Bot choices across reopen',t=>{
  const f=fixture(t);f.store.data.model={baseUrl:'https://example.test/v1',model:'original-model',contextTokens:64000,encryptedKey:f.secret.encrypt('legacy-provider-secret')};f.store.save();const before=JSON.stringify(f.store.data.bots),providers=f.router();
  assert.equal(providers.list().length,1);const id=providers.list()[0].id;assert.equal(providers.key(f.store.data.bots[0].id),'legacy-provider-secret');assert.equal(providers.config().contextTokens,64000);assert.equal(providers.config().model,'original-model');assert.equal(JSON.stringify(f.store.data.bots),before);
  assert.ok(existsSync(join(f.dir,'providers-migration-backup.json')));assert.ok(!readFileSync(f.store.file,'utf8').includes('legacy-provider-secret'));assert.ok(!JSON.stringify(providers.list()).includes('encryptedKey'));
  const reopened=new ModelProviders(new Store(f.dir),f.secret);assert.equal(reopened.list()[0].id,id);assert.equal(reopened.key(),'legacy-provider-secret');reopened.dispose();
});

test('default and per-Bot models resolve independently and used Providers cannot be removed',t=>{
  const f=fixture(t),providers=f.router(),a=f.store.data.bots[0],b=f.store.createBot('Beta','test');
  const p=providers.save({name:'Alpha',baseUrl:'https://a.example/v1',apiKey:'alpha-provider-secret'}),q=providers.save({name:'Beta',baseUrl:'https://b.example/v1',apiKey:'beta-provider-secret'});
  providers.setDefault({providerId:p.id,model:'alpha',contextTokens:8000});providers.setBot(b.id,{providerId:q.id,model:'beta',contextTokens:64000});
  assert.equal(providers.config(a.id).model,'alpha');assert.equal(providers.config(b.id).model,'beta');assert.equal(providers.key(b.id),'beta-provider-secret');
  assert.throws(()=>providers.remove(p.id),/仍被/);assert.throws(()=>providers.remove(q.id),/仍被/);providers.setDefault(null);assert.equal(providers.config(a.id).model,'');assert.equal(providers.config(b.id).model,'beta');providers.remove(p.id);
  const restored=new ModelProviders(new Store(f.dir),f.secret);assert.equal(restored.config(b.id).providerId,q.id);assert.equal(restored.config(b.id).contextTokens,64000);restored.dispose();
  const before=readFileSync(f.store.file,'utf8');assert.throws(()=>providers.setBot(b.id,{providerId:'missing',model:'x',contextTokens:8000}),/不存在/);assert.throws(()=>providers.setBot(b.id,{providerId:q.id,model:'x',contextTokens:100}),/上下文/);assert.equal(readFileSync(f.store.file,'utf8'),before);
  assert.throws(()=>providers.save({id:q.id,name:'Beta',baseUrl:'https://other.example/v1'}),/重新填写/);assert.equal(providers.config(b.id).baseUrl,'https://b.example/v1');
});

test('Bot profile saves its name, role and model together, preserves omitted choices and can follow the default again',t=>{
  const f=fixture(t),providers=f.router(),bot=f.store.data.bots[0],other=f.store.createBot('Other','unchanged');
  const p=providers.save({name:'Alpha',baseUrl:'https://a.example/v1'}),q=providers.save({name:'Beta',baseUrl:'https://b.example/v1'});
  const defaultModel={providerId:p.id,model:'alpha',contextTokens:32000},custom={providerId:q.id,model:'beta',contextTokens:64000};providers.setDefault(defaultModel);
  const guarded:string[]=[];
  assert.equal(updateBotProfile(f.store,providers,{id:bot.id,name:' Updated ',role:'new description',model:custom},id=>guarded.push(id)),true);
  let reopened=new Store(f.dir);assert.equal(reopened.bot(bot.id).name,'Updated');assert.equal(reopened.bot(bot.id).role,'new description');assert.deepEqual(reopened.bot(bot.id).model,custom);
  assert.deepEqual(guarded,[bot.id]);assert.deepEqual(reopened.bot(other.id),other);assert.deepEqual(reopened.data.defaultModel,defaultModel);
  const unexpected=()=>{throw new Error('Unchanged models should remain editable during a task');};
  assert.equal(updateBotProfile(f.store,providers,{id:bot.id,name:'Updated again',role:'description only'},unexpected),false);
  assert.deepEqual(f.store.bot(bot.id).model,custom);
  assert.equal(updateBotProfile(f.store,providers,{id:bot.id,name:'Updated again',role:'same model',model:{...custom}},unexpected),false);
  assert.equal(updateBotProfile(f.store,providers,{id:bot.id,name:'Default again',role:'uses default',model:null},id=>guarded.push(id)),true);
  reopened=new Store(f.dir);assert.equal(reopened.bot(bot.id).model,undefined);assert.equal(reopened.modelFor(bot.id).model,'alpha');assert.deepEqual(guarded,[bot.id,bot.id]);
});

test('invalid or busy model changes leave all Bot profile fields and persisted state untouched',t=>{
  const f=fixture(t),providers=f.router(),bot=f.store.data.bots[0],p=providers.save({name:'Alpha',baseUrl:'https://a.example/v1'});
  const before=readFileSync(f.store.file,'utf8'),memory=JSON.stringify(f.store.data),model={providerId:p.id,model:'alpha',contextTokens:32000};
  const profile={id:bot.id,name:'Must not be saved',role:'nor this description',model};let guarded=0;
  const guard=()=>{guarded++;throw new Error('当前任务尚未结束');};
  assert.throws(()=>updateBotProfile(f.store,providers,{...profile,model:{...model,providerId:'missing'}},guard),/Provider 不存在/);
  assert.throws(()=>updateBotProfile(f.store,providers,{...profile,model:{...model,contextTokens:100}},guard),/上下文容量/);
  assert.throws(()=>updateBotProfile(f.store,providers,{...profile,name:' '},guard),/无效资料/);
  assert.equal(guarded,0);
  assert.throws(()=>updateBotProfile(f.store,providers,profile,guard),/当前任务/);assert.equal(guarded,1);
  assert.equal(readFileSync(f.store.file,'utf8'),before);assert.equal(JSON.stringify(f.store.data),memory);
});

test('model lists use each Provider base URL and key, coalesce requests and retain cached choices on failure',async t=>{
  const f=fixture(t),providers=f.router(),a=await f.endpoint('alpha'),b=await f.endpoint('beta');a.config.models=[{id:'z-model'},{id:'a-model'},{id:'a-model'}];
  const p=providers.save({name:'Alpha',baseUrl:a.url+'/',apiKey:'alpha-provider-secret'}),q=providers.save({name:'Beta',baseUrl:b.url,apiKey:'beta-provider-secret'});
  await Promise.all([providers.refresh(p.id),providers.refresh(p.id),providers.refresh(q.id)]);assert.equal(a.requests.length,1);assert.equal(b.requests.length,1);assert.equal(a.requests[0].key,'Bearer alpha-provider-secret');assert.equal(b.requests[0].key,'Bearer beta-provider-secret');
  assert.deepEqual(providers.list().find(item=>item.id===p.id)!.models.map(model=>model.id),['a-model','z-model']);
  a.config.listBody='not json alpha-provider-secret';const failed=await providers.refresh(p.id);assert.equal(failed.models.length,2);assert.ok(failed.modelsError);assert.ok(!JSON.stringify(failed).includes('alpha-provider-secret'));
  a.config.listBody=undefined;a.config.models=[{id:'alpha-provider-secret'}];const unsafe=await providers.refresh(p.id);assert.match(unsafe.modelsError||'',/凭据/);assert.equal(unsafe.models.length,2);
});

test('a late model-list response cannot overwrite an edited or deleted Provider',async t=>{
  const f=fixture(t),providers=f.router(),a=await f.endpoint('alpha'),b=await f.endpoint('beta');let release=()=>{};a.config.hold=new Promise<void>(resolve=>{release=resolve;});
  const p=providers.save({name:'Provider',baseUrl:a.url,apiKey:'alpha-provider-secret'}),pending=providers.refresh(p.id);await until(()=>a.requests.length===1);
  providers.save({id:p.id,name:'Provider',baseUrl:b.url,apiKey:'beta-provider-secret'});await providers.refresh(p.id);release();await pending;assert.equal(providers.list()[0].models[0].id,'beta-model');
  let releaseDelete=()=>{};b.config.hold=new Promise<void>(resolve=>{releaseDelete=resolve;});const deleted=providers.refresh(p.id);await until(()=>b.requests.length===2);providers.remove(p.id);releaseDelete();await assert.rejects(deleted,/已删除/);assert.equal(providers.list().length,0);
});

test('concurrent Bot runs send the selected model and credential to the right Provider without a global default',async t=>{
  const f=fixture(t),providers=f.router(),a=await f.endpoint('alpha'),b=await f.endpoint('beta'),botA=f.store.data.bots[0],botB=f.store.createBot('Beta','test');a.config.rejectUsage=true;
  const p=providers.save({name:'Alpha',baseUrl:a.url,apiKey:'alpha-provider-secret'}),q=providers.save({name:'Beta',baseUrl:b.url,apiKey:'beta-provider-secret'});providers.setBot(botA.id,{providerId:p.id,model:'alpha-model',contextTokens:8000});providers.setBot(botB.id,{providerId:q.id,model:'beta-model',contextTokens:64000});
  const client=new ModelClient(id=>providers.config(id),id=>providers.key(id)),harness=new Harness(f.store,{} as VmController,client,()=>{});
  await Promise.all([harness.run(botA.id,'Alpha task'),harness.run(botB.id,'Beta task')]);assert.ok(f.store.data.runs.every(run=>run.status==='completed'));
  assert.ok(a.requests.every(request=>request.body.model==='alpha-model'&&request.key==='Bearer alpha-provider-secret'));assert.ok(b.requests.every(request=>request.body.model==='beta-model'&&request.key==='Bearer beta-provider-secret'));assert.equal(a.requests.length,2);assert.equal(b.requests.length,1);assert.ok(b.requests[0].body.stream_options);
  assert.equal(f.store.data.messages.find(message=>message.botId===botA.id&&message.presentation==='answer')?.content,'alpha reply');assert.equal(f.store.data.messages.find(message=>message.botId===botB.id&&message.presentation==='answer')?.content,'beta reply');
});

test('greetings and queued emoji responses use the Bot override when the default model is unset',async t=>{
  const f=fixture(t),providers=f.router(),endpoint=await f.endpoint('beta'),bot=f.store.data.bots[0],p=providers.save({name:'Beta',baseUrl:endpoint.url,apiKey:'beta-provider-secret'});providers.setBot(bot.id,{providerId:p.id,model:'beta-model',contextTokens:32000});
  const client=new ModelClient(id=>providers.config(id),id=>providers.key(id)),greetings=new BotGreetings(f.store,client,()=>{});f.cleanup.push(()=>greetings.dispose());await greetings.greet(bot.id);assert.equal(endpoint.requests.length,1);assert.equal(f.store.data.messages[0].content,'beta reply');
  const harness=new Harness(f.store,{} as VmController,client,()=>{}),queue=new ChatPinQueue(f.store,{isRunning:id=>harness.isRunning(id),run:(...args)=>harness.run(...args)},()=>{});f.cleanup.push(async()=>{queue.dispose();await until(()=>!(queue as any).workers.size);});
  queue.pin({botId:bot.id,messageId:f.store.data.messages[0].id,emoji:'👍'});await until(()=>endpoint.requests.length===2&&!harness.busy);assert.ok(endpoint.requests.every(request=>request.body.model==='beta-model'));assert.equal(f.store.data.runs.at(-1)?.status,'completed');
});

test('direct and group context compression follow the Bot model and its context budget',async t=>{
  const f=fixture(t),providers=f.router(),a=await f.endpoint('alpha'),b=await f.endpoint('beta'),botA=f.store.data.bots[0],botB=f.store.createBot('Beta','test');
  const summary=JSON.stringify({goal:'保留任务信息',constraints:[],done:['历史已保留'],pending:[],decisions:[],failures:[],next:[]});a.config.respond=b.config.respond=async()=>answer(summary);
  const p=providers.save({name:'Alpha',baseUrl:a.url}),q=providers.save({name:'Beta',baseUrl:b.url});providers.setBot(botA.id,{providerId:p.id,model:'alpha-model',contextTokens:8000});providers.setBot(botB.id,{providerId:q.id,model:'beta-model',contextTokens:64000});
  const client=new ModelClient(id=>providers.config(id),id=>providers.key(id)),storage=new CognitiveStore(f.store),engine=new ContextEngine(storage,client,()=>{});f.cleanup.push(()=>storage.close());
  const history:WireMessage[]=Array.from({length:16},(_,index)=>({role:index%2?'assistant':'user',content:(`任务 ${index} 的文件已经读取，保留实际数据来源和检查结果。`).repeat(20)}));
  const prepared=await engine.prepare({botId:botA.id,runId:'compression',system:{role:'system',content:'继续任务'},history,tools:[],signal:new AbortController().signal,force:true});assert.equal(prepared.stats.inputBudget,contextBudget(8000).input);assert.ok(prepared.stats.compactions>0);assert.ok(a.requests.length>0);assert.equal(b.requests.length,0);
  const grouped=await prepareGroupContext(f.store,client,{botId:botB.id,key:'group-test',runId:'group-compression',system:{role:'system',content:'继续群任务'},history,tools:[],signal:new AbortController().signal,force:true});assert.ok(grouped.compactions>0);assert.ok(b.requests.every(request=>request.body.model==='beta-model'));
});

test('background learning requests are routed to the Bot selected Provider',async t=>{
  const f=fixture(t),providers=f.router(),endpoint=await f.endpoint('beta'),bot=f.store.data.bots[0],p=providers.save({name:'Beta',baseUrl:endpoint.url,apiKey:'beta-provider-secret'});providers.setBot(bot.id,{providerId:p.id,model:'beta-model',contextTokens:32000});
  const client=new ModelClient(id=>providers.config(id),id=>providers.key(id)),skills=new SkillLibrary(f.store,{dataDir:f.dir,homeDir:join(f.dir,'home'),projectDir:f.dir,configDir:join(f.dir,'config'),env:{}}),cognition=new Cognition(f.store,client,skills,()=>{},()=>false,()=>providers.secrets(),60000);f.cleanup.push(()=>cognition.close());
  const source=f.store.message(bot.id,'user','以后保留来源信息',{runId:'completed'});cognition.learning.enqueue(bot.id,'completed',{messages:[{role:'user',content:source.content}],tools:[],sourceRefs:[source.id],revision:cognition.storage.revision(bot.id),model:'beta-model'});await cognition.learning.drain();assert.equal(endpoint.requests.length,1);assert.equal(endpoint.requests[0].body.model,'beta-model');assert.equal(endpoint.requests[0].key,'Bearer beta-provider-secret');assert.equal(cognition.storage.jobs(bot.id)[0].status,'completed');
});

test('private replies and group notifications use each recipient own Provider',async t=>{
  const f=fixture(t),providers=f.router(),a=await f.endpoint('alpha'),b=await f.endpoint('beta'),botA=f.store.data.bots[0],botB=f.store.createBot('Beta','test');
  const p=providers.save({name:'Alpha',baseUrl:a.url}),q=providers.save({name:'Beta',baseUrl:b.url});providers.setBot(botA.id,{providerId:p.id,model:'alpha-model',contextTokens:32000});providers.setBot(botB.id,{providerId:q.id,model:'beta-model',contextTokens:32000});let sent=false;
  a.config.respond=async body=>{if(body.messages[0].content.includes('这是先前联络的实际回信'))return answer('Beta has replied');if(!sent){sent=true;return {content:'',finishReason:'tool_calls',calls:[{id:'peer-send',type:'function',function:{name:'bot_send_message',arguments:JSON.stringify({botId:botB.id,message:'请回复状态'})}}]};}return answer('sent');};
  const client=new ModelClient(id=>providers.config(id),id=>providers.key(id));let peers:PeerChats,groups:GroupChats;
  const harness=new Harness(f.store,{} as VmController,client,()=>{peers?.wake();groups?.wake();}),runner={isRunning:(id:string)=>harness.isRunning(id),run:(id:string,input:string,options:any)=>harness.run(id,input,options),cancel:(id:string)=>harness.cancel(id),refresh:(id:string)=>harness.refreshGroup(id)};
  peers=new PeerChats(f.store,runner,()=>{});harness.setPeerGateway(peers);peers.start();f.cleanup.push(async()=>{peers.dispose();groups?.dispose();for(const bot of f.store.data.bots)harness.cancel(bot.id);await until(()=>!harness.busy);});
  await harness.run(botA.id,'请联系 Beta');await until(()=>f.store.data.peerExchanges[0]?.status==='completed');assert.ok(b.requests.length>0);assert.equal(b.requests[0].body.model,'beta-model');
  a.requests.length=b.requests.length=0;a.config.respond=b.config.respond=async()=>answer('[群聊静默]');groups=new GroupChats(f.store,runner,()=>{});harness.setGroupGateway(groups);groups.start();groups.create({name:'不同模型的群',botIds:[botA.id,botB.id]});await until(()=>!groups.busy&&!harness.busy&&!f.store.data.groupDeliveries.some(delivery=>groupPending(delivery.status)));assert.equal(a.requests.length,1);assert.equal(b.requests.length,1);assert.equal(a.requests[0].body.model,'alpha-model');assert.equal(b.requests[0].body.model,'beta-model');
});
