import {createContext,useMemo,type ReactNode} from 'react';
import type {BotPalette} from './bot-colors';

export const BotAvatarContext=createContext<ReadonlyMap<string,BotPalette>>(new Map());
export function BotAvatarProvider({bots,children}:{bots:readonly (BotPalette&{id:string})[];children:ReactNode}){
  const palettes=useMemo(()=>new Map(bots.map(bot=>[bot.id,bot])),[bots]);
  return <BotAvatarContext.Provider value={palettes}>{children}</BotAvatarContext.Provider>;
}
