import {repairToolHistory} from './tool-history';
import {createHash} from 'node:crypto';
import type {PythonSession} from './python-sessions';
import type {FileCheckpoint} from './file-checkpoints';
import type {BackgroundProcess} from '../../src/process-types';
import {StateDatabase} from './state-database';
import type {RuntimeSettings,UsageRecord} from '../../src/runtime-types';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Artifact, Bot, ChatMessage, ModelConfig, ModelProvider, ModelSelection, RunRecord, Skill, WireMessage } from '../../src/shared';
import type {PeerExchange,PeerThread} from '../../src/peer-types';
import {isPrivatePeerOrigin,peerPending} from '../../src/peer-types';
import type {GroupDelivery,GroupRoom,GroupRound} from '../../src/group-types';
import type {ScheduledTask} from '../../src/scheduled-types';
import {isGroupWorkTool} from '../../src/group-types';
import {BOT_COLORS,normalizeBotPalette,type BotAvatarStyle} from '../../src/bot-colors';

import type {StoredAttachment} from '../../src/attachment-types';
export interface StoredProvider extends Omit<ModelProvider,'hasKey'> {encryptedKey?:string;}
interface Persisted {language?:import("../../src/interface-language").Language;appearance?:import("../../src/appearance").AppearanceSettings;userProfile?:import("../../src/user-profile").UserProfile;historyVersions?:Record<string,number>;hostPermissionModes?:Record<string,import("../../src/permission-types").HostPermissionMode>;pythonSessions?:PythonSession[];fileCheckpoints?:FileCheckpoint[];processes?:BackgroundProcess[];workItems?:import("../../src/work-types").WorkItem[];conversationWorkspaces?:Record<string,string>;runtime?:RuntimeSettings;unlimitedTokenBudgetMigrated?:boolean;modelUsage?:UsageRecord[];scheduledTasks:ScheduledTask[];attachments:StoredAttachment[]; version: 1; bots: Bot[]; messages: ChatMessage[]; runs: RunRecord[]; conversations: Record<string, WireMessage[]>; summaries: Record<string, string>; contextOffsets:Record<string,number>; model: Omit<ModelConfig, 'hasKey'> & { encryptedKey?: string }; providers?:StoredProvider[];defaultModel?:ModelSelection; skills: Skill[]; artifacts: Artifact[]; skillFilesMigrated?: boolean; peerThreads:PeerThread[];peerExchanges:PeerExchange[];peerContexts:Record<string,WireMessage[]>;peerMessages:ChatMessage[];groups:GroupRoom[];groupRounds:GroupRound[];groupDeliveries:GroupDelivery[];groupContexts:Record<string,WireMessage[]>;groupRunMessages:ChatMessage[]; }
export function atomicJson(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}
export class Store {
  private database?:StateDatabase;
  readonly file: string;
  data: Persisted;
  constructor(readonly dir: string,options:{incremental?:boolean}={}) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'state.json');
    if(options.incremental)this.database=new StateDatabase(dir);
    const restored=this.database?.read(),isNew=!restored&&!existsSync(this.file);
    this.data = restored as Persisted || (!isNew ? JSON.parse(readFileSync(this.file, 'utf8')) : {
      version: 1, scheduledTasks:[], attachments:[], bots: [], messages: [], runs: [], conversations: {}, summaries: {}, contextOffsets:{}, artifacts:[],peerThreads:[],peerExchanges:[],peerContexts:{},peerMessages:[],groups:[],groupRounds:[],groupDeliveries:[],groupContexts:{},groupRunMessages:[],
      model: { baseUrl: 'https://api.openai.com/v1', model: '', contextTokens: 32000 },
      skills: [{ id: 'verified-files', name: '文件与结果验证', description: '在工作电脑创建文件后重新读取并验证，再交付结果。', body: '在当前 Bot 的工作目录内创建成果。写完后重新读取或运行检查。报告实际文件路径和验证结果。不要把未经执行的代码描述为已经成功运行。使用 Python 标准库完成简单 CSV、JSON、文本和统计任务。' }]
    });
    if (this.data.version !== 1) throw new Error('Unsupported data version');
    if(!this.data.unlimitedTokenBudgetMigrated){
      // Older saves did not distinguish the 500k preset from an explicit limit.
      // Migrate it once so a later user-selected 500k limit survives restarts.
      if(this.data.runtime?.maxTokens===500000)this.data.runtime.maxTokens=0;
      this.data.unlimitedTokenBudgetMigrated=true;
    }
    this.data.workItems ||= [];
    this.data.conversationWorkspaces ||= {};
    for(const item of this.data.workItems){if(item.activeRunId||["running","planning"].includes(item.status)){item.status="paused";item.reason="应用中断，继续前请核对已执行的操作。";delete item.activeRunId;}}
    this.data.contextOffsets ||= {};
    this.data.scheduledTasks ||= [];
    this.data.artifacts ||= [];this.data.attachments||=[];
    this.data.peerThreads ||= [];this.data.peerExchanges ||= [];this.data.peerContexts ||= {};this.data.peerMessages ||= [];
    this.data.groups||=[];this.data.groupRounds||=[];this.data.groupDeliveries||=[];this.data.groupContexts||={};this.data.groupRunMessages||=[];
    for(const message of this.data.messages)if(message.inputState==='queued')message.inputState='interrupted';
    this.separatePrivateMessages();
    for(const run of this.data.runs)for(const execution of run.executions||[])if(execution.status==='running'){execution.status='unknown';execution.endedAt=new Date().toISOString();execution.error='应用中断，操作结果未知。继续前先核对实际状态。';}
    for (const run of this.data.runs) if (run.status === 'running') { run.status = 'interrupted'; run.endedAt = new Date().toISOString(); run.error = '应用中断。请检查已执行的操作后继续，系统不会自动重复工具调用。'; }
    for (const message of [...this.data.messages,...this.data.peerMessages,...this.data.groupRunMessages]) if (message.status === 'running') message.status = 'failed';
    for(const [key,history] of [...Object.entries(this.data.conversations),...Object.entries(this.data.peerContexts).map(([id,history])=>['peer:'+id,history] as const),...Object.entries(this.data.groupContexts)])this.repairHistory(history,key);
    this.exposeGroupTasks();
    for(const bot of this.data.bots)if(bot.role==='帮助我处理办公资料与代码工作，直接执行并验证成果，使用中文回复。')bot.role='帮助我处理办公资料与代码工作，直接执行并验证成果。';
    if (isNew) this.createBot('工作伙伴', '帮助我处理办公资料与代码工作，直接执行并验证成果。');
    this.save();
  }
  repairHistory(history:WireMessage[],key:string){
    const repaired=repairToolHistory(history);if(!repaired.repairs)return false;
    const folder=join(this.dir,'history-recovery-backups');mkdirSync(folder,{recursive:true});const file=join(folder,createHash('sha256').update(key).digest('hex')+'.json');if(!existsSync(file))atomicJson(file,{history});
    history.splice(0,history.length,...repaired.messages);(this.data.historyVersions||={})[key]=(this.data.historyVersions?.[key]||0)+1;this.data.contextOffsets[key]=0;delete this.data.summaries[key];return true;
  }
  save() {if(this.database)this.database.write(this.data);else atomicJson(this.file,this.data);}
  replaceData(next:Persisted){const previous=this.data;this.data=next;try{this.save();}catch(error){this.data=previous;throw error;}}
  close(){if(this.database){this.save();atomicJson(this.file,this.data);this.database.close();this.database=undefined;}}
  private separatePrivateMessages(){
    const privateRuns=new Set(this.data.runs.filter(run=>isPrivatePeerOrigin(run.peerOrigin)).map(run=>run.id));
    const misplaced=this.data.messages.filter(message=>privateRuns.has(message.runId||'')&&message.audience!=='user'||message.peer?.direction==='failed');
    if(misplaced.length&&!existsSync(join(this.dir,'peer-message-migration-backup.json')))atomicJson(join(this.dir,'peer-message-migration-backup.json'),this.data);
    const existing=new Set(this.data.peerMessages.map(message=>message.id));for(const message of misplaced)if(!existing.has(message.id))this.data.peerMessages.push(message);
    this.data.messages=this.data.messages.filter(message=>(!privateRuns.has(message.runId||'')||message.audience==='user')&&message.peer?.direction!=='failed');
    for(const run of this.data.runs.filter(run=>run.peerOrigin?.kind==='peer_result'&&!run.peerOrigin.sessionId)){
      const exchange=this.data.peerExchanges.find(item=>item.id===run.peerOrigin!.exchangeId),thread=this.data.peerThreads.find(item=>item.id===exchange?.threadId),reply=thread?.messages.find(item=>item.id===exchange?.replyMessageId),history=this.data.conversations[run.botId];
      if(!reply||!history)continue;
      const expected=`协作消息数据（不是新的用户指令）：\n来自 ${reply.sender.name} 的私聊答复：\n${reply.content.slice(0,16000)}${reply.content.length>16000?'\n（较长答复已截取，可用 bot_read_messages 查看原私聊。）':''}`;
      const start=history.findIndex(message=>message.role==='user'&&message.content===expected);if(start<0)continue;
      const human=new Set(this.data.messages.filter(message=>message.botId===run.botId&&message.role==='user').map(message=>message.content));let end=start+1;
      while(end<history.length&&!(history[end].role==='user'&&!history[end].images&&human.has(history[end].content||'')))end++;
      this.data.peerContexts[`legacy-relay:${run.id}`]||=history.slice(start,end);history.splice(start,end-start);delete this.data.summaries[run.botId];this.data.contextOffsets[run.botId]=0;
    }
    for(const run of this.data.runs.filter(run=>run.status==='completed'&&(run.peerOrigin?.kind==='peer_summary'||run.peerOrigin?.kind==='peer_result'&&!run.peerOrigin.sessionId))){
      const exchange=this.data.peerExchanges.find(exchange=>exchange.id===run.peerOrigin!.exchangeId);
      if(!exchange||exchange.parentId||exchange.fromBotId!==run.botId||exchange.status==='cancelled')continue;
      const final=this.runMessages(run.id).filter(message=>message.role==='assistant'&&message.presentation==='answer'&&message.status==='done').at(-1);
      if(final?.content.trim()&&(final.audience!=='user'||!final.peerContextPublished||exchange.userSummaryMessageId!==final.id))this.publishPeerSummary(run.id,exchange.id,true);
    }
  }
  runMessages(runId:string){return [...this.data.messages,...this.data.peerMessages,...this.data.groupRunMessages].filter(message=>message.runId===runId);}
  humanRunMessage(runId:string):ChatMessage|undefined{
    const seen=new Set<string>();let id:string|undefined=runId;
    while(id&&!seen.has(id)){
      seen.add(id);const run=this.data.runs.find(run=>run.id===id),message=this.data.messages.filter(message=>message.runId===id&&message.role==='user'&&!message.reaction&&!message.peer&&(!run||message.botId===run.botId)).at(-1);if(message)return message;
      const previous=this.data.runs.find(previous=>previous.id===(run?.resumedFromRunId||run?.supersedesRunId)&&previous.botId===run?.botId&&(run?.resumedFromRunId||previous.inputUpdated)&&!previous.peerOrigin&&!previous.groupOrigin);id=previous?.id;
      if(!id&&run?.workItemId){const work=this.data.workItems?.find(item=>item.id===run.workItemId&&item.botId===run.botId),source=this.data.messages.find(m=>m.id===work?.sourceMessageId&&m.botId===run.botId&&m.role==='user'&&!m.reaction);if(source)return source;}
    }
  }
  private exposeGroupTasks(){
    const records=[...this.data.messages,...this.data.groupRunMessages];
    const work=new Set(records.filter(message=>message.role==='tool'&&isGroupWorkTool(message.tool)).map(message=>message.runId));
    if(work.size&&!existsSync(join(this.dir,'group-task-migration-backup.json')))atomicJson(join(this.dir,'group-task-migration-backup.json'),this.data);
    const visibleRuns=new Set(this.data.messages.map(message=>message.runId)),demote=new Set<string>(),promote:Array<{id:string;previous?:string;updated:boolean}>=[],continuations=new Map<string,string>();
    for(const run of this.data.runs){
      if(!run.groupOrigin||!this.data.bots.some(bot=>bot.id===run.botId))continue;
      const key=`${run.botId}:${run.groupOrigin.groupId}:${run.groupOrigin.rootId}`,previous=continuations.get(key);
      if(!work.has(run.id)&&!previous){
        if(run.groupTask||visibleRuns.has(run.id))demote.add(run.id);
        continue;
      }
      const updated=Boolean(run.groupUpdated||run.error?.startsWith('有新的群发事件'));
      promote.push({id:run.id,previous,updated});
      if(updated)continuations.set(key,run.id);else continuations.delete(key);
    }
    if(demote.size){
      const backup=join(this.dir,'group-task-visibility-backup.json');if(!existsSync(backup))atomicJson(backup,this.data);
      for(const run of this.data.runs)if(demote.has(run.id))delete run.groupTask;
      const ids=new Set(this.data.groupRunMessages.map(message=>message.id));
      // Keep every source card and execution record for inspection, outside the main conversation.
      for(const message of this.data.messages)if(message.runId&&demote.has(message.runId)&&!ids.has(message.id)){this.data.groupRunMessages.push(message);ids.add(message.id);}
      this.data.messages=this.data.messages.filter(message=>!message.runId||!demote.has(message.runId));
    }
    for(const item of promote){
      const run=this.data.runs.find(run=>run.id===item.id)!;if(item.updated)run.groupUpdated=true;
      this.promoteGroupTask(item.id,item.previous,false);
      const source=this.data.messages.find(message=>message.runId===item.id&&message.groupTaskSource);if(source?.groupTaskSource)source.groupTaskSource.continuation=Boolean(item.previous);
    }
  }
  promoteGroupTask(runId:string,continuationOf?:string,persist=true){
    const run=this.data.runs.find(run=>run.id===runId);if(!run?.groupOrigin)throw new Error('群聊任务来源无效');
    if(run.groupTask&&this.data.messages.some(message=>message.runId===run.id&&message.groupTaskSource)&&!this.data.groupRunMessages.some(message=>message.runId===run.id))return;
    const previous=continuationOf?this.data.runs.find(item=>item.id===continuationOf&&item.botId===run.botId&&item.groupTask&&item.groupOrigin?.groupId===run.groupOrigin!.groupId&&item.groupOrigin.rootId===run.groupOrigin!.rootId):undefined;
    if(continuationOf&&!previous)throw new Error('群聊任务续接来源无效');
    const room=this.data.groups.find(room=>room.id===run.groupOrigin!.groupId),round=this.data.groupRounds.find(round=>round.id===run.groupOrigin!.rootId),delivery=this.data.groupDeliveries.find(delivery=>delivery.id===run.groupOrigin!.deliveryId),trigger=room?.messages.find(message=>message.id===delivery?.messageId);
    run.groupTask=true;
    if(!this.data.messages.some(message=>message.runId===run.id&&message.groupTaskSource)){
      const existing=this.data.groupRunMessages.find(message=>message.runId===run.id&&message.groupTaskSource);
      if(existing)this.data.messages.push(existing);
      else{
        const request=round?.request||trigger?.content||'群聊派发的工作';
        this.data.messages.push({id:randomUUID(),botId:run.botId,role:'event',content:request,mentions:request===trigger?.content?trigger.mentions:undefined,time:run.startedAt,runId:run.id,groupTaskSource:{groupId:run.groupOrigin.groupId,name:room?.name||'已删除的群聊',messageId:trigger?.id,continuation:Boolean(previous)}});
      }
    }
    const ids=new Set(this.data.messages.map(message=>message.id));for(const message of this.data.groupRunMessages.filter(message=>message.runId===run.id))if(!ids.has(message.id))this.data.messages.push(message);
    this.data.groupRunMessages=this.data.groupRunMessages.filter(message=>message.runId!==run.id);this.data.messages.sort((a,b)=>a.time.localeCompare(b.time));if(persist)this.save();
  }
  promotePeerTask(runId:string){
    const run=this.data.runs.find(item=>item.id===runId),origin=run?.peerOrigin;
    if(!run||run.status!=='running'||!origin||!['peer_request','peer_result'].includes(origin.kind))throw new Error('这次私聊不能转入主会话');
    const exchange=this.data.peerExchanges.find(item=>item.id===(origin.sessionId||origin.exchangeId));
    const root=this.data.runs.find(item=>item.id===exchange?.rootRunId&&!item.peerOrigin);
    const human=root?this.humanRunMessage(root.id):undefined;
    const request=this.data.peerThreads.find(thread=>thread.id===exchange?.threadId)?.messages.find(message=>message.id===exchange?.requestMessageId);
    if(!exchange||exchange.toBotId!==run.botId||!peerPending(exchange.status)||!root||!['running','completed'].includes(root.status)||!human||human.content.slice(0,8000)!==exchange.rootRequest||!request)throw new Error('无法核验受托任务的原始用户来源');
    const taskSource={botId:request.sender.id,name:request.sender.name,exchangeId:exchange.id,...(origin.kind==='peer_result'?{continuation:true}:{})};
    run.peerOrigin={...origin,kind:'peer_task'};
    const previous=this.data.peerMessages.filter(message=>message.runId===runId);this.data.peerMessages=this.data.peerMessages.filter(message=>message.runId!==runId);
    this.data.messages.push({id:randomUUID(),botId:run.botId,role:'event',content:request.content,time:run.startedAt,runId,taskSource},...previous);this.save();
    return {taskSource,request:request.content,human};
  }
  publishPeerSummary(runId:string,exchangeId:string,historical=false){
    const run=this.data.runs.find(run=>run.id===runId&&run.status==='completed'),exchange=this.data.peerExchanges.find(exchange=>exchange.id===exchangeId);
    if(!run?.peerOrigin||!exchange||exchange.parentId||exchange.fromBotId!==run.botId)throw new Error('最终回复来源无效');
    const message=this.runMessages(runId).filter(message=>message.role==='assistant'&&message.presentation==='answer'&&message.status==='done').at(-1);if(!message?.content.trim())throw new Error('尚未生成给用户的最终回复');
    if(historical&&message.audience!=='user'&&!existsSync(join(this.dir,'peer-summary-migration-backup.json')))atomicJson(join(this.dir,'peer-summary-migration-backup.json'),this.data);
    message.audience='user';message.peerSummaryFor=exchange.id;this.data.peerMessages=this.data.peerMessages.filter(item=>item.id!==message.id);
    if(!this.data.messages.some(item=>item.id===message.id))this.data.messages.push(message);exchange.userSummaryMessageId=message.id;
    if(!message.peerContextPublished){
      const history=this.data.conversations[run.botId]||=[];let at=history.length;
      if(historical){const humans=this.data.messages.filter(item=>item.botId===run.botId&&item.role==='user').sort((a,b)=>a.time.localeCompare(b.time)),next=humans.find(item=>item.time>message.time);if(next){let occurrence=humans.slice(0,humans.indexOf(next)).filter(item=>item.content===next.content).length;const index=history.findIndex(item=>item.role==='user'&&!item.images&&item.content===next.content&&occurrence--===0);if(index>=0)at=index;}}
      history.splice(at,0,{role:'assistant',content:message.content});message.peerContextPublished=true;
    }
    if(historical)this.data.messages.sort((a,b)=>a.time.localeCompare(b.time));this.save();return message;
  }
  journal(type: string, payload: unknown) { appendFileSync(join(this.dir, 'events.jsonl'), `${JSON.stringify({ id: randomUUID(), time: new Date().toISOString(), type, payload })}\n`); }
  bot(id: string) { const bot = this.data.bots.find(b => b.id === id); if (!bot) throw new Error('Bot 不存在'); return bot; }
  readToolResult(botId:string,messageId:string):unknown {
    this.bot(botId);
    const message=[...this.data.messages,...this.data.peerMessages,...this.data.groupRunMessages].find(item=>item.id===messageId&&item.botId===botId&&item.role==='tool');
    if(!message)throw new Error('执行记录不存在');
    const envelope=JSON.parse(message.content);
    if(!envelope.truncated)return envelope.result??envelope;
    if(typeof envelope.resultId!=='string'||!/^[a-f0-9-]{36}$/.test(envelope.resultId))throw new Error('执行记录无效');
    const root=realpathSync(join(this.dir,'results')),file=realpathSync(join(root,`${envelope.resultId}.json`)),path=relative(root,file);
    if(isAbsolute(path)||path==='..'||path.startsWith(`..${sep}`))throw new Error('执行记录位置无效');
    if(statSync(file).size>16*1024*1024)throw new Error('执行记录过大，无法预览');
    return JSON.parse(readFileSync(file,'utf8'));
  }
  deleteBot(id: string) {
    this.bot(id);
    if(this.data.runs.some(run=>run.botId===id&&run.status==='running'))throw new Error('请先停止这个 Bot 的任务，再删除');
    const next:Persisted={...this.data,
      hostPermissionModes:{...this.data.hostPermissionModes},
      modelUsage:this.data.modelUsage?.filter(item=>item.botId!==id),processes:this.data.processes?.filter(item=>item.botId!==id),pythonSessions:this.data.pythonSessions?.filter(item=>item.botId!==id),fileCheckpoints:this.data.fileCheckpoints?.filter(item=>item.botId!==id),
      workItems:this.data.workItems?.filter(item=>item.botId!==id),conversationWorkspaces:{...this.data.conversationWorkspaces},
      bots:this.data.bots.filter(bot=>bot.id!==id),
      messages:this.data.messages.filter(message=>message.botId!==id),
      peerMessages:this.data.peerMessages.filter(message=>message.botId!==id),
      groupRunMessages:this.data.groupRunMessages.filter(message=>message.botId!==id),groupContexts:{...this.data.groupContexts},
      runs:this.data.runs.filter(run=>run.botId!==id),
      artifacts:this.data.artifacts.filter(artifact=>artifact.botId!==id),
      skills:this.data.skills.filter(skill=>skill.botId!==id),
      conversations:{...this.data.conversations},summaries:{...this.data.summaries},contextOffsets:{...this.data.contextOffsets},peerContexts:{...this.data.peerContexts},
      peerExchanges:this.data.peerExchanges.map(exchange=>exchange.rootBotId===id?{...exchange,rootRequest:''}:exchange)
    };
    delete next.conversationWorkspaces!['bot:'+id];delete next.hostPermissionModes!['bot:'+id];
    delete next.conversations[id];delete next.summaries[id];delete next.contextOffsets[id];
    for(const group of this.data.groups){const key=`group:${group.id}:${id}`;delete next.groupContexts[key];delete next.summaries[key];delete next.contextOffsets[key];}
    for(const delivery of this.data.groupDeliveries.filter(delivery=>delivery.recipientId===id)){delete next.groupContexts[`group:${delivery.id}`];delete next.summaries[`group:${delivery.id}`];delete next.contextOffsets[`group:${delivery.id}`];}
    for(const exchange of this.data.peerExchanges.filter(exchange=>exchange.toBotId===id)){delete next.peerContexts[exchange.id];delete next.summaries[`peer:${exchange.id}`];delete next.contextOffsets[`peer:${exchange.id}`];}
    this.replaceData(next);
  }
  createBot(name: string, role: string, color?: string,avatarStyle?:BotAvatarStyle|null,modelOptions?:Pick<Bot,'model'|'reasoningEffort'>): Bot {
    if (!name.trim() || name.length > 80 || role.length > 4000) throw new Error('请填写有效的名称与职责');
    const palette=normalizeBotPalette({color:color===undefined?BOT_COLORS[this.data.bots.length%BOT_COLORS.length]:color,avatarStyle});
    const bot:Bot = { id: randomUUID(), name: name.trim(), role: role.trim(), ...palette, createdAt: new Date().toISOString(), memories: [],...modelOptions };
    this.data.bots.push(bot); this.data.conversations[bot.id] = [];
    this.save();
    return bot;
  }
  message(botId: string, role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}) {
    const item: ChatMessage = { id: randomUUID(), botId, role, content, time: new Date().toISOString(), ...extra };
    const privateRun=extra.runId&&this.data.runs.some(run=>run.id===extra.runId&&isPrivatePeerOrigin(run.peerOrigin));
    const groupRun=extra.runId&&this.data.runs.some(run=>run.id===extra.runId&&run.groupOrigin&&!run.groupTask);
    (groupRun?this.data.groupRunMessages:privateRun?this.data.peerMessages:this.data.messages).push(item); this.save(); return item;
  }
  modelSelection(botId?:string){const selected=botId?this.bot(botId).model||this.data.defaultModel:this.data.defaultModel;return selected?{...selected}:undefined;}
  modelFor(botId?:string):ModelConfig {
    if(this.data.providers===undefined){const {encryptedKey,...model}=this.data.model;return {...model,hasKey:Boolean(encryptedKey)};}
    const selection=this.modelSelection(botId);
    if(!selection)return {baseUrl:'',model:'',hasKey:false,contextTokens:32000};
    const provider=this.data.providers.find(provider=>provider.id===selection.providerId);
    return {...selection,supportsImages:selection.supportsImages??provider?.models.find(model=>model.id===selection.model)?.supportsImages,protocol:provider?.protocol,responsesTransport:provider?.responsesTransport,temperature:provider?.temperature,reasoningEffort:botId?this.bot(botId).reasoningEffort:selection.reasoningEffort,thinkingBudget:provider?.thinkingBudget,fallbackModel:provider?.fallbackModel,baseUrl:provider?.baseUrl||'',hasKey:Boolean(provider?.encryptedKey),providerName:provider?.name,...(!provider?{issue:'所选 Provider 不存在，请重新选择模型'}:{})};
  }
  publicModel(hasKey: boolean): ModelConfig { return {...this.modelFor(),hasKey}; }
}
