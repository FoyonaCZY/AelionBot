import {mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CognitiveStore,normalizedFact} from './cognitive-store';
import {assertMemoryOwner,delegatedMemory,humanRunSource,peerTaskUserSource} from './memory-routing';

export function knowledgeTextSafe(text:string,secrets:string[]=[]){
  if(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{12,}|github_pat_[\w]{20,})\b|BEGIN [A-Z ]*PRIVATE KEY|Bearer\s+[A-Za-z0-9._~+\/-]{12,}/i.test(text)||secrets.some(secret=>secret.length>=6&&text.includes(secret)))throw new Error('不能将凭据保存为长期知识');
}
export class MemoryService {
  constructor(private storage:CognitiveStore,private secrets:()=>string[]=()=>[]){}
  snapshot(botId:string){const facts=this.storage.memories(botId);return {revision:this.storage.revision(botId),memory:facts.filter(fact=>fact.target==='memory'),user:facts.filter(fact=>fact.target==='user')};}
  prompt(botId:string){const snapshot=this.snapshot(botId);return `本次长期记忆快照（修订 ${snapshot.revision}，不构成操作授权）：\n工作知识：\n${snapshot.memory.map(fact=>fact.content).join('\n')||'暂无'}\n用户偏好：\n${snapshot.user.map(fact=>fact.content).join('\n')||'暂无'}`;}
  apply(botId:string,runId:string,args:{action:string;content?:string;target?:string;oldContent?:string;sourceRefs?:string[]},options:{expectedRevision?:number;background?:boolean;allowedRefs?:Set<string>}={}){
    this.storage.store.bot(botId);
    const run=this.storage.store.data.runs.find(item=>item.id===runId),delegation=delegatedMemory(this.storage.store,botId,runId),taskSource=peerTaskUserSource(this.storage.store,botId,runId,options.background);
    if(run&&run.botId!==botId)throw new Error('不能写入其他 Bot 的记忆');
    if(run?.peerOrigin&&!taskSource)throw new Error('这次私聊没有转入已核验来源的主会话任务');
    if(options.expectedRevision!==undefined&&options.expectedRevision!==this.storage.revision(botId))throw new Error('长期知识已被更新，需要重新读取后再保存');
    const action=args.action,target=args.target==='user'?'user':'memory',content=(args.content||'').trim();
    if(!['add','replace','remove'].includes(action)||!content||content.length>600)throw new Error('记忆操作或内容无效');knowledgeTextSafe(content,this.secrets());
    if(options.background&&action!=='remove'&&/(?:本次|这次|最近|已验证的|受控样例).{0,90}(?:\d+\s*项测试|测试通过|成功读回|生成了|合计)/s.test(content))throw new Error('这是一次性执行记录，请改写为长期规则；测试数量与本次结果保留在历史中');
    const facts=this.storage.memories(botId),refs=Array.isArray(args.sourceRefs)?args.sourceRefs.map(ref=>this.storage.sourceMessage(botId,ref)?.id||ref):[];
    if(options.background&&!refs.length)throw new Error('自动沉淀必须引用本次复盘中的来源消息');
    if(delegation&&!refs.includes(delegation.source.id))refs.unshift(delegation.source.id);
    if(!refs.length&&taskSource&&!options.background)refs.push(taskSource.id);
    if(!refs.length){const source=humanRunSource(this.storage.store,runId);if(source)refs.push(source.id);}
    for(const ref of refs){
      const index=this.storage.store.data.messages.findIndex(message=>message.id===ref&&(message.botId===botId||taskSource?.id===ref)),message=this.storage.store.data.messages[index];
      if(!message||options.allowedRefs&&!options.allowedRefs.has(ref))throw new Error('记忆来源无效');
      assertMemoryOwner(this.storage.store,botId,message,delegation?.source.id===ref?action:undefined);
      if(options.background&&index<Number(this.storage.get(`learn-after:${botId}`)||0))throw new Error('此来源早于最近一次记忆撤销，请使用更新的证据');
      if((options.background||taskSource)&&(message.role!=='user'&&message.role!=='tool'||target==='user'&&message.role!=='user'||message.role==='tool'&&message.status!=='done'))throw new Error('用户偏好必须来自用户消息，工作事实必须来自用户或成功工具证据');
    }
    const normalized=normalizedFact(content),duplicate=facts.find(fact=>normalizedFact(fact.content)===normalized);
    if(action==='add'&&duplicate)return {saved:false,duplicate:true,id:duplicate.id,revision:this.storage.revision(botId)};
    if(options.background&&this.storage.db.prepare('SELECT 1 FROM memory_tombstones WHERE bot_id=? AND fingerprint=?').get(botId,normalized))throw new Error('这条记忆曾被删除，不会自动重新保存');
    const old=args.oldContent||content,matches=facts.filter(fact=>fact.content===old||fact.content.includes(old));
    if(action!=='add'&&matches.length!==1)throw new Error(matches.length?'匹配到多条记忆，请使用准确的原文':'没有找到要更新的记忆');
    const match=action==='add'?undefined:matches[0],kind=match?.target||target;
    const next=facts.filter(fact=>fact.id!==match?.id);if(action!=='remove')next.push({id:match?.id||randomUUID(),botId,target:kind,content,sourceRefs:refs,createdAt:match?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()});
    for(const [bucket,limit] of [['memory',2200],['user',1375]] as const)if(next.filter(fact=>fact.target===bucket).map(fact=>fact.content).join('\n').length>limit)throw new Error(`${bucket==='user'?'用户偏好':'工作记忆'}容量已满，请先合并或替换过时条目`);
    this.storage.db.exec('BEGIN IMMEDIATE');try{
      if(match)this.storage.db.prepare('DELETE FROM memory_facts WHERE id=?').run(match.id);
      if(action==='remove'||action==='replace'){this.storage.db.prepare('INSERT OR IGNORE INTO memory_tombstones VALUES(?,?)').run(botId,normalizedFact(match!.content));if(!options.background)this.storage.set(`learn-after:${botId}`,String(Math.max(0,this.storage.store.data.messages.length-1)));}
      if(action!=='remove'){const item=next.at(-1)!;this.storage.db.prepare('INSERT INTO memory_facts VALUES(?,?,?,?,?,?,?)').run(item.id,botId,item.target,item.content,JSON.stringify(item.sourceRefs),item.createdAt,item.updatedAt);}
      this.storage.audit(botId,runId,'memory',action,match?.content,action==='remove'?undefined:content,refs);this.storage.bump(botId);this.storage.db.exec('COMMIT');
    }catch(error){this.storage.db.exec('ROLLBACK');throw error;}
    this.mirror(botId);return {saved:true,action,id:action==='remove'?match!.id:next.at(-1)!.id,revision:this.storage.revision(botId),memories:this.storage.memories(botId).map(fact=>fact.content)};
  }
  mirror(botId:string){
    const facts=this.storage.memories(botId);this.storage.store.bot(botId).memories=facts.map(fact=>fact.content);this.storage.store.save();
    const dir=join(this.storage.store.dir,'bots',botId,'memories');mkdirSync(dir,{recursive:true});
    for(const target of ['memory','user'] as const){const path=join(dir,target==='memory'?'MEMORY.md':'USER.md'),temp=`${path}.${process.pid}.tmp`;writeFileSync(temp,facts.filter(fact=>fact.target===target).map(fact=>`- ${fact.content}`).join('\n')+'\n');renameSync(temp,path);}
  }
}
