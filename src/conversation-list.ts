import type {Bot,ChatMessage,RunRecord} from './shared';
import type {GroupSummary} from './group-types';
import {isPrivatePeerOrigin} from './peer-types';

const timestamp=(value:string)=>{const time=Date.parse(value);return Number.isFinite(time)?time:0;};

export function botConversationRows(bots:Bot[],messages:ChatMessage[],runs:RunRecord[]=[]){
  const privateRuns=new Set(runs.filter(run=>isPrivatePeerOrigin(run.peerOrigin)).map(run=>run.id));
  const latest=new Map<string,ChatMessage>();
  for(const message of messages){
    if(message.role==='tool'||message.reaction||!message.content.trim()&&!message.attachments?.length||privateRuns.has(message.runId||'')&&message.audience!=='user')continue;
    const previous=latest.get(message.botId);
    if(!previous||timestamp(message.time)>=timestamp(previous.time))latest.set(message.botId,message);
  }
  return bots.map((bot,index)=>({bot,last:latest.get(bot.id),index})).sort((a,b)=>
    timestamp(b.last?.time||b.bot.createdAt)-timestamp(a.last?.time||a.bot.createdAt)||a.index-b.index);
}

type ConversationRow=({kind:'bot';bot:Bot;last?:ChatMessage}|{kind:'group';group:GroupSummary})&{time:string};

export function conversationRows(bots:Bot[],messages:ChatMessage[],groups:GroupSummary[]=[],runs:RunRecord[]=[]):ConversationRow[]{
  const rows:ConversationRow[]=[
    ...botConversationRows(bots,messages,runs).map(({bot,last})=>({kind:'bot' as const,bot,last,time:last?.time||bot.createdAt})),
    ...groups.map(group=>({kind:'group' as const,group,time:group.updatedAt})),
  ];
  return rows.sort((a,b)=>timestamp(b.time)-timestamp(a.time));
}
