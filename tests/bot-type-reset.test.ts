import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {Store} from '../electron/core/store';
import {updateBotProfile} from '../electron/core/bot-profile';
import {DesignStore} from '../electron/core/design-store';
import {DesignSystems} from '../electron/core/design-systems';
import {CognitiveStore} from '../electron/core/cognitive-store';
import {Harness} from '../electron/core/harness';
import {BotRuntime} from '../electron/core/bot-runtime';
import {groupHistory} from '../electron/core/group-history';
function fixture(t:any){const root=mkdtempSync(join(tmpdir(),'aelion-type-reset-')),store=new Store(root),bot=store.data.bots[0];store.data.model.model='fixture';t.after(()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));rmSync(root,{recursive:true,force:true});});return {root,store,bot};}
const change=(bot:any,extra:any={})=>({id:bot.id,name:bot.name,role:bot.role,type:'designer' as const,expectedType:'general' as const,confirmContextReset:true,...extra});
test('switch requires explicit confirmation and the original type, with no partial mutation',t=>{
 const {store,bot}=fixture(t);store.message(bot.id,'user','keep me');bot.memories=['keep memory'];const before=JSON.stringify(store.data);
 assert.throws(()=>updateBotProfile(store,{} as any,change(bot,{confirmContextReset:false})),/确认/);
 assert.throws(()=>updateBotProfile(store,{} as any,change(bot,{expectedType:'designer'})),/确认/);
 assert.throws(()=>updateBotProfile(store,{selection:()=>{throw Error('invalid model');}} as any,change(bot,{model:{}})),/invalid model/);
 assert.equal(JSON.stringify(store.data),before);
 updateBotProfile(store,{} as any,change(bot,{type:'general',confirmContextReset:false}));assert.equal(store.bot(bot.id).memories[0],'keep memory');assert.equal(store.data.messages.length,1);
});
test('confirmed switch clears owned context while retaining files, other Bots and shared conversations',t=>{
 const {store,bot}=fixture(t),other=store.createBot('Other',''),old='2020-01-01T00:00:00.000Z';bot.memories=['old preference'];store.message(bot.id,'user','OLD_PRIVATE');store.message(other.id,'user','OTHER_PRIVATE');store.data.conversations[bot.id]=[{role:'user',content:'OLD_HISTORY'}];store.data.conversations[other.id]=[{role:'user',content:'OTHER_HISTORY'}];store.data.summaries[bot.id]='OLD_SUMMARY';
 store.data.runs.push({id:'old-run',botId:bot.id,status:'completed',engine:'general',startedAt:old,modelCalls:1,toolCalls:1});store.data.workItems!.push({id:'old-work',botId:bot.id} as any);
 store.data.peerExchanges.push({id:'exchange',fromBotId:other.id,toBotId:bot.id,rootBotId:other.id,status:'completed'} as any);store.data.peerContexts.exchange=[{role:'user',content:'OLD_PEER_CONTEXT'}];store.data.summaries['peer:exchange']='PEER_SUMMARY';
 store.data.groups.push({id:'room',name:'Room',members:[{id:bot.id,joinedAt:old},{id:other.id,joinedAt:old}],messages:[{id:'old-group',groupId:'room',seq:1,sender:{kind:'user',id:'user',name:'You'},kind:'message',content:'OLD_SHARED',time:old}],createdAt:old} as any);
 store.data.groupContexts['group:room:'+bot.id]=[{role:'user',content:'OLD_GROUP_CONTEXT'}];store.data.artifacts.push({botId:bot.id,path:'report.csv',runId:'old-run'} as any);
 const cognition=new CognitiveStore(store);cognition.contextState(bot.id,'private','example','OLD_CACHE');
 updateBotProfile(store,{} as any,change(bot));cognition.clearBot(bot.id);assert.equal(cognition.contextState(bot.id,'private','example'),undefined);assert.equal(cognition.memories(bot.id).length,0);cognition.close();
 assert.equal(store.bot(bot.id).type,'designer');assert.deepEqual(store.bot(bot.id).memories,[]);assert.equal(store.data.conversations[bot.id],undefined);assert.equal(store.data.summaries[bot.id],undefined);assert.equal(store.data.peerContexts.exchange,undefined);assert.equal(store.data.groupContexts['group:room:'+bot.id],undefined);assert.equal(store.data.runs.length,0);assert.equal(store.data.workItems!.length,0);
 assert.equal(store.data.messages.length,1);assert.equal(store.data.messages[0].botId,other.id);assert.equal(store.data.artifacts[0].path,'report.csv');assert.equal(store.data.groups[0].members.length,2);assert.equal(store.data.groups[0].messages.length,1);assert.equal(groupHistory(store,'room',bot.id).length,0);assert.equal(groupHistory(store,'room',other.id).length,1);
 const loaded=new Store(store.dir);assert.equal(loaded.bot(bot.id).type,'designer');assert.equal(loaded.data.conversations[bot.id],undefined);
});
test('pending private and group work prevents context destruction',t=>{
 const {store,bot}=fixture(t);store.data.peerExchanges.push({id:'pending',fromBotId:bot.id,toBotId:'other',status:'waiting'} as any);assert.throws(()=>updateBotProfile(store,{} as any,change(bot)),/协作/);store.data.peerExchanges=[];
 store.data.groupDeliveries.push({id:'pending',recipientId:bot.id,status:'queued'} as any);assert.throws(()=>updateBotProfile(store,{} as any,change(bot)),/协作/);assert.equal(store.bot(bot.id).type,'general');
});
test('design context reset removes sessions and histories only for the selected Bot',t=>{
 const {store,bot}=fixture(t);bot.type='designer';const other=store.createBot('Other designer','',undefined,undefined,{type:'designer'}),designs=new DesignStore(store,new DesignSystems(resolve('assets/design-systems')));
 const a=designs.create({botId:bot.id,kind:'ppt',brief:'Old PPT'}),b=designs.create({botId:other.id,kind:'prototype',brief:'Other UI'});designs.history(bot.id,a.origin,a.id).history.messages.push({role:'user',content:'OLD'});designs.history(other.id,b.origin,b.id).history.messages.push({role:'user',content:'OTHER'});designs.save();designs.clearBot(bot.id);
 assert.equal(designs.data.sessions.length,1);assert.equal(designs.data.sessions[0].id,b.id);assert.ok(!Object.keys(designs.data.histories).some(k=>k.startsWith('designer:'+bot.id+':')));assert.equal(new DesignStore(store,designs.systems).data.sessions.length,1);
});
test('general Bot receives ordinary tools on its first call even for a PPT request',async t=>{
 const {store,bot}=fixture(t);let calls=0;const general=new Harness(store,{} as any,{complete:async(_messages:any,tools:any[])=>{calls++;assert.ok(tools.some(t=>t.function.name==='computer_execute'));assert.ok(!tools.some(t=>['continue_general','design_handoff'].includes(t.function.name)));return {content:'请提供材料。',calls:[],finishReason:'stop'};}} as any,()=>{});t.after(()=>general.disposeTools());
 await new BotRuntime(store,general,{streams:{snapshot:()=>[]},busy:false,isRunning:()=>false,run:async()=>{throw Error('must not switch');}} as any,()=>{}).run(bot.id,'收集行业数据，然后做 PPT');assert.equal(calls,1);assert.equal(store.bot(bot.id).type,'general');assert.equal(store.data.runs[0].status,'completed');
});
test('private and group requests preserve the recipient type and collaboration origin',async t=>{
 const {store,bot}=fixture(t),designer=store.createBot('Designer','',undefined,undefined,{type:'designer'}),seen:any[]=[];
 const engine=(kind:string)=>({streams:{snapshot:()=>[]},busy:false,isRunning:()=>false,run:async(id:string,text:string,options:any)=>seen.push({kind,id,text,options})});
 const runtime=new BotRuntime(store,engine('general') as any,engine('designer') as any,()=>{});
 const peer={peerOrigin:{kind:'peer_request' as const,exchangeId:'exchange'}},group={groupOrigin:{groupId:'group',rootId:'root',deliveryId:'delivery'}};
 for(const recipient of [bot,designer]){await runtime.run(recipient.id,'private work',peer);await runtime.run(recipient.id,'group work',group);}
 assert.deepEqual(seen.map(x=>x.kind),['general','general','designer','designer']);assert.deepEqual(seen[2].options.peerOrigin,peer.peerOrigin);assert.deepEqual(seen[3].options.groupOrigin,group.groupOrigin);assert.equal(store.bot(bot.id).type,'general');assert.equal(store.bot(designer.id).type,'designer');
});

test('restart completes a confirmed reset if the process stopped before sidecar cleanup',t=>{
 const {store,bot}=fixture(t);bot.memories=['old remembered preference'];const cognitive=new CognitiveStore(store);cognitive.contextState(bot.id,'main','stale','private cache');cognitive.close();
 bot.type='designer';const systems=new DesignSystems(resolve('assets/design-systems')),designs=new DesignStore(store,systems);designs.create({botId:bot.id,kind:'ppt',brief:'Old presentation'});
 updateBotProfile(store,{} as any,change(bot,{type:'general',expectedType:'designer'}));
 const restarted=new Store(store.dir),cleanCognition=new CognitiveStore(restarted);assert.equal(cleanCognition.memories(bot.id).length,0);assert.equal(cleanCognition.contextState(bot.id,'main','stale'),undefined);cleanCognition.close();assert.equal(new DesignStore(restarted,systems).data.sessions.length,0);
});
