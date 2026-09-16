import type {Store} from './store';
import {isPrivatePeerOrigin} from '../../src/peer-types';

// References are scoped to this Bot. They do not append group chatter to its DM.
export function groupMainContext(store:Store,botId:string,maxChars=6500,_privateSummary?:string,groupId?:string){
  const bot=store.bot(botId),rooms=store.data.groups.filter(room=>(!groupId||room.id===groupId)&&room.members.some(member=>member.id===botId&&!member.leftAt)),ids=new Set(rooms.map(room=>room.id));
  const runs=store.data.runs.filter(run=>run.botId===botId&&run.groupOrigin&&ids.has(run.groupOrigin.groupId)).slice(-6),runIds=new Set(runs.map(run=>run.id));
  const context={bot:{id:bot.id,name:bot.name},groups:rooms.map(room=>({id:room.id,name:room.name})),sharedRequests:store.data.groupRounds.filter(round=>ids.has(round.groupId)&&(!bot.contextResetAt||round.createdAt>=bot.contextResetAt)).slice(-4).map(round=>({id:round.id,groupId:round.groupId,request:round.request.slice(0,1200)})),tasks:runs.map(run=>({id:run.id,status:run.status,groupId:run.groupOrigin!.groupId,designSessionId:run.designSessionId})),ownExecutionResults:runs.flatMap(run=>store.runMessages(run.id).filter(message=>message.role==='tool').map(message=>({runId:run.id,messageId:message.id,tool:message.tool,status:message.status,content:message.content.slice(0,1800)}))).slice(-6),artifacts:store.data.artifacts.filter(file=>runIds.has(file.runId)).slice(-8).map(file=>({name:file.name,path:file.path,runId:file.runId}))};
  while(JSON.stringify(context).length>maxChars&&context.sharedRequests.length>1)context.sharedRequests.shift();while(JSON.stringify(context).length>maxChars&&context.ownExecutionResults.length>1)context.ownExecutionResults.shift();return JSON.stringify(context);
}

export function groupWorkContext(store:Store,botId:string){
  const runs=store.data.runs.filter(run=>run.botId===botId&&run.groupOrigin&&run.toolCalls>0).slice(-4);
  return JSON.stringify(runs.map(run=>({groupId:run.groupOrigin!.groupId,group:store.data.groups.find(room=>room.id===run.groupOrigin!.groupId)?.name,runId:run.id,status:run.status,error:run.error,task:store.data.groupRounds.find(round=>round.id===run.groupOrigin!.rootId)?.request.slice(0,800),records:store.runMessages(run.id).filter(message=>message.role==='tool'||message.presentation==='answer'&&Boolean(run.groupReplyMessageId)).slice(-4).map(message=>({id:message.id,tool:message.tool,status:message.status,content:message.content.slice(0,1200)}))})));
}
