import type {BotUpdateInput} from '../../src/shared';
import type {ModelProviders} from './model-providers';
import {atomicJson,type Store} from './store';

export function updateBotProfile(store:Store,providers:ModelProviders,input:BotUpdateInput,beforeModelChange:(botId:string)=>void=()=>{}){
  const bot=store.bot(String(input?.id));
  if(typeof input.name!=='string'||!input.name.trim()||input.name.length>80||typeof input.role!=='string'||input.role.length>4000)throw new Error('无效资料');
  const model=input.model===undefined?bot.model:providers.selection(input.model);
  const modelChanged=bot.model?.providerId!==model?.providerId||bot.model?.model!==model?.model||bot.model?.contextTokens!==model?.contextTokens;
  if(modelChanged)beforeModelChange(bot.id);
  const next={...store.data,bots:store.data.bots.map(item=>item.id===bot.id?{...item,name:input.name.trim(),role:input.role,model}:item)};
  // A rejected model change must not leave a partially updated profile.
  atomicJson(store.file,next);store.data=next;
  return modelChanged;
}
