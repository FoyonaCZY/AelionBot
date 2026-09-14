import {individualGroupResponses} from './group-response';
import type {GroupMessage,GroupRoom,GroupRound} from '../../src/group-types';
import type {WorkItem} from '../../src/work-types';

const activeWork=new Set(['planning','ready','running','paused','blocked']);
export const GROUP_WAKE_SKIPPED='未点名，无需唤醒';

export function shouldWakeGroupBot(input:{botId:string;messages:GroupMessage[];room:GroupRoom;round:GroupRound;workItems?:WorkItem[];retry?:boolean}){
  if(input.retry||individualGroupResponses(input.round.request))return true;
  const unfinished=input.workItems?.some(item=>item.botId===input.botId&&item.scope.kind==='group'&&item.scope.id===input.room.id&&activeWork.has(item.status));
  for(const message of input.messages){
    if(message.mentions?.some(mention=>mention.id===input.botId))return true;
    if(message.workItemId&&input.workItems?.some(item=>item.id===message.workItemId&&item.botId===input.botId))return true;
    if(message.replyTo&&input.room.messages.find(item=>item.id===message.replyTo)?.sender.id===input.botId)return true;
    if(message.scheduled||message.kind==='continue'||message.event?.type==='created')return true;
    if(message.event?.joined.some(member=>member.id===input.botId))return true;
    if(message.sender.kind==='user'&&message.kind==='message'&&!message.mentions?.length)return true;
    if(unfinished&&message.sender.kind==='user')return true;
  }
  return false;
}
