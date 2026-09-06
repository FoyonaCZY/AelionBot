import type {Store} from './store';
import {isPrivatePeerOrigin} from '../../src/peer-types';

// References are scoped to this Bot. They do not append group chatter to its DM.
export function groupMainContext(store:Store,botId:string,maxChars=6500,summary?:string){
  const bot=store.bot(botId),runs=store.data.runs.filter(run=>run.botId===botId&&(!run.groupOrigin||run.groupTask)&&!isPrivatePeerOrigin(run.peerOrigin)).slice(-4);
  const records=store.data.messages.filter(message=>message.botId===botId&&!message.peer&&!message.groupLink&&!(message.role==='assistant'&&store.data.runs.some(run=>run.id===message.runId&&run.groupOrigin&&!run.groupReplyMessageId))).slice(-18);
  const context={memories:bot.memories,summary:summary||store.data.summaries[botId]||'',tasks:runs.map(run=>({id:run.id,status:run.status,startedAt:run.startedAt,error:run.error,request:store.data.messages.find(m=>m.runId===run.id&&(m.role==='user'||m.taskSource))?.content.slice(0,1000)})),artifacts:store.data.artifacts.filter(file=>file.botId===botId).slice(-5).map(({name,path,runId})=>({name,path,runId})),recent:records.map(message=>({id:message.id,role:message.role,status:message.status,tool:message.tool,text:message.content.slice(0,message.role==='tool'?850:1200)}))};
  // Older installations may only have the wire history for some turns.
  if(!context.recent.length)context.recent=(store.data.conversations[botId]||[]).slice(-8).map((message,index)=>({id:`wire:${index}`,role:message.role as 'user',status:undefined,tool:undefined,text:(message.content||'').slice(0,1000)}));
  context.summary=context.summary.slice(0,1600);context.memories=context.memories.slice(-16).map(value=>value.slice(0,250));
  while(JSON.stringify(context).length>maxChars&&context.recent.length>2)context.recent.shift();
  return JSON.stringify(context);
}

export function groupWorkContext(store:Store,botId:string){
  const runs=store.data.runs.filter(run=>run.botId===botId&&run.groupOrigin&&run.toolCalls>0).slice(-4);
  return JSON.stringify(runs.map(run=>({groupId:run.groupOrigin!.groupId,group:store.data.groups.find(room=>room.id===run.groupOrigin!.groupId)?.name,runId:run.id,status:run.status,error:run.error,task:store.data.groupRounds.find(round=>round.id===run.groupOrigin!.rootId)?.request.slice(0,800),records:store.runMessages(run.id).filter(message=>message.role==='tool'||message.presentation==='answer'&&Boolean(run.groupReplyMessageId)).slice(-4).map(message=>({id:message.id,tool:message.tool,status:message.status,content:message.content.slice(0,1200)}))})));
}
