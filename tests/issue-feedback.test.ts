import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,realpathSync,rmSync,readdirSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {repairToolHistory} from '../electron/core/tool-history';
import {protocolRequest} from '../electron/core/model-protocol';
import {ModelClient} from '../electron/core/model';
import {ModelProviders} from '../electron/core/model-providers';
import {BotGreetings} from '../electron/core/bot-greetings';
import {Harness} from '../electron/core/harness';
import {imageCapability,ModelImageUnsupportedError} from '../electron/core/model-vision';
import {Store} from '../electron/core/store';
import {CognitiveStore} from '../electron/core/cognitive-store';
import {ContextEngine} from '../electron/core/context-engine';
import {rememberPublished,groupHistory,groupContextKey} from '../electron/core/group-history';
import {normalizeUserProfile,userProfilePrompt} from '../src/user-profile';
import {friendlyError} from '../src/activity';
import type {ModelConfig,WireMessage} from '../src/shared';
const cfg:ModelConfig={model:'test',baseUrl:'http://localhost/v1',protocol:'chat',hasKey:false,contextTokens:64000};
const call=(id:string)=>({id,type:'function' as const,function:{name:'read',arguments:'{}'}});
const reply=(id:string):WireMessage=>({role:'tool',tool_call_id:id,content:JSON.stringify({resultId:id,result:{ok:true}})});
function assertPairs(messages:WireMessage[]){for(let i=0;i<messages.length;i++){const calls=messages[i].tool_calls;if(!calls?.length)continue;const expected=new Set(calls.map(call=>call.id));for(let j=0;j<calls.length;j++){const next=messages[i+j+1];assert.equal(next?.role,'tool');assert.ok(expected.delete(next.tool_call_id!));}assert.equal(expected.size,0);}}
function fixture(t:test.TestContext){const parent=realpathSync(tmpdir()),dir=mkdtempSync(join(parent,'aelion-issues-')),store=new Store(dir),cleanup:Array<()=>void>=[];store.data.model.model='test';store.data.model.contextTokens=64000;t.after(()=>{for(const close of cleanup)close();store.close();assert.equal(dirname(resolve(dir)),parent);rmSync(dir,{recursive:true,force:true});});return {dir,store,bot:store.data.bots[0],cleanup};}

test('tool results remain adjacent when group progress/chat events arrive inside a call batch',()=>{
 const raw:WireMessage[]=[{role:'user',content:'task'},{role:'assistant',content:'working',tool_calls:[call('a'),call('b')]},{role:'assistant',content:'published progress'},{role:'user',content:'new group event'},reply('b'),reply('a')],before=JSON.stringify(raw),repaired=repairToolHistory(raw);
 assertPairs(repaired.messages);assert.equal(JSON.stringify(raw),before);assert.deepEqual(repaired.messages.slice(-2).map(message=>message.content),['published progress','new group event']);assert.equal(repaired.messages[2].tool_call_id,'b');assert.equal(repairToolHistory(repaired.messages).repairs,0);
 for(const protocol of ['chat','responses','anthropic','gemini'] as const){const request=protocolRequest({...cfg,protocol},raw,[],4096,'',()=> '');assert.ok(request.historyRepairs>0);}
});
test('missing and orphan tool replies recover as unknown without invented successful execution',()=>{
 const repaired=repairToolHistory([{role:'assistant',content:null,tool_calls:[call('a'),call('b')]},reply('a'),{role:'user',content:'continue'},{role:'assistant',content:null,tool_calls:[call('c')]},reply('c'),reply('orphan')]);assertPairs(repaired.messages);assert.match(repaired.messages.find(message=>message.tool_call_id==='b')!.content!,/unknown/);assert.equal(repaired.messages.at(-1)?.role,'assistant');assert.match(repaired.messages.at(-1)!.content!,/工具历史参考/);
 const bad=repairToolHistory([{role:'assistant',content:null,tool_calls:[call('same'),call('same')]},reply('same')]);assert.ok(bad.messages.every(message=>!message.tool_calls?.length&&message.role!=='tool'));
});
test('successful request baselines do not synthesize replies for newly returned tool calls',()=>{
 const history:WireMessage[]=[{role:'user',content:'hi'},{role:'assistant',content:null,tool_calls:[call('new')]}];const request=protocolRequest(cfg,history,[],4096,'',()=>'',true,undefined,undefined,true);assert.equal((request.body as any).messages.length,2);assert.equal(request.historyRepairs,0);
});
test('published group progress waits until the pending tool batch has finished',t=>{
 const {store,bot}=fixture(t),groupId='group',message={id:'p',seq:2,groupId,sender:{kind:'bot',id:bot.id,name:bot.name,color:bot.color},kind:'progress',content:'working',time:new Date().toISOString()} as any;
 store.data.groups.push({id:groupId,messages:[message]} as any);const history:WireMessage[]=[{role:'user',content:'request',groupMessageId:'first'},{role:'assistant',content:null,tool_calls:[call('a')]}];store.data.groupContexts[groupContextKey(groupId,bot.id)]=history;
 rememberPublished(store,message);assert.equal(history.length,2);history.push(reply('a'));groupHistory(store,groupId,bot.id);assertPairs(history);assert.equal(history.at(-1)?.groupMessageId,'p');
});
test('existing corrupt histories are backed up, repaired and do not reuse obsolete summary offsets',async t=>{
 const f=fixture(t),history:WireMessage[]=[{role:'user',content:'task'},{role:'assistant',content:null,tool_calls:[call('a')]},{role:'assistant',content:'progress'},reply('a')];f.store.data.conversations[f.bot.id]=history;
 const storage=new CognitiveStore(f.store);f.cleanup.push(()=>storage.close());storage.commitEpoch({botId:f.bot.id,runId:'old',expectedRevision:0,from:0,through:99,summary:'obsolete',anchors:[],sourceHash:'old',stats:{}});
 assert.equal(f.store.repairHistory(history,f.bot.id),true);assertPairs(history);assert.equal(readdirSync(join(f.dir,'history-recovery-backups')).length,1);f.store.data.runs.push({id:'new',botId:f.bot.id,startedAt:new Date().toISOString(),status:'running',modelCalls:0,toolCalls:0});
 const engine=new ContextEngine(storage,{complete:async()=>{throw Error('no compaction expected');}} as any,()=>{}),prepared=await engine.prepare({botId:f.bot.id,runId:'new',system:{role:'system',content:'rules'},history,tools:[],signal:new AbortController().signal});assert.equal(prepared.head.revision,0);assert.ok(!JSON.stringify(prepared.messages).includes('obsolete'));
});
test('an unsupported current image gives a useful error, while later text messages omit only historical images',async t=>{
 const requests:any[]=[];const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);requests.push(body);const images=body.messages.some((message:any)=>Array.isArray(message.content)&&message.content.some((part:any)=>part.type==='image_url'));res.setHeader('content-type','application/json');if(images){res.statusCode=404;res.end(JSON.stringify({error:{message:'No endpoints found that support image input'}}));}else res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'hello'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:2}}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});const config={...cfg,baseUrl:`http://127.0.0.1:${(server.address() as any).port}/v1`},client=new ModelClient(()=>config,()=>'',()=> 'data:image/png;base64,test');t.after(()=>client.dispose());
 const image:WireMessage={role:'user',content:'image task',images:[{id:'image',width:10,height:10}]};await assert.rejects(client.complete([image],[],new AbortController().signal,undefined,{requiredImageIds:['image']}),/不支持图片/);
 const history=[image,{role:'user' as const,content:'hello'}],snapshot=JSON.stringify(history);const result=await client.complete(history,[],new AbortController().signal,undefined,{requiredImageIds:[]});assert.equal(result.content,'hello');assert.equal(result.inputImagesOmitted,true);assert.equal(JSON.stringify(history),snapshot);assert.ok(requests.at(-1).messages.every((message:any)=>typeof message.content==='string'));assert.match(JSON.stringify(requests.at(-1)),/不能声称已查看/);
 const fresh=new ModelClient(()=>config,()=>'',()=> 'data:image/png;base64,test');t.after(()=>fresh.dispose());const recovered=await fresh.complete(history,[],new AbortController().signal,undefined,{requiredImageIds:[]});assert.equal(recovered.content,'hello');assert.equal(requests.length,4,'a fresh client retries an explicit image rejection only once without old images');
});
test('model image capabilities and actionable notices do not depend on model name guesses',()=>{
 assert.equal(imageCapability({architecture:{input_modalities:['text']}}),false);assert.equal(imageCapability({architecture:{input_modalities:['text','image']}}),true);assert.equal(imageCapability({id:'vision-in-name'}),undefined);
 const error=new ModelImageUnsupportedError('model');assert.equal(friendlyError(error.message).settings,'model');assert.match(friendlyError(error.message).title,/图片/);assert.match(friendlyError("An assistant message with 'tool_calls' must be followed by tool messages").title,/记录/);
});
test('personal identity persists and is reference information rather than an operation grant',t=>{
 const {store}=fixture(t);store.data.userProfile=normalizeUserProfile({displayName:' Wendy ',role:'产品经理',background:'负责桌面工具'});store.save();assert.equal(store.data.userProfile.displayName,'Wendy');const reopened=new Store(store.dir);assert.equal(reopened.data.userProfile?.displayName,'Wendy');reopened.close();const prompt=userProfilePrompt(store.data.userProfile);assert.match(prompt,/Wendy/);assert.match(prompt,/不是新的任务或操作授权/);assert.match(prompt,/@用户/);assert.throws(()=>normalizeUserProfile({displayName:'a'.repeat(81)}));assert.throws(()=>normalizeUserProfile({displayName:'x',admin:true}));assert.match(userProfilePrompt(normalizeUserProfile({})),/清空个人资料/);assert.equal(userProfilePrompt(), '');
});
test('greetings and ongoing conversations receive current personal identity, including explicit clearing',async t=>{
 const {store,bot}=fixture(t),captured:WireMessage[][]=[];store.data.userProfile=normalizeUserProfile({displayName:'Wendy',role:'产品经理',background:'桌面软件'});
 const model={complete:async(messages:WireMessage[])=>{captured.push(structuredClone(messages));return {content:'你好。',calls:[],finishReason:'stop'};}} as unknown as ModelClient;
 const greetings=new BotGreetings(store,model,()=>{});await greetings.greet(bot.id);assert.match(captured[0][0].content||'',/Wendy/);greetings.dispose();
 const harness=new Harness(store,{} as any,model,()=>{});t.after(()=>harness.disposeTools());await harness.run(bot.id,'你好');assert.ok(captured.at(-1)!.some(message=>message.content?.includes('桌面软件')));
 store.data.userProfile=normalizeUserProfile({});await harness.run(bot.id,'再聊聊');const latest=captured.at(-1)!,clear=latest.findIndex(message=>message.content?.includes('人类已在设置中清空个人资料'));assert.ok(clear>=0);assert.ok(clear>latest.findIndex(message=>message.content?.includes('Wendy')));
});
test('provider model metadata detects image support and a model-specific override is preserved',async t=>{
 const f=fixture(t),server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'text-model',architecture:{input_modalities:['text']}},{id:'vision-model',architecture:{input_modalities:['text','image']}}]}));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
 const providers=new ModelProviders(f.store,{encrypt:value=>value,decrypt:value=>value},()=>{});t.after(()=>providers.dispose());const provider=providers.save({name:'metadata',baseUrl:`http://127.0.0.1:${(server.address() as any).port}/v1`});await providers.refresh(provider.id);
 providers.setBot(f.bot.id,{providerId:provider.id,model:'text-model',contextTokens:8000});assert.equal(providers.config(f.bot.id).supportsImages,false);providers.setBot(f.bot.id,{providerId:provider.id,model:'text-model',contextTokens:8000,supportsImages:true});assert.equal(providers.config(f.bot.id).supportsImages,true);assert.throws(()=>providers.setBot(f.bot.id,{providerId:provider.id,model:'text-model',contextTokens:8000,supportsImages:'yes'}));
});
