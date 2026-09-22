import {createDesignerDirectory} from './designer-files';
import {sameOpenDesignComment} from '../../src/designer-canvas';
import {repairToolHistory} from './tool-history';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDesignTaskKind,type DesignComment,type DesignHistory,type DesignOrigin,type DesignSession,type DesignSessionInput,type DesignSessionUpdate} from '../../src/designer-types';
import type {Store} from './store';
import {atomicJson} from './store';
import type {DesignSystems} from './design-systems';
import type {DesignPlugins} from './design-plugins';
import type {HarnessRunOptions} from './peer-runtime-types';
interface DesignData{contextResets?:Record<string,string>;version:1;sessions:DesignSession[];histories:Record<string,DesignHistory>;}
const originKey=(origin:DesignOrigin)=>`${origin.kind}:${origin.id}`;
function pluginIds(value:unknown){
 if(value===undefined)return [] as string[];
 if(!Array.isArray(value)||value.length>8||value.some(id=>typeof id!=='string'||!/^[a-z0-9-]{1,40}$/.test(id)))throw Error('设计插件无效');
 return [...new Set(value as string[])];
}
export class DesignStore {
 readonly file:string;data:DesignData;
 constructor(private store:Store,readonly systems:DesignSystems,private changed:()=>void=()=>{},private workspaceRoot:()=>string=()=>join(store.dir,'workspace'),readonly plugins?:DesignPlugins){const dir=join(store.dir,'designer');mkdirSync(dir,{recursive:true});this.file=join(dir,'state.json');this.data=existsSync(this.file)?JSON.parse(readFileSync(this.file,'utf8')):{version:1,sessions:[],histories:{}};if(this.data.version!==1||!Array.isArray(this.data.sessions))throw Error('设计任务数据版本无效');for(const session of this.data.sessions)if(session.activeRunId||session.status==='running'){delete session.activeRunId;session.status='paused';session.lastError='应用中断，继续前请核对已有文件。';}for(const bot of store.data.bots)if(bot.contextResetAt&&this.data.contextResets?.[bot.id]!==bot.contextResetAt)this.clearBot(bot.id);this.save();}
 save(){atomicJson(this.file,this.data);this.changed();}
 clearBot(botId:string){const resetAt=this.store.bot(botId).contextResetAt;if(resetAt)(this.data.contextResets||={})[botId]=resetAt;const ids=new Set(this.data.sessions.filter(s=>s.botId===botId).map(s=>s.id));for(const room of this.store.data.groups)for(const message of room.messages)if(message.designSessionId&&ids.has(message.designSessionId))delete message.designSessionId;this.store.save();this.data.sessions=this.data.sessions.filter(s=>s.botId!==botId);for(const key of Object.keys(this.data.histories))if(key.startsWith(`designer:${botId}:`))delete this.data.histories[key];this.save();}
 snapshot(){return {systems:this.systems.list(),sessions:structuredClone(this.data.sessions.filter(s=>this.store.data.bots.some(b=>b.id===s.botId))),plugins:this.plugins?.list()||[]};}
 validateOrigin(botId:string,origin:DesignOrigin){this.store.bot(botId);if(!origin||!['bot','group','peer'].includes(origin.kind)||typeof origin.id!=='string')throw Error('无效设计会话来源');if(origin.kind==='bot'&&origin.id!==botId)throw Error('设计任务不属于当前 Bot');if(origin.kind==='group'&&!this.store.data.groups.some(g=>g.id===origin.id&&g.members.some(m=>m.id===botId&&!m.leftAt)))throw Error('Bot 不属于这个群聊');if(origin.kind==='peer'&&!this.store.data.peerThreads.some(t=>t.id===origin.id&&t.members.some(m=>m.id===botId)))throw Error('Bot 不属于这个协作私聊');}
 create(input:DesignSessionInput){const bot=this.store.bot(input.botId);if(bot.type!=='designer')throw Error('请先将 Bot 类型设为设计师');const origin=input.origin||{kind:'bot' as const,id:bot.id};this.validateOrigin(bot.id,origin);if(!isDesignTaskKind(input.kind)||typeof input.brief!=='string'||!input.brief.trim()||input.brief.length>16000)throw Error('请填写设计任务内容');const system=input.systemId?this.systems.pin(input.systemId):undefined;const id=randomUUID(),now=new Date().toISOString();const session:DesignSession={id,botId:bot.id,origin,title:(input.title||input.brief).trim().slice(0,80),kind:input.kind,brief:input.brief.trim(),engineVersion:'designer-v1',systemId:system?.id||null,systemVersion:system?.version||null,status:'draft',stage:'brief',revision:1,createdAt:now,updatedAt:now,designSpec:'',constraints:[],artifacts:[],userEdits:[],checks:[],comments:[],plugins:pluginIds(input.plugins),runIds:[],workspacePath:`designers/${bot.id}/${id}`,location:'host',workspaceDir:createDesignerDirectory(this.workspaceRoot(),bot.id,id),workflowVersion:'local-design-v1'};this.data.sessions.push(session);this.save();return structuredClone(session);}
 get(id:string,botId?:string,origin?:DesignOrigin){const session=this.data.sessions.find(s=>s.id===id);if(!session||botId&&session.botId!==botId||origin&&originKey(session.origin)!==originKey(origin))throw Error('设计任务不存在或不属于当前会话');this.validateOrigin(session.botId,session.origin);return session;}
 setSystem(session:DesignSession,systemId:string|null){const live=this.get(session.id),system=systemId?this.systems.pin(systemId):undefined;live.systemId=system?.id||null;live.systemVersion=system?.version||null;this.touch(live);session.systemId=live.systemId;session.systemVersion=live.systemVersion;session.revision=live.revision;session.updatedAt=live.updatedAt;return live;}
 update(input:DesignSessionUpdate){const current=this.get(input.id),session=structuredClone(current);if(session.activeRunId)throw Error('设计任务正在执行，请停止后修改配置');if(input.revision!==session.revision)throw Error('设计任务已更新，请重新读取');if(input.title!==undefined){if(typeof input.title!=='string'||!input.title.trim()||input.title.length>80)throw Error('任务名称无效');session.title=input.title.trim();}if(input.systemId!==undefined){const system=input.systemId?this.systems.pin(input.systemId):undefined;session.systemId=system?.id||null;session.systemVersion=system?.version||null;}if(input.designSpec!==undefined){if(typeof input.designSpec!=='string'||input.designSpec.length>12000)throw Error('设计约定过长');session.designSpec=input.designSpec;}if(input.constraints!==undefined){if(!Array.isArray(input.constraints)||input.constraints.length>30||input.constraints.some(v=>typeof v!=='string'||v.length>800))throw Error('设计约束无效');session.constraints=input.constraints;}if(input.plugins!==undefined)session.plugins=pluginIds(input.plugins);this.data.sessions[this.data.sessions.indexOf(current)]=session;this.touch(session);return structuredClone(session);}
 addComments(id:string,comments:DesignComment[]){
  const session=this.get(id);if(!comments.length)return structuredClone(session);
  const existing=session.comments||[];
  for(const comment of comments){
   if(existing.some(item=>sameOpenDesignComment(item,comment)))continue;
   existing.push(structuredClone(comment));
  }
  session.comments=existing.slice(-80);this.touch(session);return structuredClone(session);
 }
 touch(session:DesignSession){session.revision++;session.updatedAt=new Date().toISOString();this.save();}
 origin(botId:string,options:HarnessRunOptions):DesignOrigin{if(options.groupOrigin)return{kind:'group',id:options.groupOrigin.groupId};if(options.peerOrigin){const exchange=this.store.data.peerExchanges.find(e=>e.id===(options.peerOrigin!.sessionId||options.peerOrigin!.exchangeId));if(!exchange)throw Error('协作来源不存在');return {kind:'peer',id:exchange.threadId};}return {kind:'bot',id:botId};}
 history(botId:string,origin:DesignOrigin,sessionId?:string){this.validateOrigin(botId,origin);if(sessionId)this.get(sessionId,botId,origin);const key=`designer:${botId}:${originKey(origin)}:${sessionId||'chat'}`;const history=this.data.histories[key]||=({messages:[],summary:''});const repaired=repairToolHistory(history.messages);if(repaired.repairs){history.messages=repaired.messages;history.summary='';this.save();}return {key,history};}
 activeFor(botId:string,origin:DesignOrigin){return this.data.sessions.filter(s=>s.botId===botId&&originKey(s.origin)===originKey(origin)&&s.status!=='completed');}
 userEdit(botId:string,path:string,revision:string,summary='用户在预览中保存了手动修改'){for(const session of this.data.sessions.filter(s=>s.botId===botId&&path.startsWith(s.workspacePath+'/'))){session.userEdits.push({id:randomUUID(),path,revision,time:new Date().toISOString(),summary});session.userEdits=session.userEdits.slice(-60);const artifact=session.artifacts.find(a=>a.path===path);if(artifact)artifact.revision=revision;session.status='review';session.checks=session.checks.map(c=>({...c,status:'pending'}));this.touch(session);}}
 frame(session:DesignSession){return JSON.stringify({id:session.id,kind:session.kind,title:session.title,brief:session.brief,system:{id:session.systemId,version:session.systemVersion},designSpec:session.designSpec,constraints:session.constraints,workspacePath:session.workspacePath,workspaceDir:session.workspaceDir,location:session.location||'vm',stage:session.stage,artifacts:session.artifacts,userEdits:session.userEdits.slice(-20),checks:session.checks,comments:(session.comments||[]).filter(comment=>comment.status==='open').slice(-20),plugins:session.plugins||[]});}
}
