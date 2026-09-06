import {randomUUID} from 'node:crypto';
import type {HostPermissionDetails,InteractionRequest} from '../../src/shared';
import type {ComputerController} from './computer';
import type {CommandPermissions} from './command-permissions';

export class InteractionDenied extends Error {
  constructor(message='用户拒绝了本机操作，任务已停止'){super(message);this.name='InteractionDenied';}
}
type Pending={request:InteractionRequest;resolve:()=>void;reject:(error:Error)=>void;cleanup:()=>void};
export class Interactions {
  private pending=new Map<string,Pending>();
  constructor(private changed:()=>void,private record?:(request:InteractionRequest,decision:string,ruleId?:string)=>void,private commands?:CommandPermissions){}
  snapshot():InteractionRequest[]{return [...this.pending.values()].map(item=>structuredClone(item.request));}
  get(id:string){const item=this.pending.get(id);if(!item)throw new Error('请求已结束或已取消');return structuredClone(item.request);}
  takeover(botId:string){return this.snapshot().find((item):item is InteractionRequest&{kind:'vm_takeover'}=>item.kind==='vm_takeover'&&item.botId===botId);}
  private enqueue(request:InteractionRequest,signal:AbortSignal):Promise<void>{
    if(signal.aborted)return Promise.reject(new Error('任务已取消'));
    return new Promise((resolve,reject)=>{
      const abort=()=>this.finish(request.id,new Error('任务已取消'),'cancelled');
      this.pending.set(request.id,{request:structuredClone(request),resolve,reject,cleanup:()=>signal.removeEventListener('abort',abort)});
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
    const allowed=this.commands?.match(captured);
    if(allowed){try{this.record?.(structuredClone(request),'rule-allowed',allowed.id);}catch{/* Logging does not change an existing grant. */}return Promise.resolve();}
    return this.enqueue(request,signal);
  }
  requestTakeover(botId:string,runId:string,reason:string,controlling:boolean,signal:AbortSignal){
    if(this.takeover(botId))return Promise.reject(new Error('这个 Bot 已在等待人工接管'));
    return this.enqueue({id:randomUUID(),botId,runId,createdAt:new Date().toISOString(),kind:'vm_takeover',reason,phase:controlling?'controlling':'waiting'},signal);
  }
  approve(id:string,allow:boolean){
    if(this.get(id).kind!=='host_permission')throw new Error('请求类型不匹配');
    this.finish(id,allow?undefined:new InteractionDenied(),allow?'allowed':'denied');
  }
  approveAlways(id:string){
    const request=this.get(id);
    if(request.kind!=='host_permission'||request.details.operation!=='command'||!this.commands)throw new Error('此请求不支持始终允许');
    const rule=this.commands.allow(request.details);
    this.finish(id,undefined,'always-allowed',rule.id);
    this.applyCommandRules();
  }
  applyCommandRules(){
    for(const {request} of [...this.pending.values()]){
      if(request.kind!=='host_permission')continue;
      const rule=this.commands?.match(request.details);
      if(rule)this.finish(request.id,undefined,'rule-allowed',rule.id);
    }
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
  cancelTakeover(id:string){if(this.get(id).kind!=='vm_takeover')throw new Error('请求类型不匹配');this.finish(id,new InteractionDenied('用户取消了人工接管，任务已停止'),'denied');}
  private finish(id:string,error:Error|undefined,decision:string,ruleId?:string){
    const item=this.pending.get(id);if(!item)return;
    this.pending.delete(id);item.cleanup();
    try{this.record?.(structuredClone(item.request),decision,ruleId);}catch{/* A logging failure does not change the user's decision. */}
    if(error)item.reject(error);else item.resolve();this.changed();
  }
  dispose(){for(const id of [...this.pending.keys()])this.finish(id,new Error('应用已关闭，未执行待授权操作'),'cancelled');}
}

export function respondToInteraction(interactions:Interactions,computer:ComputerController,input:{id?:unknown;action?:unknown}){
  if(typeof input?.id!=='string'||typeof input.action!=='string')throw new Error('无效请求');
  const request=interactions.get(input.id);
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
