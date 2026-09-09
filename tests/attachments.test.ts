import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Attachments} from '../electron/core/attachments';
import {ArtifactService} from '../electron/core/artifacts';
import {Store} from '../electron/core/store';
import {Harness} from '../electron/core/harness';
import {ChatPinQueue} from '../electron/core/chat-pins';
import {PeerChats} from '../electron/core/peer-chats';
import {GroupChats} from '../electron/core/group-chats';
import {imageContext,type Completion,type ModelClient} from '../electron/core/model';
import {estimateRequest} from '../electron/core/context-budget';
import type {VmController} from '../electron/core/vm';
import type {RunRecord,WireMessage} from '../src/shared';
import {groupPending} from '../src/group-types';
import {peerPending} from '../src/peer-types';
import {ATTACHMENT_LIMITS} from '../src/attachment-types';
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn:()=>boolean){for(let i=0;i<800;i++){if(fn())return;await delay(10);}throw Error('附件测试等待超时');}
const answer=(content:string):Completion=>({content,calls:[],finishReason:'stop'}),tool=(name:string,args:object):Completion=>({content:'',calls:[{id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}],finishReason:'tool_calls'});
const document=Buffer.from('列,数值\n咖啡,42\n','utf8'),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhK0AAAAASUVORK5CYII=','base64');
function fixture(t:test.TestContext,complete:(run:RunRecord,messages:WireMessage[])=>Completion|Promise<Completion>=()=>answer('收到附件')){
  const dir=mkdtempSync(join(tmpdir(),'aelion-attachments-')),store=new Store(dir),a=store.data.bots[0],b=store.createBot('文件伙伴','核对文件'),c=store.createBot('其他伙伴','独立工作');store.data.model.model='fixture';store.data.model.contextTokens=64000;
  const imports:Array<{botId:string;id:string;name:string;bytes:Buffer}>=[];
  const vm={state:{status:'ready'},importAttachment:async(botId:string,id:string,name:string,bytes:Buffer)=>{imports.push({botId,id,name,bytes});return {path:`/work/${botId}/attachments/${id}/${name}`,size:bytes.length};}} as unknown as VmController;
  const artifacts={read:async(botId:string,path:string)=>{assert.equal(botId,a.id);assert.equal(path,'报告.csv');return document;}} as ArtifactService;
  const attachments=new Attachments(store,vm,artifacts,(bytes,id)=>{mkdirSync(join(dir,'screenshots'),{recursive:true});writeFileSync(join(dir,'screenshots',id+'.png'),bytes);return {id,width:1,height:1};});
  let peers:PeerChats,groups:GroupChats,queue:ChatPinQueue;
  const changed=()=>{queue?.wake();peers?.wake();groups?.wake();};
  const model={complete:async(messages:WireMessage[])=>{const id=/\/work\/([a-f0-9-]+)/.exec(messages[0].content||'')?.[1],run=store.data.runs.find(run=>run.botId===id&&run.status==='running')!;assert.ok(run);return complete(run,messages);}} as unknown as ModelClient;
  const harness=new Harness(store,vm,model,changed,undefined,undefined,undefined,undefined,undefined,undefined,attachments);
  queue=new ChatPinQueue(store,{isRunning:id=>harness.isRunning(id),run:(...args)=>harness.run(...args),refresh:id=>harness.refreshInput(id)},changed,attachments);
  peers=new PeerChats(store,{isRunning:id=>harness.isRunning(id)||queue.hasPending(id),run:(...args)=>harness.run(...args),cancel:id=>harness.cancel(id)},changed,attachments);harness.setPeerGateway(peers);
  groups=new GroupChats(store,{isRunning:id=>harness.isRunning(id)||queue.hasPending(id),run:(...args)=>harness.run(...args),cancel:id=>harness.cancel(id),refresh:id=>harness.refreshGroup(id)},changed,attachments);harness.setGroupGateway(groups);
  const idle=()=>!harness.busy&&!store.data.bots.some(bot=>queue.hasPending(bot.id))&&!store.data.groupDeliveries.some(delivery=>groupPending(delivery.status))&&!store.data.peerExchanges.some(exchange=>peerPending(exchange.status));
  t.after(async()=>{queue.dispose();peers.dispose();groups.dispose();for(const bot of store.data.bots)harness.cancel(bot.id);await until(()=>!harness.busy&&!groups.busy);assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
  return {dir,store,a,b,c,attachments,imports,queue,harness,peers,groups,idle};
}

test('attachments preserve original bytes and names, and drafts cannot be read before sending',t=>{
  const fx=fixture(t),[file]=fx.attachments.importFiles({kind:'bot',id:fx.a.id},[{name:'中文 报告.csv',bytes:document}]);assert.deepEqual(fx.attachments.bytes(file.id),document);assert.equal(file.name,'中文 报告.csv');assert.equal(fx.attachments.canRead(fx.a.id,file.id),false);
  assert.throws(()=>fx.attachments.forDraft({kind:'bot',id:fx.b.id},[file.id]));fx.store.message(fx.a.id,'user','请核对',{attachments:[file]});assert.equal(fx.attachments.canRead(fx.a.id,file.id),true);assert.throws(()=>fx.attachments.read(fx.b.id,file.id));const read=fx.attachments.read(fx.a.id,file.id);assert.ok('content' in read);assert.match(read.content,/咖啡,42/);
  const restored=new Attachments(new Store(fx.dir));assert.deepEqual(restored.bytes(file.id),document);assert.match(restored.preview(file.id).content!,/数值/);
});

test('attachment-only messages invoke the Bot once with real content, without duplicate user messages',async t=>{
  const fx=fixture(t,(_run,messages)=>{assert.match([...messages].reverse().find(message=>message.role==='user')?.content||'',/咖啡,42/);assert.match([...messages].reverse().find(message=>message.role==='user')?.content||'',/附件/);return answer('文件里咖啡对应的数值是 42。');});const [file]=fx.attachments.importFiles({kind:'bot',id:fx.a.id},[{name:'数据.csv',bytes:document}]);fx.queue.send({botId:fx.a.id,message:'',attachmentIds:[file.id]});await until(fx.idle);assert.equal(fx.store.data.messages.filter(message=>message.role==='user').length,1);assert.equal(fx.store.data.messages.find(message=>message.role==='user')?.attachments?.[0].id,file.id);assert.equal(fx.store.data.runs[0].status,'completed');
});

test('multiple attached pictures remain visible alongside the latest computer observations and count toward the budget',t=>{
  const fx=fixture(t),files=fx.attachments.importFiles({kind:'bot',id:fx.a.id},[1,2,3].map(n=>({name:`图片${n}.png`,bytes:png})));fx.store.message(fx.a.id,'user','比较三张图片',{attachments:files});const input=fx.attachments.wire(fx.a.id,'比较三张图片',files),messages:WireMessage[]=[{role:'user',...input},...[1,2,3].map(n=>({role:'user' as const,content:'电脑观察',images:[{id:`screen-${n}`,width:640,height:480}]}))];
  const requests=imageContext(messages,id=>`image:${id}`),images=requests.flatMap(message=>Array.isArray(message.content)?message.content.filter(item=>item.type==='image_url'):[]);assert.equal(images.length,5);assert.ok(!JSON.stringify(requests).includes('image:screen-1'));assert.ok(JSON.stringify(requests).includes(`image:${files[0].image!.id}`));assert.equal(estimateRequest(messages,[]).imageTokens,5*1024);
});

test('file count, byte size, missing IDs and altered storage are rejected before use',t=>{
  const fx=fixture(t),scope={kind:'bot' as const,id:fx.a.id};assert.throws(()=>fx.attachments.importFiles(scope,Array.from({length:11},()=>({name:'a',bytes:Buffer.from('x')}))));assert.throws(()=>fx.attachments.importFiles(scope,[{name:'large',bytes:Buffer.alloc(ATTACHMENT_LIMITS.fileBytes+1)}]));assert.throws(()=>fx.attachments.forDraft(scope,[randomUUID()]));
  const [file]=fx.attachments.importFiles(scope,[{name:'报告.txt',bytes:Buffer.from('original')}]);writeFileSync(join(fx.dir,'attachments',file.id),'modified');assert.throws(()=>fx.attachments.bytes(file.id),/发生变化/);assert.throws(()=>fx.attachments.forDraft(scope,[file.id,file.id]));
});

test('copying a received file to the Bot computer sends the original binary bytes to that Bot workspace',async t=>{
  const fx=fixture(t),[file]=fx.attachments.importFiles({kind:'bot',id:fx.a.id},[{name:'图像.png',bytes:png}]);fx.store.message(fx.a.id,'user','处理图片',{attachments:[file]});const result=await fx.attachments.materialize(fx.a.id,file.id,new AbortController().signal);assert.equal(result.path,`/work/${fx.a.id}/attachments/${file.id}/图像.png`);assert.deepEqual(fx.imports[0].bytes,png);assert.equal(fx.imports[0].botId,fx.a.id);await assert.rejects(fx.attachments.materialize(fx.b.id,file.id,new AbortController().signal));
});

test('Bot private messages can send files and return them to the user with a real final reply',async t=>{
  const fx=fixture(t,(run,messages)=>{
    if(run.botId===fx.a.id){if(run.peerOrigin?.kind==='peer_summary'){assert.match([...messages].reverse().find(message=>message.role==='user')?.content||'',/报告.csv/);return answer('文件伙伴已经核对报告。');}return messages.some(message=>message.role==='tool')?answer('已发给文件伙伴。'):tool('bot_send_message',{botId:fx.b.id,message:'核对这份报告并返回文件',attachments:[{path:'报告.csv'}]});}
    if(run.peerOrigin?.kind==='peer_request')return tool('start_main_task',{});
    const file=fx.store.data.peerThreads[0].messages[0].attachments![0];if(!fx.store.data.runs.find(item=>item.id===run.id)?.attachments?.length)return tool('message_attach',{attachments:[{attachmentId:file.id}]});return answer('已核对，数值为 42。');
  });fx.peers.start();fx.queue.send({botId:fx.a.id,message:'请文件伙伴核对报告，并把文件给我'});await until(fx.idle);
  const thread=fx.store.data.peerThreads[0];assert.equal(thread.messages[0].attachments?.[0].name,'报告.csv');assert.equal(thread.messages.find(message=>message.kind==='reply')?.attachments?.[0].id,thread.messages[0].attachments![0].id);assert.equal(fx.attachments.canRead(fx.c.id,thread.messages[0].attachments![0].id),false);const summary=fx.store.data.messages.find(message=>message.content==='文件伙伴已经核对报告。');assert.ok(summary?.attachments?.length);assert.equal(fx.store.data.messages.some(message=>message.botId===fx.a.id&&message.content==='已核对，数值为 42。'),false);
});

test('human group attachments notify every member and follow current group membership',async t=>{
  const seen=new Set<string>(),fx=fixture(t,(run,messages)=>{if(messages.some(message=>message.content?.includes('attachmentData')&&message.content.includes('咖啡,42')))seen.add(run.botId);return answer('[群聊静默]');}),room=fx.groups.create({name:'文件协作',botIds:[fx.a.id,fx.b.id]});const [file]=fx.attachments.importFiles({kind:'group',id:room.id},[{name:'数据.csv',bytes:document}]);fx.groups.send({id:room.id,message:'',attachmentIds:[file.id]});fx.groups.start();await until(fx.idle);assert.deepEqual(seen,new Set([fx.a.id,fx.b.id]));assert.equal(fx.attachments.canRead(fx.c.id,file.id),false);fx.groups.update({id:room.id,name:room.name,botIds:[fx.a.id,fx.c.id]});assert.equal(fx.attachments.canRead(fx.c.id,file.id),true);assert.equal(fx.attachments.canRead(fx.b.id,file.id),false);
});

test('a group Bot can attach an actual output file to its final message',async t=>{
  const fx=fixture(t,(run,messages)=>{if(run.botId!==fx.a.id)return answer('[群聊静默]');return messages.some(message=>message.role==='tool')?answer('请查收核对报告。'):tool('message_attach',{attachments:[{path:'报告.csv'}]});});const room=fx.groups.create({name:'报告群',botIds:[fx.a.id,fx.b.id]});fx.groups.send({id:room.id,message:'发送核对报告'});fx.groups.start();await until(fx.idle);const result=fx.groups.read({id:room.id}).messages.find(message=>message.content==='请查收核对报告。');assert.equal(result?.attachments?.[0].name,'报告.csv');assert.deepEqual(fx.attachments.bytes(result!.attachments![0].id),document);assert.ok(fx.store.data.messages.some(message=>message.botId===fx.a.id&&message.attachments?.[0].id===result!.attachments![0].id));
});

test('reading a group attachment stays in the group and does not create work cards in the Bot main chat',async t=>{
  let attachmentId='';const fx=fixture(t,(run)=>run.botId!==fx.a.id?answer('[群聊静默]'):run.toolCalls?answer('附件是表格，数值为 42。'):tool('attachment_read',{attachmentId}));
  let collected=0;(fx.harness as any).collectArtifacts=async()=>{collected++;};
  const room=fx.groups.create({name:'附件讨论',botIds:[fx.a.id,fx.b.id]}),[file]=fx.attachments.importFiles({kind:'group',id:room.id},[{name:'资料.csv',bytes:document}]);attachmentId=file.id;
  fx.groups.send({id:room.id,message:'这是什么',attachmentIds:[file.id]});fx.groups.start();await until(fx.idle);
  const run=fx.store.data.runs.find(run=>run.botId===fx.a.id&&run.toolCalls)!;assert.ok(run);assert.equal(run.groupTask,undefined);assert.equal(fx.store.data.messages.some(message=>message.runId===run.id),false);assert.ok(fx.store.data.groupRunMessages.some(message=>message.runId===run.id&&message.tool==='attachment_read'));
  assert.ok(fx.groups.read({id:room.id}).messages.some(message=>message.content==='附件是表格，数值为 42。'));assert.equal(collected,0);const restored=new Store(fx.dir);assert.equal(restored.data.messages.some(message=>message.groupTaskSource),false);
});

test('reading then saving a group attachment promotes the actual save and keeps its evidence in the main chat',async t=>{
  let attachmentId='';const fx=fixture(t,(run)=>{if(run.botId!==fx.a.id)return answer('[群聊静默]');if(run.toolCalls===0)return tool('attachment_read',{attachmentId});if(run.toolCalls===1){assert.equal(run.groupTask,undefined);return tool('attachment_save',{attachmentId});}return answer('附件已保存到工作电脑。');});
  let collected=0;(fx.harness as any).collectArtifacts=async()=>{collected++;};
  const room=fx.groups.create({name:'保存附件',botIds:[fx.a.id,fx.b.id]}),[file]=fx.attachments.importFiles({kind:'group',id:room.id},[{name:'资料.csv',bytes:document}]);attachmentId=file.id;
  fx.groups.send({id:room.id,message:'读取并保存附件',attachmentIds:[file.id]});fx.groups.start();await until(fx.idle);
  const run=fx.store.data.runs.find(run=>run.botId===fx.a.id&&run.toolCalls)!;assert.equal(run.groupTask,true);assert.equal(fx.imports.length,1);assert.equal(collected,1);assert.equal(fx.store.data.messages.filter(message=>message.runId===run.id&&message.groupTaskSource).length,1);assert.ok(fx.store.data.messages.some(message=>message.runId===run.id&&message.tool==='attachment_save'));assert.ok(new Store(fx.dir).data.messages.some(message=>message.runId===run.id&&message.tool==='attachment_save'));
});

test('Bot group sends forward a received attachment without exposing it to nonmembers',async t=>{
  let roomId='';const fx=fixture(t,(run,messages)=>{if(run.groupOrigin)return answer('[群聊静默]');const file=fx.store.data.messages.find(message=>message.role==='user'&&message.attachments?.length)!.attachments![0];return messages.some(message=>message.role==='tool')?answer('已发到群里。'):tool('group_send_message',{groupId:roomId,message:'请看这份文件',attachments:[{attachmentId:file.id}]});});const room=fx.groups.create({name:'接收群',botIds:[fx.a.id,fx.b.id]});roomId=room.id;const [file]=fx.attachments.importFiles({kind:'bot',id:fx.a.id},[{name:'转发.csv',bytes:document}]);fx.queue.send({botId:fx.a.id,message:'把附件发到接收群',attachmentIds:[file.id]});fx.groups.start();await until(fx.idle);assert.ok(fx.groups.read({id:room.id}).messages.some(message=>message.attachments?.[0].id===file.id));assert.equal(fx.attachments.canRead(fx.b.id,file.id),true);assert.equal(fx.attachments.canRead(fx.c.id,file.id),false);
});
