import {randomUUID} from 'node:crypto';
import type {GroupRoom,GroupTask} from '../../src/group-types';
import type {RunRecord} from '../../src/shared';
import type {Store} from './store';

const text=(value:unknown,label:string,max:number)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(`${label}为空或过长`);return value.trim();};
export const publicTask=({runIds,...task}:GroupTask)=>task;
export function groupTaskFrame(room:GroupRoom,botId:string,store?:Store){
 const tasks=room.tasks||[],active=tasks.filter(t=>t.status!=='completed');
 const brief=(task:GroupTask)=>({...publicTask(task),summary:task.summary.slice(0,500)}),own=active.filter(t=>t.ownerId===botId).slice(-8);
 const privateExecutionRuns=own.map(task=>({taskId:task.id,runs:task.runIds.slice(-2).flatMap(runId=>{
  const run=store?.data.runs.find(item=>item.id===runId&&item.botId===botId&&item.groupOrigin?.groupId===room.id);if(!run)return [];
  const records=store!.runMessages(run.id).filter(message=>message.role==='tool').slice(-3).map(message=>({tool:message.tool,status:message.status,content:message.content.slice(0,900)}));
  return [{runId:run.id,status:run.status,workspaceDir:run.workspaceDir,error:run.error?.slice(0,500),records}];
 })}));
 return JSON.stringify({groupId:room.id,publicMessageCount:room.messages.length,history:'group_read',tasks:active.slice(-12).map(brief),moreTasks:active.length>12,ownTasks:own.map(brief),privateExecutionRuns});
}

/** Synchronous compare-and-set in the one Store writer. No model or I/O awaits inside a claim. */
export function mutateGroupTask(store:Store,room:GroupRoom,run:RunRecord,name:string,args:Record<string,unknown>){
 const tasks=room.tasks||=[];
 if(name==='group_task_claim'){
  let task=args.taskId?tasks.find(t=>t.id===args.taskId):undefined;
  if(args.taskId&&!task)throw Error('群任务不存在');
  if(!task){
   const key=text(args.key,'任务标识',120).normalize('NFKC').toLowerCase(),title=text(args.title,'任务范围',500);
   task=tasks.find(t=>t.key===key);
   if(!task){
    const round=store.data.groupRounds.find(r=>r.id===run.groupOrigin!.rootId);
    const source=room.messages.find(m=>m.id===args.sourceMessageId)||(args.sourceMessageId?undefined:room.messages.find(m=>m.rootId===round?.id&&(m.sender.kind==='user'&&m.kind==='message'||m.scheduled||round?.originKey?.startsWith('task:')&&m.sender.kind==='bot')));
    if(source?.rootId!==round?.id)throw Error('新任务必须引用当前群聊消息中的原始用户任务；旧轮次消息不能新增任务授权');
    const root=source?.rootId?store.data.groupRounds.find(r=>r.id===source.rootId):round;
    const authorized=source&&(source.sender.kind==='user'&&source.kind==='message'||source.scheduled||root?.originKey?.startsWith('task:')&&store.humanRunMessage(root.originKey.slice(5)));
    if(!authorized)throw Error('请引用本群的原始用户任务消息；成员通知和 Bot 发言不能新增操作授权');
    const time=new Date().toISOString();task={id:randomUUID(),key,title,sourceMessageId:source.id,status:'open',summary:'',createdAt:time,updatedAt:time,revision:0,runIds:[]};tasks.push(task);
   }
  }
  if(task.status==='completed'||task.ownerId&&task.ownerId!==run.botId)return {claimed:false,task:publicTask(task)};
  if(task.status==='working'&&task.ownerId===run.botId&&task.runIds.includes(run.id))return {claimed:true,alreadyClaimed:true,task:publicTask(task)};
  task.ownerId=run.botId;task.status='working';delete task.reason;if(!task.runIds.includes(run.id))task.runIds.push(run.id);task.updatedAt=new Date().toISOString();task.revision++;
  return {claimed:true,task:publicTask(task)};
 }
 const task=tasks.find(t=>t.id===args.taskId);if(!task)throw Error('群任务不存在');
 if(task.ownerId!==run.botId)throw Error('只能更新自己认领的任务');
 if(args.revision!==task.revision)return {updated:false,conflict:true,task:publicTask(task)};
 if(task.status==='completed')throw Error('任务已经完成，请另建后续任务');
 if(!['working','blocked','open','completed'].includes(String(args.status)))throw Error('无效任务状态');
 const summary=text(args.summary,'进展、结果或阻碍',2000);
 task.status=args.status as GroupTask['status'];task.summary=summary;delete task.reason;task.updatedAt=new Date().toISOString();task.revision++;
 if(task.status==='open')delete task.ownerId;
 if(!task.runIds.includes(run.id))task.runIds.push(run.id);
 return {updated:true,task:publicTask(task)};
}
