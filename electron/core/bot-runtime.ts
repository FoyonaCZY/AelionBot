import {resumableRun} from './resume-run';
import {botType} from '../../src/designer-types';
import type {Harness} from './harness';
import type {DesignerLoop} from './designer-loop';
import type {Store} from './store';
import type {HarnessRunOptions,PeerGateway} from './peer-runtime-types';
import type {GroupGateway} from './group-runtime-types';
import type {TaskScheduler} from './task-scheduler';
import type {AgentPreviews} from './agent-previews';
import type {VideoFrames} from './video-frames';
/** One dispatch boundary for private chat, groups, delegated work and schedules. */
export class BotRuntime {
 private dispatching=new Set<string>();
 readonly streams:{snapshot:()=>ReturnType<Harness['streams']['snapshot']>};
 constructor(private store:Store,readonly general:Harness,readonly designer:DesignerLoop,private changed:()=>void,private beforeDesignerRun:()=>void=()=>{}){this.streams={snapshot:()=>[...general.streams.snapshot(),...designer.streams.snapshot()]};}
 get busy(){return this.dispatching.size>0||this.general.busy||this.designer.busy;}
 isRunning(id:string){return this.dispatching.has(id)||this.general.isRunning(id)||this.designer.isRunning(id);}
 async run(id:string,input:string,options:HarnessRunOptions={}){
  if(this.isRunning(id))throw Error('这个 Bot 仍在工作，请等待或停止当前任务');
  const previousId=options.resumeRunId||options.groupTaskFrom;const previous=previousId?this.store.data.runs.find(r=>r.id===previousId&&r.botId===id):options.workItemId?this.store.data.runs.filter(r=>r.workItemId===options.workItemId&&r.botId===id).at(-1):undefined;
  const kind=botType(this.store.bot(id).type);
  if(previous&&(previous.engine||'general')!==kind)throw Error('Bot 类型已改变，不能恢复旧类型的任务');
  if(options.designSessionId&&kind!=='designer')throw Error('通用 Bot 不能运行设计会话');
  if(kind==='designer')this.beforeDesignerRun();
  this.dispatching.add(id);
  try{await (kind==='designer'?this.designer:this.general).run(id,input,options);}
  finally{this.dispatching.delete(id);}
 }
 async resume(botId:string,runId:string){
  const run=this.store.data.runs.find(r=>r.id===runId&&r.botId===botId);if(!run)throw Error('任务不存在');if((run.engine||'general')!==botType(this.store.bot(botId).type))throw Error('Bot 类型已改变，不能恢复旧类型的任务');
  if(run.engine==='designer'){this.beforeDesignerRun();return this.designer.resume(botId,runId);}
  const previous=resumableRun(this.store,botId,runId),source=this.store.humanRunMessage(previous.id),work=this.store.data.workItems?.find(item=>item.id===previous.workItemId);
  if(previous.groupOrigin||previous.peerOrigin)throw Error('协作任务需要通过原会话恢复');
  const input=source?.content||work?.objective||(source?.attachments?.length?'继续处理用户已发送的附件':'');if(!input)throw Error('未找到原任务要求，请重新发送任务范围');
  return this.run(botId,input,{resumeRunId:previous.id,workItemId:previous.workItemId,workspaceDir:previous.workspaceDir,attachments:source?.attachments});
 }

 cancel(id:string){this.general.cancel(id);this.designer.cancel(id);}
 liveWork(){return this.general.liveWork();}
 stopLiveWork(botId:string,kind:'terminal'|'process',id:string){return this.general.stopLiveWork(botId,kind,id);}
 refreshInput(id:string){return this.designer.isRunning(id)?this.designer.refreshInput(id):this.general.refreshInput(id);}
 refreshGroup(id:string){if(this.designer.isRunning(id))this.designer.refreshGroup(id);else this.general.refreshGroup(id);}
 setPeerGateway(gateway:PeerGateway){this.general.setPeerGateway(gateway);this.designer.setPeerGateway(gateway);}
 setGroupGateway(gateway:GroupGateway){this.general.setGroupGateway(gateway);this.designer.setGroupGateway(gateway);}
 setPreviewGateway(gateway:AgentPreviews){this.general.setPreviewGateway(gateway);}
 setTaskScheduler(scheduler:TaskScheduler){this.general.setTaskScheduler(scheduler);}
 setVideoFrames(video:VideoFrames){this.general.setVideoFrames(video);}
 disposeTools(){this.designer.streams.dispose();this.general.disposeTools();}
 closeProcesses(){return this.general.closeProcesses();}
 stopBotProcesses(botId:string){return this.general.stopBotProcesses(botId);}
}
