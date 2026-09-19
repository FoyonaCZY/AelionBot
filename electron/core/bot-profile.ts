import {peerPending} from '../../src/peer-types';
import {groupPending} from '../../src/group-types';
import {botType} from '../../src/designer-types';
import type {BotUpdateInput} from '../../src/shared';
import {normalizeBotPalette} from '../../src/bot-colors';
import type {ModelProviders} from './model-providers';
import {atomicJson,type Store} from './store';
import {reasoningEffort as cleanReasoning} from '../../src/reasoning';

export function updateBotProfile(store:Store,providers:ModelProviders,input:BotUpdateInput,beforeModelChange:(botId:string)=>void=()=>{}){
  const bot=store.bot(String(input?.id));
  if(typeof input.name!=='string'||!input.name.trim()||input.name.length>80||typeof input.role!=='string'||input.role.length>4000)throw new Error('无效资料');
  const type=botType(input.type===undefined?bot.type:input.type),running=store.data.runs.some(run=>run.botId===bot.id&&run.status==='running');
  const typeChanged=type!==botType(bot.type);
  if(typeChanged){
    if(input.confirmContextReset!==true||input.expectedType!==botType(bot.type))throw Error('切换 Bot 类型会丢失所有上下文，请重新确认');
    if(running||store.data.messages.some(m=>m.botId===bot.id&&m.inputState==='queued')||store.data.peerExchanges.some(e=>(e.fromBotId===bot.id||e.toBotId===bot.id||e.rootBotId===bot.id)&&peerPending(e.status))||store.data.groupDeliveries.some(d=>d.recipientId===bot.id&&groupPending(d.status)))throw Error('请先结束当前任务和待处理协作，再切换 Bot 类型');
  }
  const typeFields={type};
  const palette=input.color!==undefined||input.avatarStyle!==undefined?normalizeBotPalette({color:input.color===undefined?bot.color:input.color,avatarStyle:input.avatarStyle===undefined?bot.avatarStyle:input.avatarStyle}):undefined;
  const model=input.model===undefined?bot.model:providers.selection(input.model);
  const imageModel=input.imageModel===undefined?bot.imageModel:input.imageModel===null?undefined:providers.selection(input.imageModel);
  const reasoningEffort=input.reasoningEffort===undefined?bot.reasoningEffort:cleanReasoning(input.reasoningEffort);
  const modelChanged=bot.model?.providerId!==model?.providerId||bot.model?.model!==model?.model||bot.model?.contextTokens!==model?.contextTokens||reasoningEffort!==bot.reasoningEffort;
  if(modelChanged)beforeModelChange(bot.id);
  const next={...store.data,bots:store.data.bots.map(item=>{
    if(item.id!==bot.id)return item;
    const updated={...item,name:input.name.trim(),role:input.role,model,reasoningEffort,...typeFields,...(input.defaultDesignSystemId!==undefined?{defaultDesignSystemId:input.defaultDesignSystemId}:{}),...(palette?{color:palette.color,avatarStyle:palette.avatarStyle}:{})};
    if(imageModel)updated.imageModel=imageModel;else delete updated.imageModel;
    return updated;
  })};
  // A rejected model change must not leave a partially updated profile.
  if(typeChanged){
    const id=bot.id,resetAt=new Date().toISOString();next.bots=next.bots.map(b=>b.id===id?{...b,memories:[],contextResetAt:resetAt}:b);
    const keys=new Set([id,...Object.keys(next.groupContexts).filter(k=>k.endsWith(':'+id)||k.includes(':reset:'+id+':')),...store.data.groupDeliveries.filter(d=>d.recipientId===id).map(d=>'group:'+d.id)]);
    const peerIds=new Set(store.data.peerExchanges.filter(e=>e.toBotId===id||e.fromBotId===id).flatMap(e=>[e.id,'summary:'+e.id]));
    next.conversations={...next.conversations};delete next.conversations[id];next.peerContexts={...next.peerContexts};for(const key of peerIds){delete next.peerContexts[key];keys.add('peer:'+key);}
    next.groupContexts={...next.groupContexts};next.summaries={...next.summaries};next.contextOffsets={...next.contextOffsets};next.historyVersions={...next.historyVersions};
    for(const key of keys){delete next.groupContexts[key];delete next.summaries[key];delete next.contextOffsets[key];next.historyVersions[key]=(next.historyVersions[key]||0)+1;}
    next.messages=next.messages.filter(m=>m.botId!==id);next.peerMessages=next.peerMessages.filter(m=>m.botId!==id);next.groupRunMessages=next.groupRunMessages.filter(m=>m.botId!==id);
    next.runs=next.runs.filter(r=>r.botId!==id);next.workItems=next.workItems?.filter(w=>w.botId!==id);
    next.peerExchanges=next.peerExchanges.map(e=>e.rootBotId===id?{...e,rootRequest:''}:e);
  }
  store.replaceData(next);
  return modelChanged;
}
