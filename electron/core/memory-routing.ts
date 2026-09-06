import type {ChatMessage} from '../../src/shared';
import {peerPending} from '../../src/peer-types';
import type {Store} from './store';

type MemoryAction='add'|'replace'|'remove';
export interface MemoryRoute {targetBotIds:string[];actionsByBot:Record<string,MemoryAction[]>;}
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function unquoted(value:string){
  return value.replace(/```[\s\S]*?```/g,'').replace(/`[^`]*`|“[^”]*”|「[^」]*」|"(?:\\.|[^"\\])*"/g,'').split('\n').filter(line=>!/^\s*>/.test(line)).join('\n');
}
function namedTargets(store:Store,source:ChatMessage,address:string){
  const mentioned=(source.mentions||[]).filter(mention=>address.includes(mention.name)&&store.data.bots.some(bot=>bot.id===mention.id));
  const names=store.data.bots.filter(bot=>address.includes(bot.name));
  const result=new Set(mentioned.map(mention=>mention.id));
  for(const bot of names){
    if(mentioned.some(mention=>mention.name===bot.name))continue;
    if(names.filter(other=>other.name===bot.name).length>1)return [];
    result.add(bot.id);
  }
  return [...result];
}
// Resolve explicit memory instructions from the real human message, not a peer's paraphrase.
export function memoryRoute(store:Store,source:ChatMessage):MemoryRoute|undefined{
  if(source.role!=='user'||source.reaction||source.peer||store.data.runs.some(run=>run.id===source.runId&&run.peerOrigin))return;
  const targets=new Set<string>(),grants=new Map<string,Set<MemoryAction>>(),blocked=new Set<string>();let found=false,ambiguous=false,hint:string[]=[];
  for(const clause of unquoted(source.content.slice(0,8000)).split(/[\n。；;，,]/)){
    const text=clause.trim();if(!text)continue;
    const standAlone=store.data.bots.filter(bot=>new RegExp(`^@?${escape(bot.name)}[：:]?$`).test(text));
    if(standAlone.length){hint=namedTargets(store,source,text);continue;}
    const action=/记住|记下|记牢|记着|忘记|remember|memorize|forget|(?:保存|写入|记录|删除|移除)(?=.{0,30}(?:记忆|偏好))/i.exec(text);
    if(!action)continue;
    const head=text.slice(0,action.index),cues=[...head.matchAll(/让|叫|告诉|转告|通知|提醒|\btell\b|\bask\b/gi)],cue=cues.at(-1);
    let addressed:string,ids:string[];
    if(cue)addressed=head.slice(cue.index!+cue[0].length);
    else{
      const named=store.data.bots.some(bot=>new RegExp(`^@?${escape(bot.name)}[\\s：:请你您要帮我给务必以后一定都]*$`).test(head.trim()));
      if(named)addressed=head;
      else if(/^(?:请|你|您|帮我|给我|以后|一定|务必|要|都|\s)*$/.test(head))addressed='你';
      else continue;
    }
    found=true;ids=namedTargets(store,source,addressed);
    if(!ids.length&&/她|他|它|对方|那个\s*Bot|那个伙伴|\b(?:her|him|them)\b/i.test(addressed)){
      const previous=store.data.peerExchanges.filter(exchange=>exchange.fromBotId===source.botId&&exchange.rootRunId!==source.runId&&exchange.createdAt<source.time&&store.data.bots.some(bot=>bot.id===exchange.toBotId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
      if(previous)ids=[previous.toBotId];
    }
    if(!ids.length&&/你|您|\byou\b/i.test(addressed))ids=hint.length?hint:[source.botId];
    if(!ids.length)ambiguous=true;
    for(const id of ids)targets.add(id);
    const denied=/(?:不要|不用|不必|无需|禁止|不准|别|do not|don't|not to)/i.test(head);
    for(const id of ids){
      if(denied){blocked.add(id);grants.set(id,new Set());continue;}
      if(blocked.has(id))continue;
      const actions=grants.get(id)||new Set<MemoryAction>();
      if(/忘记|删除|移除|forget/i.test(action[0]))actions.add('remove');else{actions.add('add');actions.add('replace');}
      grants.set(id,actions);
    }
    hint=[];
  }
  return found?{targetBotIds:ambiguous?[]:[...targets],actionsByBot:ambiguous?{}:Object.fromEntries([...targets].map(id=>[id,[...(grants.get(id)||[])]]))}:undefined;
}
export function humanRunSource(store:Store,runId:string){return store.humanRunMessage(runId);}
export function peerTaskUserSource(store:Store,botId:string,runId:string,allowCompleted=false){
  const run=store.data.runs.find(item=>item.id===runId&&item.botId===botId);
  if(run?.peerOrigin?.kind!=='peer_task'||!(run.status==='running'||allowCompleted&&run.status==='completed'))return;
  const exchange=store.data.peerExchanges.find(item=>item.id===(run.peerOrigin!.sessionId||run.peerOrigin!.exchangeId));
  if(!exchange||exchange.toBotId!==botId||!(peerPending(exchange.status)||allowCompleted&&exchange.status==='completed'))return;
  const root=store.data.runs.find(item=>item.id===exchange.rootRunId&&item.botId===exchange.rootBotId&&!item.peerOrigin),source=root?humanRunSource(store,root.id):undefined;
  if(!root||!['running','completed'].includes(root.status)||!source||source.content.slice(0,8000)!==exchange.rootRequest)return;
  return source;
}
export function routingOnlyRun(store:Store,runId:string){
  const tools=store.runMessages(runId).filter(message=>message.role==='tool');
  return tools.some(message=>message.tool==='bot_send_message')&&tools.every(message=>['bots_list','bot_send_message','bot_read_messages'].includes(message.tool||''));
}
export function delegatedMemory(store:Store,botId:string,runId:string){
  const run=store.data.runs.find(item=>item.id===runId&&item.botId===botId),origin=run?.peerOrigin;
  if(!origin||origin.kind==='peer_summary'||run?.status!=='running')return;
  const exchange=store.data.peerExchanges.find(item=>item.id===(origin.sessionId||origin.exchangeId));
  if(!exchange||exchange.toBotId!==botId||!peerPending(exchange.status))return;
  const root=store.data.runs.find(item=>item.id===exchange.rootRunId&&item.botId===exchange.rootBotId&&!item.peerOrigin);
  if(!root||!['running','completed'].includes(root.status))return;
  const source=humanRunSource(store,root.id);
  if(!source||source.botId!==root.botId||source.content.slice(0,8000)!==exchange.rootRequest)return;
  const route=memoryRoute(store,source);
  const actions=route?.actionsByBot[botId]||[];
  if(!route?.targetBotIds.includes(botId)||!actions.length)return;
  return {source,actions,exchangeId:exchange.id};
}
export function assertMemoryOwner(store:Store,botId:string,source:ChatMessage,action?:string){
  const human=source.role==='user'?source:source.runId?humanRunSource(store,source.runId):undefined;
  if(!human)return;
  const route=memoryRoute(store,human);if(!route)return;
  if(!route.targetBotIds.includes(botId)){
    const names=route.targetBotIds.map(id=>store.data.bots.find(bot=>bot.id===id)?.name).filter(Boolean).join('、');
    throw new Error(names?`这条记忆属于 ${names}，不能保存到当前 Bot；请由目标 Bot 处理。`:'这条记忆请求的对象尚不明确，不能先保存到当前 Bot。');
  }
  if(action&&!route.actionsByBot[botId]?.includes(action as MemoryAction))throw new Error('这项记忆修改不在用户请求范围内');
}
