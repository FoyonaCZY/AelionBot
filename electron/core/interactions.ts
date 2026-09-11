import {randomUUID} from 'node:crypto';
import type {HostPermissionDetails,InteractionRequest,UserQuestion} from '../../src/shared';
import type {ComputerController} from './computer';
import type {CommandPermissions} from './command-permissions';
import type {HostApprovalPolicy} from './host-approval-types';
import {abortable} from './abortable';

export class InteractionDenied extends Error {
  constructor(message='用户拒绝了本次操作',readonly details?:HostPermissionDetails,readonly source:'user'|'model'='user',readonly stopTask=false){super(message);this.name='InteractionDenied';}
}
type Pending={request:InteractionRequest;resolve:()=>void;reject:(error:Error)=>void;cleanup:()=>void;review?:AbortController;revision:number};
type QuestionRecord={request:Extract<InteractionRequest,{kind:'user_input'}>;completion:Promise<void>;answers?:Record<string,string>;cancelled?:boolean;consumed?:boolean};
export class Interactions {
  private pending=new Map<string,Pending>();
  private questions=new Map<string,QuestionRecord>();
  private hostPolicy?:HostApprovalPolicy;
  constructor(private changed:()=>void,private record?:(request:InteractionRequest,decision:string,ruleId?:string)=>void,private commands?:CommandPermissions,private reviewTimeoutMs=22000){}
  setHostPolicy(policy:HostApprovalPolicy){this.hostPolicy=policy;}
  get hasHostPolicy(){return Boolean(this.hostPolicy);}
  snapshot():InteractionRequest[]{return [...this.pending.values()].map(item=>structuredClone(item.request));}
  get(id:string){const item=this.pending.get(id);if(!item)throw new Error('请求已结束或已取消');return structuredClone(item.request);}
  takeover(botId:string){return this.snapshot().find((item):item is InteractionRequest&{kind:'vm_takeover'}=>item.kind==='vm_takeover'&&item.botId===botId);}
  private enqueue(request:InteractionRequest,signal:AbortSignal):Promise<void>{
    if(signal.aborted)return Promise.reject(new Error('任务已取消'));
    return new Promise((resolve,reject)=>{
      const abort=()=>this.finish(request.id,new Error('任务已取消'),'cancelled');
      this.pending.set(request.id,{request:structuredClone(request),resolve,reject,cleanup:()=>signal.removeEventListener('abort',abort),revision:0});
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();else this.changed();
    });
  }
  permission(botId:string,runId:string,details:HostPermissionDetails,signal:AbortSignal){
    if(signal.aborted)return Promise.reject(new Error('任务已取消'));
    if(Buffer.byteLength(JSON.stringify(details),'utf8')>1024*1024)return Promise.reject(new Error('操作内容过大，无法展示权限请求'));
    const captured=structuredClone(details);delete captured.commandPattern;
    const suggestion=this.commands?.suggest(captured);if(suggestion)captured.commandPattern=suggestion;
    const request:InteractionRequest={id:randomUUID(),botId,runId,createdAt:new Date().toISOString(),kind:'host_permission',details:captured};
    if(this.hostPolicy){
      const assessment=this.hostPolicy.assess(request);
      if(assessment.mode!=='auto')delete request.details.commandPattern;
      request.approval={mode:assessment.mode,phase:assessment.kind==='review'?'reviewing':'waiting',reason:assessment.reason,reviewer:assessment.reviewer};
      if(assessment.kind==='allow'){try{this.record?.(structuredClone(request),'auto-'+assessment.source,assessment.ruleId);}catch{}return Promise.resolve();}
      const pending=this.enqueue(request,signal);if(assessment.kind==='review')this.startReview(request.id);return pending;
    }
    const allowed=this.commands?.match(captured);
    if(allowed){try{this.record?.(structuredClone(request),'rule-allowed',allowed.id);}catch{/* Logging does not change an existing grant. */}return Promise.resolve();}
    return this.enqueue(request,signal);
  }
  requestTakeover(botId:string,runId:string,reason:string,controlling:boolean,signal:AbortSignal){
    if(this.takeover(botId))return Promise.reject(new Error('这个 Bot 已在等待人工接管'));
    return this.enqueue({id:randomUUID(),botId,runId,createdAt:new Date().toISOString(),kind:'vm_takeover',reason,phase:controlling?'controlling':'waiting'},signal);
  }
  async ask(botId:string,runId:string,value:unknown,signal:AbortSignal,wait=false){
    if(!Array.isArray(value)||value.length<1||value.length>3)throw Error('每次需要 1–3 个问题');
    const ids=new Set<string>();const questions:UserQuestion[]=value.map(item=>{
      if(!item||typeof item.id!=='string'||!/^[\w-]{1,40}$/.test(item.id)||['__proto__','constructor','prototype'].includes(item.id)||ids.has(item.id)||typeof item.title!=='string'||!item.title.trim()||item.title.length>1000)throw Error('问题 ID 或内容无效');ids.add(item.id);
      if(item.options!==undefined&&(!Array.isArray(item.options)||item.options.length<2||item.options.length>6||item.options.some((option:unknown)=>typeof option!=='string'||!option.trim()||option.length>200)||new Set(item.options).size!==item.options.length))throw Error('选项需要 2–6 条不重复的短文本');
      return {id:item.id,title:item.title.trim(),...(item.options?{options:[...item.options]}:{})};
    });
    if(this.snapshot().some(request=>request.botId===botId&&request.kind==='user_input'))throw Error('这个 Bot 仍有问题等待回答，请先等待原问题');
    for(const [id,record] of this.questions)if(record.consumed)this.questions.delete(id);
    const request:QuestionRecord['request']={id:randomUUID(),botId,runId,kind:'user_input',questions,phase:'waiting',createdAt:new Date().toISOString()},record:QuestionRecord={request,completion:Promise.resolve()};this.questions.set(request.id,record);
    record.completion=this.enqueue(request,signal).catch(error=>{record.cancelled=true;if(!signal.aborted)throw error;});record.completion.catch(()=>{});
    if(wait){await record.completion;signal.throwIfAborted();return this.questionStatus(botId,request.id);}
    return {id:request.id,status:'waiting',note:'问题已显示在会话中。可继续独立工作；需要答案时使用 user_input_wait。回答不会自动扩大操作权限。'};
  }
  answer(id:string,value:unknown){
    const record=this.questions.get(id),pending=this.pending.get(id);if(!record||!pending||pending.request.kind!=='user_input')throw Error('问题已结束或已取消');
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('回答格式无效');const input=value as Record<string,unknown>,answers:Record<string,string>={};
    if(Object.keys(input).length!==record.request.questions.length)throw Error('请回答所有问题');
    for(const question of record.request.questions){const answer=input[question.id];if(typeof answer!=='string'||!answer.trim()||answer.length>4000)throw Error('每个回答需要 1–4000 字符');answers[question.id]=answer.trim();}
    record.answers=answers;this.finish(id,undefined,'answered');
  }
  questionStatus(botId:string,id:string){const record=this.questions.get(id);if(!record||record.request.botId!==botId)throw Error('问题不存在或不属于当前 Bot');return {id,status:record.answers?'answered':record.cancelled?'cancelled':'waiting',...(record.answers?{questions:structuredClone(record.request.questions),answers:{...record.answers}}:{})};}
  async waitQuestion(botId:string,id:string,signal:AbortSignal,milliseconds=10000){
    this.questionStatus(botId,id);const record=this.questions.get(id)!;let timer:NodeJS.Timeout|undefined;
    try{await abortable(signal,()=>Promise.race([record.completion,new Promise<void>(resolve=>{timer=setTimeout(resolve,milliseconds);})]));return this.questionStatus(botId,id);}finally{clearTimeout(timer);}
  }
  pendingQuestions(botId:string,runId:string){return this.snapshot().filter(request=>request.kind==='user_input'&&request.botId===botId&&request.runId===runId);}
  async waitQuestions(botId:string,runId:string,signal:AbortSignal){await abortable(signal,()=>Promise.all(this.pendingQuestions(botId,runId).map(request=>this.questions.get(request.id)!.completion)));}
  consumeAnswers(botId:string,runId:string){return [...this.questions.values()].filter(record=>record.request.botId===botId&&record.request.runId===runId&&record.answers&&!record.consumed).map(record=>{record.consumed=true;return this.questionStatus(botId,record.request.id);});}
  hasAnswers(botId:string,runId:string){return [...this.questions.values()].some(record=>record.request.botId===botId&&record.request.runId===runId&&record.answers&&!record.consumed);}
  cancelQuestions(botId:string,runId:string){for(const request of this.pendingQuestions(botId,runId)){const record=this.questions.get(request.id)!;record.cancelled=true;this.finish(request.id,undefined,'cancelled');}}
  approve(id:string,allow:boolean){
    const request=this.get(id);if(request.kind!=='host_permission')throw new Error('请求类型不匹配');
    if(allow&&request.approval?.phase==='reviewing')throw new Error('自动审核尚未结束');
    this.finish(id,allow?undefined:new InteractionDenied('用户拒绝了本次操作',request.details),allow?'allowed':'denied');
  }
  approveAlways(id:string){
    const request=this.get(id);
    if(request.kind!=='host_permission'||request.details.operation!=='command'||!this.commands)throw new Error('此请求不支持始终允许');
    if(request.approval?.phase==='reviewing')throw new Error('自动审核尚未结束');
    if(this.hostPolicy&&this.hostPolicy.modeFor(request)!=='auto')throw new Error('每次询问模式不能保存自动放行规则');
    const rule=this.commands.allow(request.details);
    this.finish(id,undefined,'always-allowed',rule.id);
    this.applyCommandRules();
  }
  applyCommandRules(){
    for(const {request} of [...this.pending.values()]){
      if(request.kind!=='host_permission')continue;
      if(this.hostPolicy&&this.hostPolicy.modeFor(request)!=='auto')continue;
      const rule=this.commands?.match(request.details);
      if(rule)this.finish(request.id,undefined,'rule-allowed',rule.id);
    }
  }
  private startReview(id:string){
    const pending=this.pending.get(id),policy=this.hostPolicy;if(!pending||pending.request.kind!=='host_permission'||!policy)return;
    pending.review?.abort();const controller=new AbortController(),revision=++pending.revision;pending.review=controller;
    const request=structuredClone(pending.request),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(this.reviewTimeoutMs)]);
    void abortable(signal,()=>policy.review(request,signal)).then(result=>{
      const item=this.pending.get(id);if(!item||item!==pending||item.revision!==revision||controller.signal.aborted||item.request.kind!=='host_permission')return;
      if(policy.modeFor(item.request)!=='auto'){this.refreshHostPolicy();return;}
      item.request.approval={mode:'auto',phase:'waiting',...result};
      if(result.decision==='allow')this.finish(id,undefined,'auto-model');
      else if(result.decision==='deny')this.finish(id,new InteractionDenied(`自动审核未放行：${result.reason}`,item.request.details,'model'),'auto-model-deny');
      else{try{this.record?.(structuredClone(item.request),'auto-model-'+result.decision);}catch{}this.changed();}
    }).catch(()=>{
      const item=this.pending.get(id);if(!item||item!==pending||item.revision!==revision||controller.signal.aborted||item.request.kind!=='host_permission')return;
      item.request.approval={mode:'auto',phase:'waiting',decision:'ask',reason:'默认模型审核未完成，需要你确认本次操作',reviewer:request.approval?.reviewer};
      try{this.record?.(structuredClone(item.request),'auto-review-unavailable');}catch{}this.changed();
    });
  }
  refreshHostPolicy(){
    const policy=this.hostPolicy;if(!policy)return;
    for(const item of [...this.pending.values()]){
      if(item.request.kind!=='host_permission')continue;
      if(item.request.approval?.mode===policy.modeFor(item.request))continue;
      item.review?.abort();item.review=undefined;item.revision++;
      const assessment=policy.assess(item.request);delete item.request.details.commandPattern;
      if(assessment.mode==='auto')item.request.details.commandPattern=this.commands?.suggest(item.request.details);
      item.request.approval={mode:assessment.mode,phase:assessment.kind==='review'?'reviewing':'waiting',reason:assessment.reason,reviewer:assessment.reviewer};
      if(assessment.kind==='allow')this.finish(item.request.id,undefined,'auto-'+assessment.source,assessment.ruleId);
      else if(assessment.kind==='review')this.startReview(item.request.id);
    }
    this.changed();
  }
  startTakeover(id:string){
    const item=this.pending.get(id);if(!item||item.request.kind!=='vm_takeover')throw new Error('接管请求已结束');
    item.request.phase='controlling';this.changed();
  }
  pauseTakeover(botId:string){const request=this.takeover(botId);if(!request)return;const item=this.pending.get(request.id)!;(item.request as typeof request).phase='waiting';this.changed();}
  completeTakeover(id:string){
    const item=this.get(id);if(item.kind!=='vm_takeover'||item.phase!=='controlling')throw new Error('请先接管并完成操作，再交还继续');
    this.finish(id,undefined,'resumed');
  }
  cancelTakeover(id:string){if(this.get(id).kind!=='vm_takeover')throw new Error('请求类型不匹配');this.finish(id,new InteractionDenied('用户取消了人工接管，任务已停止',undefined,'user',true),'denied');}
  private finish(id:string,error:Error|undefined,decision:string,ruleId?:string){
    const item=this.pending.get(id);if(!item)return;
    this.pending.delete(id);item.review?.abort();item.cleanup();
    try{this.record?.(structuredClone(item.request),decision,ruleId);}catch{/* A logging failure does not change the user's decision. */}
    if(error)item.reject(error);else item.resolve();this.changed();
  }
  dispose(){for(const id of [...this.pending.keys()])this.finish(id,new Error('应用已关闭，未执行待授权操作'),'cancelled');}
}

export function respondToInteraction(interactions:Interactions,computer:ComputerController,input:{id?:unknown;action?:unknown;answers?:unknown}){
  if(typeof input?.id!=='string'||typeof input.action!=='string')throw new Error('无效请求');
  const request=interactions.get(input.id);
  if(request.kind==='user_input'){if(input.action!=='answer')throw Error('无效回答操作');interactions.answer(input.id,input.answers);return;}
  if(request.kind==='host_permission'){
    if(input.action==='allow-always'){interactions.approveAlways(input.id);return;}
    if(!['allow','deny'].includes(input.action))throw new Error('无效权限决定');
    interactions.approve(input.id,input.action==='allow');return;
  }
  if(input.action==='takeover'){computer.setManual(request.botId,true);interactions.startTakeover(input.id);return;}
  if(input.action==='resume'){
    if(request.phase!=='controlling')throw new Error('请先接管，再交还继续');
    computer.setManual(request.botId,false);interactions.completeTakeover(input.id);return;
  }
  if(input.action==='cancel'){interactions.cancelTakeover(input.id);return;}
  throw new Error('无效接管操作');
}
export function changeManualControl(interactions:Interactions,computer:ComputerController,botId:string,enabled:unknown,cancel:(botId:string)=>void){
  if(typeof enabled!=='boolean')throw new Error('无效控制状态');
  const owner=computer.stateFor(botId).ownerBotId,takeover=interactions.takeover(botId);
  if(enabled&&owner&&takeover?.botId!==owner)cancel(owner);
  computer.setManual(botId,enabled);
  if(takeover){if(enabled)interactions.startTakeover(takeover.id);else interactions.pauseTakeover(botId);}
}
