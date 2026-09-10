import type {BotUpdateInput} from '../../src/shared';
import {normalizeBotPalette} from '../../src/bot-colors';
import type {ModelProviders} from './model-providers';
import {atomicJson,type Store} from './store';
import {reasoningEffort as cleanReasoning} from '../../src/reasoning';

export function updateBotProfile(store:Store,providers:ModelProviders,input:BotUpdateInput,beforeModelChange:(botId:string)=>void=()=>{}){
  const bot=store.bot(String(input?.id));
  if(typeof input.name!=='string'||!input.name.trim()||input.name.length>80||typeof input.role!=='string'||input.role.length>4000)throw new Error('无效资料');
  const palette=input.color!==undefined||input.avatarStyle!==undefined?normalizeBotPalette({color:input.color===undefined?bot.color:input.color,avatarStyle:input.avatarStyle===undefined?bot.avatarStyle:input.avatarStyle}):undefined;
  const model=input.model===undefined?bot.model:providers.selection(input.model);
  const reasoningEffort=input.reasoningEffort===undefined?bot.reasoningEffort:cleanReasoning(input.reasoningEffort);
  const modelChanged=bot.model?.supportsImages!==model?.supportsImages||bot.model?.providerId!==model?.providerId||bot.model?.model!==model?.model||bot.model?.contextTokens!==model?.contextTokens||reasoningEffort!==bot.reasoningEffort;
  if(modelChanged)beforeModelChange(bot.id);
  const next={...store.data,bots:store.data.bots.map(item=>item.id===bot.id?{...item,name:input.name.trim(),role:input.role,model,reasoningEffort,...(palette?{color:palette.color,avatarStyle:palette.avatarStyle}:{})}:item)};
  // A rejected model change must not leave a partially updated profile.
  store.replaceData(next);
  return modelChanged;
}
